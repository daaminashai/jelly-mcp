// Adding jelly-mcp to Claude Code (user scope) and Claude Desktop, either as a
// program Claude starts itself, or pointing at the always-on service.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./config.js";

export const NAME = "jelly";
export const ENTRY = path.join(ROOT, "dist", "index.js");

/** How Claude reaches the server: started by Claude (stdio) or the service's URL (http). */
export type ClaudeCodeServer =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { type: "http"; url: string; headers: Record<string, string> };

export const direct = (): ClaudeCodeServer => ({ type: "stdio", command: process.execPath, args: [ENTRY], env: {} });
export const desktopDirect = () => ({ command: process.execPath, args: [ENTRY] });
export const desktopRelay = () => ({ command: process.execPath, args: [ENTRY, "--bridge"] });

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

export function addToClaudeCode(server: ClaudeCodeServer = direct()): string {
  const cli = claudeCli();
  if (cli) {
    try {
      execFileSync(cli, ["mcp", "remove", NAME, "-s", "user"], { stdio: "ignore" });
    } catch {
      // wasn't there
    }
    execFileSync(cli, ["mcp", "add-json", NAME, JSON.stringify(server), "-s", "user"], { stdio: "ignore" });
    return `✓ Claude Code: added "${NAME}" for all your projects${server.type === "http" ? `, using the service at ${server.url}` : ""}.`;
  }
  const file = path.join(os.homedir(), ".claude.json");
  editJson(file, (data) => {
    data.mcpServers = { ...(data.mcpServers as object | undefined), [NAME]: server };
  });
  return `✓ Claude Code: added "${NAME}" to ${file}${server.type === "http" ? `, using the service at ${server.url}` : ""}.`;
}

export function removeFromClaudeCode(): string {
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

export function updateDesktopConfig(server: { command: string; args: string[] } | null): string {
  const file = desktopConfigFile();
  if (!fs.existsSync(path.dirname(file))) return "- Claude Desktop: not installed here, skipped.";
  editJson(file, (data) => {
    const servers = { ...(data.mcpServers as Record<string, unknown> | undefined) };
    if (server) servers[NAME] = server;
    else delete servers[NAME];
    data.mcpServers = servers;
  });
  if (!server) return `✓ Claude Desktop: removed "${NAME}".`;
  return `✓ Claude Desktop: added "${NAME}"${server.args.includes("--bridge") ? " (relaying to the service)" : ""} to ${file}.`;
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

