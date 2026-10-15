// Talks to Jelly's web app with your session cookie, the way the browser does:
// GET pages, then submit the same forms the buttons submit, with the page's CSRF
// token. (The cookie jar and error rules come from pudding's jelly.ts.)
import { redact } from "../redact.js";

export class JellyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JellyError";
  }
}

/** The login is dead (logged out, expired, or rejected). */
export class JellySessionError extends JellyError {
  constructor(message: string) {
    super(`${message}. Your Jelly login has expired or was rejected: run \`npm run cookie\` in jelly-mcp to reconnect.`);
    this.name = "JellySessionError";
  }
}

/** A send failed. `maybeSent` means the email may have gone out anyway and must not be retried blindly. */
export class JellySendError extends JellyError {
  constructor(
    message: string,
    readonly maybeSent: boolean,
    status?: number,
  ) {
    super(message, status);
    this.name = "JellySendError";
  }
}

/** Keeps the cookie header current: Jelly rotates `_jelly_session` on every response. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  constructor(header: string) {
    for (const part of header.split(";")) {
      const idx = part.indexOf("=");
      if (idx > 0) this.cookies.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  absorb(setCookies: string[]): void {
    for (const line of setCookies) {
      const [pair = "", ...attrs] = line.split(";");
      const idx = pair.indexOf("=");
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || pair.slice(idx + 1).trim() === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, pair.slice(idx + 1).trim());
    }
  }
}

const LOGIN_PAGE = /<input[^>]+type="password"/i;
const LOGIN_PATH = /\/(login|sign_in|signin|session)(\/|\?|$)/i;

export interface JellyClientOptions {
  baseUrl: string;
  team: string;
  cookie: string;
  timezone: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type Fields = Array<[string, string]>;

export interface SubmitOptions {
  csrf: string;
  /** Sent as a real HTTP method; patch/delete forms usually POST with `_method` in the fields instead. */
  method?: "POST" | "PUT";
  frame?: string;
  referer?: string;
  accept?: string;
  /** The request may send an email: any failure after it leaves could mean it went out. */
  sends?: boolean;
}

export interface SubmitResult {
  status: number;
  /** Where Jelly redirected to, if it did. */
  location: string | null;
  body: string;
}

export class JellyClient {
  readonly baseUrl: string;
  readonly team: string;
  readonly timezone: string;
  private readonly jar: CookieJar;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: JellyClientOptions) {
    this.baseUrl = o.baseUrl;
    this.team = o.team;
    this.timezone = o.timezone;
    this.jar = new CookieJar(o.cookie);
    this.fetchImpl = o.fetch ?? fetch;
  }

  /** "/inbox" -> "/hack-club/inbox" */
  teamPath(path: string): string {
    return `/${this.team}${path}`;
  }

  conversationPath(ref: string): string {
    return this.teamPath(`/conversations/${encodeURIComponent(ref)}`);
  }

  absolute(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }

  /** GETs a page, following Jelly's own redirects (e.g. a numeric id to the conversation's slug). */
  async get(path: string, accept = "text/html"): Promise<{ body: string; url: string }> {
    let url = this.absolute(path);
    for (let hop = 0; hop < 5; hop++) {
      const res = await this.request("GET", url, { accept });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) throw new JellyError(`Jelly redirected ${new URL(url).pathname} nowhere`, res.status);
        const next = new URL(location, url);
        if (LOGIN_PATH.test(next.pathname)) throw new JellySessionError(`Jelly sent ${new URL(url).pathname} to its login page`);
        if (next.origin !== new URL(this.baseUrl).origin) throw new JellyError(`Jelly redirected to another site (${next.origin})`);
        url = next.toString();
        continue;
      }
      const body = await res.text();
      if (accept.includes("html") && LOGIN_PAGE.test(body)) throw new JellySessionError("Jelly showed its sign-in page");
      return { body, url };
    }
    throw new JellyError(`Too many redirects for ${path}`);
  }

  /** Submits a form. Patch/delete go as POST with `_method` among the fields, as Rails forms do. */
  async submit(path: string, fields: Fields, o: SubmitOptions): Promise<SubmitResult> {
    const url = this.absolute(path);
    const body = new URLSearchParams(fields);
    if (!body.has("authenticity_token")) body.set("authenticity_token", o.csrf);
    let res: Response;
    try {
      res = await this.request(o.method ?? "POST", url, {
        accept: o.accept ?? "text/vnd.turbo-stream.html, text/html, application/xhtml+xml",
        csrf: o.csrf,
        frame: o.frame,
        referer: o.referer,
        body,
      });
    } catch (err) {
      if (!o.sends || err instanceof JellySessionError) throw err;
      throw new JellySendError(`Couldn't tell whether Jelly sent it: ${errorText(err)}`, true);
    }
    const location = res.headers.get("location");
    if (location && LOGIN_PATH.test(new URL(location, url).pathname)) {
      throw new JellySessionError(`Jelly sent ${new URL(url).pathname} to its login page`);
    }
    const text = await res.text().catch(() => "");
    if (res.status >= 400) {
      const message = `Jelly returned ${res.status} for ${new URL(url).pathname}: ${redact(squishBody(text))}`;
      if (res.status === 401) throw new JellySessionError(`Jelly returned 401 for ${new URL(url).pathname}`);
      // A 5xx after a send may still have sent; a clear 4xx means Jelly didn't take it.
      if (o.sends) throw new JellySendError(message, res.status >= 500, res.status);
      throw new JellyError(message, res.status);
    }
    if (!location && LOGIN_PAGE.test(text)) throw new JellySessionError("Jelly showed its sign-in page");
    return { status: res.status, location: location ? new URL(location, url).toString() : null, body: text };
  }

  private async request(
    method: "GET" | "POST" | "PUT",
    url: string,
    o: { accept: string; csrf?: string; frame?: string; referer?: string; body?: URLSearchParams },
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: o.accept, cookie: this.jar.header() };
    if (o.body) headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
    if (o.csrf) headers["x-csrf-token"] = o.csrf;
    if (o.frame) headers["turbo-frame"] = o.frame;
    if (o.referer) headers.referer = this.absolute(o.referer);
    if (method !== "GET") headers.origin = new URL(this.baseUrl).origin;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: o.body?.toString(),
        redirect: "manual",
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new JellyError(`Couldn't reach Jelly: ${errorText(err)}`);
    }
    this.jar.absorb(res.headers.getSetCookie?.() ?? []);
    if (method === "GET" && res.status >= 400) {
      const text = await res.text().catch(() => "");
      if (res.status === 401) throw new JellySessionError(`Jelly returned 401 for ${new URL(url).pathname}`);
      if (res.status === 404) throw new JellyError(`Not found in Jelly: ${new URL(url).pathname}`, 404);
      throw new JellyError(`Jelly returned ${res.status} for ${new URL(url).pathname}: ${redact(squishBody(text))}`, res.status);
    }
    return res;
  }
}

function squishBody(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

function errorText(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}
