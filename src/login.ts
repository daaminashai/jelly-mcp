// Getting your Jelly login (and optionally a Marmalade key) into .env, for
// `npm run setup` and `npm run login`. Nothing secret is ever printed.
import { execFileSync } from "node:child_process";
import readline from "node:readline/promises";
import { Writable } from "node:stream";
import { ENV_FILE } from "./config.js";
import { readEnvFile, setEnvValues } from "./envfile.js";
import { JellyClient } from "./jelly/client.js";
import { parseHtml, parseIdentity, type Identity } from "./jelly/pages.js";
import { MarmaladeClient } from "./marmalade.js";
import { errorMessage, registerSecret } from "./redact.js";

/** The cookies that keep you logged in to Jelly; analytics cookies are dropped. */
const LOGIN_COOKIES = ["current_user_session_token", "_jelly_session"];
const JELLY = "https://app.letsjelly.com";
const MARMALADE = "https://marmalade.hackclub.com";

/** Pulls the login cookies out of a "Copy as cURL" command, or a bare Cookie header. */
export function cookieHeaderFrom(input: string): string {
  const text = input.trim();
  const fromHeader = /(?:-H|--header)\s+(['"])cookie:\s*([^'"]*)\1/i.exec(text)?.[2];
  const fromFlag = /(?:-b|--cookie)\s+(['"])([^'"]*)\1/.exec(text)?.[2];
  const header = fromHeader ?? fromFlag ?? text.replace(/^cookie:\s*/i, "");
  return header
    .split(";")
    .map((c) => c.trim())
    .filter((c) => LOGIN_COOKIES.includes(c.split("=")[0]!))
    .join("; ");
}

/** Logs in with the cookie and finds your team from where Jelly sends you (/hack-club/inbox). */
export async function checkJellyLogin(
  cookie: string,
  o: { baseUrl?: string; team?: string; fetch?: typeof fetch } = {},
): Promise<{ me: Identity; team: string }> {
  registerSecret(cookie);
  const client = new JellyClient({ baseUrl: o.baseUrl ?? JELLY, team: o.team ?? "", cookie, timezone: "UTC", fetch: o.fetch });
  const home = await client.get(o.team ? `/${o.team}/inbox` : "/");
  const team = o.team ?? new URL(home.url).pathname.split("/").filter(Boolean)[0];
  const me = parseIdentity(parseHtml(home.body));
  if (!team || !me) throw new Error("Jelly didn't show your inbox with that login");
  return { me, team };
}

/**
 * Asks questions on the terminal; `hidden` answers aren't echoed. Every line is
 * queued as it arrives, because a pasted multi-line command arrives all at once.
 */
export class Prompt {
  private muted = false;
  private readonly rl: readline.Interface;
  private readonly lines: string[] = [];
  private waiting: ((line: string | null) => void) | null = null;
  private closed = false;

  constructor() {
    const output = new Writable({
      write: (chunk, encoding, done) => {
        if (!this.muted) process.stdout.write(chunk, encoding);
        done();
      },
    });
    this.rl = readline.createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
    this.rl.on("line", (line) => {
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        resolve(line);
      } else this.lines.push(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      this.waiting?.(null);
      this.waiting = null;
    });
  }

  /** The next line typed or pasted, or null once input has ended. */
  private next(): Promise<string | null> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => (this.waiting = resolve));
  }

  async ask(question: string, o: { hidden?: boolean } = {}): Promise<string> {
    process.stdout.write(question);
    this.muted = Boolean(o.hidden);
    try {
      return ((await this.next()) ?? "").trim();
    } finally {
      if (this.muted || !process.stdin.isTTY) process.stdout.write("\n");
      this.muted = false;
    }
  }

  /** Lines until an empty one, for pasting a multi-line cURL command. Not echoed. */
  async paste(question: string): Promise<string> {
    process.stdout.write(question);
    const lines: string[] = [];
    this.muted = true;
    try {
      for (let line = await this.next(); line !== null && line.trim() !== ""; line = await this.next()) lines.push(line);
    } finally {
      this.muted = false;
    }
    return lines.join("\n");
  }

  close(): void {
    this.rl.close();
  }
}

export function readClipboard(): string | null {
  const commands: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["pbpaste", []]]
      : process.platform === "win32"
        ? [["powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]]]
        : [["wl-paste", ["--no-newline"]], ["xclip", ["-selection", "clipboard", "-o"]], ["xsel", ["--clipboard", "--output"]]];
  for (const [cmd, args] of commands) {
    try {
      return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // try the next one
    }
  }
  return null;
}

const say = (line = "") => process.stdout.write(`${line}\n`);

/**
 * Makes sure .env holds a working Jelly login, asking for one if it doesn't (or
 * always, with `force`). Returns who you are, or null if you skipped it.
 */
export async function ensureJellyLogin(prompt: Prompt, o: { force?: boolean; from?: string } = {}): Promise<Identity | null> {
  const env = readEnvFile(ENV_FILE);
  const saved = env.get("JELLY_SESSION_COOKIE");
  const baseUrl = env.get("JELLY_BASE_URL") || JELLY;
  const team = env.get("JELLY_TEAM") || undefined;
  if (saved && !o.force) {
    try {
      const { me, team: found } = await checkJellyLogin(saved, { baseUrl, team });
      say(`✓ Jelly: logged in as ${me.name} <${me.email}> (team ${found})`);
      return me;
    } catch (err) {
      say(`✗ Jelly: the saved login doesn't work any more (${errorMessage(err)})`);
    }
  }

  say("");
  say("Log in to Jelly:");
  say("  1. Open https://app.letsjelly.com in Chrome, logged in.");
  say("  2. Open DevTools (Cmd+Option+I, or Ctrl+Shift+I), go to Network, and reload the page.");
  say("  3. Right-click the first request → Copy → Copy as cURL.");
  for (let attempt = 0; attempt < 3; attempt++) {
    let text = o.from ?? null;
    if (text === null) {
      const answer = await prompt.ask("Then press Enter (or type skip): ");
      if (/^skip$/i.test(answer)) return null;
      text = readClipboard();
      if (!text || !cookieHeaderFrom(text)) {
        text = await prompt.paste("Couldn't read it from the clipboard. Paste it here (it won't show), then press Enter twice:\n");
      }
    }
    const cookie = cookieHeaderFrom(text);
    if (!cookie) {
      say("That has no Jelly login cookies in it. Copy the request from app.letsjelly.com, not another site.");
      if (o.from) return null;
      continue;
    }
    try {
      const found = await checkJellyLogin(cookie, { baseUrl, team });
      setEnvValues(ENV_FILE, { JELLY_SESSION_COOKIE: cookie, ...(team ? {} : { JELLY_TEAM: found.team }) });
      say(`✓ Jelly: logged in as ${found.me.name} <${found.me.email}> (team ${found.team}). Saved to .env.`);
      return found.me;
    } catch (err) {
      say(`✗ That login didn't work: ${errorMessage(err)}`);
      if (o.from) return null;
    }
  }
  return null;
}

/** Offers to add a Marmalade key (optional) and picks a default mailbox. */
export async function ensureMarmalade(prompt: Prompt): Promise<void> {
  const env = readEnvFile(ENV_FILE);
  const baseUrl = env.get("MARMALADE_BASE_URL") || MARMALADE;
  let key = env.get("MARMALADE_API_KEY");
  if (key) {
    registerSecret(key);
    try {
      const mailboxes = await new MarmaladeClient({ baseUrl, apiKey: key }).listMailboxes();
      say(`✓ Marmalade: can read ${mailboxes.map((m) => m.jellyMailbox.jellyMailboxId).join(", ") || "no mailboxes"}`);
      return;
    } catch (err) {
      say(`✗ Marmalade: the saved key doesn't work (${errorMessage(err)})`);
    }
  }

  say("");
  say(`Marmalade is optional: it adds date and status queries and the team list. Get a key at ${baseUrl}/keys`);
  key = await prompt.ask("Marmalade API key (it won't show; press Enter to skip): ", { hidden: true });
  if (!key) {
    say("- Marmalade: skipped. Run npm run setup again any time to add it.");
    return;
  }
  registerSecret(key);
  try {
    const mailboxes = await new MarmaladeClient({ baseUrl, apiKey: key }).listMailboxes();
    const ids = mailboxes.map((m) => m.jellyMailbox.jellyMailboxId);
    let mailbox = ids.length === 1 ? ids[0]! : "";
    if (ids.length > 1) {
      const answer = await prompt.ask(`Which mailbox do you use most? (${ids.join(", ")}) [${ids[0]}]: `);
      mailbox = ids.find((id) => id.toLowerCase() === answer.toLowerCase()) ?? ids[0]!;
    }
    setEnvValues(ENV_FILE, { MARMALADE_API_KEY: key, ...(mailbox ? { MARMALADE_MAILBOX: mailbox } : {}) });
    say(`✓ Marmalade: can read ${ids.join(", ") || "no mailboxes"}. Saved to .env.`);
  } catch (err) {
    say(`✗ Marmalade: that key didn't work (${errorMessage(err)}). Skipped.`);
  }
}
