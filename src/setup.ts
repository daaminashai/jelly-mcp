// `npm run setup`: walks you through logging in to Jelly (and optionally
// Marmalade), then adds this server to Claude Code and Claude Desktop.
//
//   npm run login                               log in to Jelly again (when it expires)
//   npm run setup -- --no-desktop | --no-code   skip one of the two apps
//   npm run setup -- --uninstall                remove it from both
//   npm run service                             keep it running all the time instead (see service.ts)
//   npm run setup -- --import ../pudding/.env   copy the Jelly login and Marmalade key from another .env
import fs from "node:fs";
import path from "node:path";
import { addToClaudeCode, ENTRY, removeFromClaudeCode, updateDesktopConfig } from "./claude.js";
import { ENV_FILE, ROOT } from "./config.js";
import { readEnvFile, setEnvValues } from "./envfile.js";
import { ensureJellyLogin, ensureMarmalade, Prompt } from "./login.js";
import { installService, serviceInstalled } from "./service.js";

/** Settings worth copying from another project's .env (pudding uses MAILBOX_ID for the mailbox). */
const IMPORTABLE: Record<string, string> = {
  JELLY_SESSION_COOKIE: "JELLY_SESSION_COOKIE",
  JELLY_BASE_URL: "JELLY_BASE_URL",
  JELLY_TEAM: "JELLY_TEAM",
  JELLY_TIMEZONE: "JELLY_TIMEZONE",
  MARMALADE_BASE_URL: "MARMALADE_BASE_URL",
  MARMALADE_API_KEY: "MARMALADE_API_KEY",
  MAILBOX_ID: "MARMALADE_MAILBOX",
  MARMALADE_MAILBOX: "MARMALADE_MAILBOX",
};

const say = (line = "") => process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const doCode = !args.includes("--no-code");
  const doDesktop = !args.includes("--no-desktop");

  if (args.includes("--uninstall")) {
    if (serviceInstalled()) say("The always-on service is still installed: run npm run service -- --uninstall to remove it too.");
    if (doCode) say(removeFromClaudeCode());
    if (doDesktop) say(updateDesktopConfig(null));
    return;
  }

  if (!fs.existsSync(ENV_FILE)) {
    fs.copyFileSync(path.join(ROOT, ".env.example"), ENV_FILE);
    fs.chmodSync(ENV_FILE, 0o600);
  }
  const importFrom = args.includes("--import") ? args[args.indexOf("--import") + 1] : undefined;
  if (args.includes("--import")) {
    if (!importFrom || !fs.existsSync(importFrom)) throw new Error(`--import needs a .env file (got ${importFrom ?? "nothing"})`);
    const source = readEnvFile(path.resolve(importFrom));
    const copied: Record<string, string> = {};
    for (const [from, to] of Object.entries(IMPORTABLE)) {
      const value = source.get(from);
      if (value) copied[to] = value;
    }
    setEnvValues(ENV_FILE, copied);
    say(`Copied ${Object.keys(copied).join(", ") || "nothing"} from ${importFrom} (values not shown).`);
  }

  const prompt = new Prompt();
  try {
    if (args.includes("--login")) {
      const file = args.find((a) => !a.startsWith("--"));
      const me = await ensureJellyLogin(prompt, { force: true, from: file ? fs.readFileSync(file, "utf8") : undefined });
      if (me) say("jelly-mcp picks up the new login by itself the next time Claude uses it. No restart needed.");
      process.exitCode = me ? 0 : 1;
      return;
    }

    const me = await ensureJellyLogin(prompt);
    await ensureMarmalade(prompt);
    const env = readEnvFile(ENV_FILE);
    if (!env.get("JELLY_SESSION_COOKIE") && !env.get("MARMALADE_API_KEY")) {
      say("\nNothing to connect with yet, so Claude wasn't set up. Run npm run setup again when you have your Jelly login.");
      process.exitCode = 1;
      return;
    }
    if (!me) say("- Jelly: no login, so only the Marmalade tools will work. Run npm run login to add it.");
  } finally {
    prompt.close();
  }

  if (!fs.existsSync(ENTRY)) throw new Error(`${ENTRY} is missing; run npm run build first`);
  if (!doCode && !doDesktop) return;
  say();
  if (serviceInstalled()) {
    // Restart the always-on service on the code just built, and keep Claude pointed at it.
    for (const line of await installService({ code: doCode, desktop: doDesktop })) say(line);
  } else {
    if (doCode) say(addToClaudeCode());
    if (doDesktop) say(updateDesktopConfig({ command: process.execPath, args: [ENTRY] }));
  }
  say();
  say("Done! Restart Claude Desktop or start a new Claude Code session, then ask Claude about your Jelly inbox.");
  say(`(Claude runs it from ${ROOT}; if you move this folder, run npm run setup again.)`);
}

main().catch((err) => {
  process.stderr.write(`setup failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
