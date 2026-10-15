// `npm run cookie`: saves your Jelly login to .env as JELLY_SESSION_COOKIE.
//
// In Chrome, open app.letsjelly.com while logged in, then DevTools → Network,
// right-click any request to app.letsjelly.com → Copy → Copy as cURL. Run this
// with that on the clipboard (macOS), or pass a file holding the cURL command or
// the raw Cookie header. Only the two login cookies are kept, the login is
// checked against Jelly, and nothing secret is printed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_FILE, loadConfig, loadEnvFile } from "./config.js";
import { setEnvValues } from "./envfile.js";
import { JellyClient } from "./jelly/client.js";
import { parseHtml, parseIdentity } from "./jelly/pages.js";
import { errorMessage, registerSecret } from "./redact.js";

/** The cookies that keep you logged in to Jelly; analytics cookies are dropped. */
const LOGIN_COOKIES = ["current_user_session_token", "_jelly_session"];

/** Pulls the Cookie header out of a "Copy as cURL" command, or takes a bare header as is. */
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

async function main(): Promise<void> {
  const file = process.argv[2];
  const raw = file ? fs.readFileSync(file, "utf8") : clipboard();
  const cookie = cookieHeaderFrom(raw);
  registerSecret(cookie);
  const missing = LOGIN_COOKIES.filter((name) => !cookie.includes(`${name}=`));
  if (missing.length === LOGIN_COOKIES.length) {
    throw new Error(
      "No Jelly login cookies found. In Chrome DevTools → Network, right-click a request to app.letsjelly.com → Copy → Copy as cURL, then run this again.",
    );
  }

  loadEnvFile();
  const config = (() => {
    try {
      return loadConfig({ ...process.env, JELLY_SESSION_COOKIE: cookie });
    } catch {
      return null;
    }
  })();
  const client = new JellyClient({
    baseUrl: config?.jelly.baseUrl ?? "https://app.letsjelly.com",
    team: config?.jelly.team ?? "hack-club",
    timezone: config?.jelly.timezone ?? "UTC",
    cookie,
  });
  const { body } = await client.get(client.teamPath("/inbox"));
  const me = parseIdentity(parseHtml(body));
  setEnvValues(ENV_FILE, { JELLY_SESSION_COOKIE: cookie });
  process.stdout.write(
    `Logged in to Jelly as ${me ? `${me.name} <${me.email}>` : "(couldn't read your name)"}. Saved to ${ENV_FILE} (not shown).\n` +
      "Restart Claude (or reconnect the jelly MCP server) to use it.\n",
  );
}

function clipboard(): string {
  try {
    return execFileSync("pbpaste", { encoding: "utf8" });
  } catch {
    throw new Error("Couldn't read the clipboard. Save the cURL command to a file and run: npm run cookie -- <file>");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${errorMessage(err)}\n`);
    process.exit(1);
  });
}
