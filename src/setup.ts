// `npm run setup`: builds, checks your logins, and adds this server to Claude
// Code (user scope) and Claude Desktop, pointing at this folder.
//
//   npm run setup -- --import ../pudding/.env   copy Marmalade/Jelly settings from another .env
//   npm run setup -- --no-desktop | --no-code   skip one of the two apps
//   npm run setup -- --uninstall                remove it from both
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runChecks } from "./check.js";
import { ENV_FILE, ROOT } from "./config.js";
import { readEnvFile, setEnvValues } from "./envfile.js";

const NAME = "jelly";
const ENTRY = path.join(ROOT, "dist", "index.js");

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
  const uninstall = args.includes("--uninstall");
  const doCode = !args.includes("--no-code");
  const doDesktop = !args.includes("--no-desktop");

  if (uninstall) {
    if (doCode) say(removeFromClaudeCode());
    if (doDesktop) say(updateDesktopConfig(null));
    return;
  }

  const importFrom = args[args.indexOf("--import") + 1];
  if (args.includes("--import")) {
    if (!importFrom || !fs.existsSync(importFrom)) throw new Error(`--import needs a .env file (got ${importFrom ?? "nothing"})`);
    const source = readEnvFile(path.resolve(importFrom));
    const copied: Record<string, string> = {};
    for (const [from, to] of Object.entries(IMPORTABLE)) {
      const value = source.get(from);
      if (value) copied[to] = value;
    }
    setEnvValues(ENV_FILE, copied);
    say(`Copied ${Object.keys(copied).join(", ") || "nothing"} from ${importFrom} into .env (values not shown).`);
  } else if (!fs.existsSync(ENV_FILE)) {
    fs.copyFileSync(path.join(ROOT, ".env.example"), ENV_FILE);
    fs.chmodSync(ENV_FILE, 0o600);
    say(`Created ${ENV_FILE} from .env.example.`);
  }

  say("Checking connections…");
  const { ok, lines } = await runChecks();
  for (const line of lines) say(`  ${line}`);
  if (!ok) say("Fix the ✗ lines above (see the README); registering anyway so it works once they're fixed.");

  if (!fs.existsSync(ENTRY)) throw new Error(`${ENTRY} is missing; run npm run build first`);
  if (!doCode && !doDesktop) return;
  say();
  if (doCode) say(addToClaudeCode());
  if (doDesktop) say(updateDesktopConfig({ command: process.execPath, args: [ENTRY] }));
  say();
  say(`Registered ${ENTRY}. If you move or delete this folder, run npm run setup again from the new one.`);
  say("Restart Claude Desktop, or start a new Claude Code session, and the jelly tools will be there.");
}

// ---------- Claude Code ----------

/** `claude` on PATH, or else the copy the Claude desktop app keeps for its Code tab. */
function claudeCli(): string | null {
  const bundled = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code");
  const candidates = ["claude"];
  if (fs.existsSync(bundled)) {
    const versions = fs.readdirSync(bundled).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
    for (const version of versions) {
      for (const build of fs.readdirSync(path.join(bundled, version)).filter((b) => !b.startsWith("."))) {
        candidates.push(path.join(bundled, version, build, "claude.app", "Contents", "MacOS", "claude"));
      }
    }
  }
  for (const cli of candidates) {
    try {
      execFileSync(cli, ["--version"], { stdio: "ignore" });
      return cli;
    } catch {
      // try the next one
    }
  }
  return null;
}

function addToClaudeCode(): string {
  const server = { type: "stdio", command: process.execPath, args: [ENTRY], env: {} };
  const cli = claudeCli();
  if (cli) {
    try {
      execFileSync(cli, ["mcp", "remove", NAME, "-s", "user"], { stdio: "ignore" });
    } catch {
      // wasn't there
    }
    execFileSync(cli, ["mcp", "add-json", NAME, JSON.stringify(server), "-s", "user"], { stdio: "ignore" });
    return `✓ Claude Code: added "${NAME}" for all your projects (claude mcp add-json, user scope).`;
  }
  const file = path.join(os.homedir(), ".claude.json");
  editJson(file, (data) => {
    data.mcpServers = { ...(data.mcpServers as object | undefined), [NAME]: server };
  });
  return `✓ Claude Code: added "${NAME}" to ${file} (user scope).`;
}

function removeFromClaudeCode(): string {
  const cli = claudeCli();
  if (cli) {
    try {
      execFileSync(cli, ["mcp", "remove", NAME, "-s", "user"], { stdio: "ignore" });
      return `✓ Claude Code: removed "${NAME}".`;
    } catch {
      return `- Claude Code: "${NAME}" wasn't added.`;
    }
  }
  const file = path.join(os.homedir(), ".claude.json");
  if (!fs.existsSync(file)) return "- Claude Code: no ~/.claude.json.";
  editJson(file, (data) => {
    const servers = data.mcpServers as Record<string, unknown> | undefined;
    if (servers) delete servers[NAME];
  });
  return `✓ Claude Code: removed "${NAME}" from ${file}.`;
}

// ---------- Claude Desktop ----------

function desktopConfigFile(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? os.homedir(), "Claude", "claude_desktop_config.json");
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function updateDesktopConfig(server: { command: string; args: string[] } | null): string {
  const file = desktopConfigFile();
  if (!fs.existsSync(path.dirname(file))) return "- Claude Desktop: not installed here, skipped.";
  editJson(file, (data) => {
    const servers = { ...(data.mcpServers as Record<string, unknown> | undefined) };
    if (server) servers[NAME] = server;
    else delete servers[NAME];
    data.mcpServers = servers;
  });
  return server ? `✓ Claude Desktop: added "${NAME}" to ${file}.` : `✓ Claude Desktop: removed "${NAME}".`;
}

/** Read-modify-write with a backup next to the file, written atomically. */
function editJson(file: string, edit: (data: Record<string, unknown>) => void): void {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const data = existing.trim() ? (JSON.parse(existing) as Record<string, unknown>) : {};
  if (existing) fs.writeFileSync(`${file}.jelly-mcp-backup`, existing, { mode: 0o600 });
  edit(data);
  const tmp = `${file}.jelly-mcp-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: fs.existsSync(file) ? fs.statSync(file).mode : 0o600 });
  fs.renameSync(tmp, file);
}

main().catch((err) => {
  process.stderr.write(`setup failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
