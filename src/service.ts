// `npm run service`: keeps jelly-mcp running all the time as a macOS login
// service (launchd), so every Claude window shares one always-on server.
//
//   npm run service                  install or update it, start it, point Claude at it
//   npm run service -- --status      is it running, and the last few log lines
//   npm run service -- --restart     restart it
//   npm run service -- --logs        the last 50 log lines
//   npm run service -- --uninstall   stop it and go back to Claude starting jelly-mcp itself
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serviceAccepts, serviceIsUp, serviceUrl } from "./bridge.js";
import { addToClaudeCode, desktopDirect, desktopRelay, direct, ENTRY, updateDesktopConfig } from "./claude.js";
import { ENV_FILE, ROOT } from "./config.js";
import { readEnvFile, setEnvValues } from "./envfile.js";

const LABEL = "com.jelly-mcp";
const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
export const LOG_FILE = path.join(os.homedir(), "Library", "Logs", "jelly-mcp.log");
const domain = () => `gui/${process.getuid?.() ?? 0}`;

export function serviceInstalled(): boolean {
  return fs.existsSync(PLIST);
}

/** The port and token from .env, making a token the first time. */
function serviceSettings(): { port: number; token: string } {
  const env = readEnvFile(ENV_FILE);
  let token = env.get("JELLY_MCP_TOKEN");
  if (!token) {
    token = randomBytes(32).toString("base64url");
    setEnvValues(ENV_FILE, { JELLY_MCP_TOKEN: token });
  }
  return { port: Number(env.get("JELLY_MCP_PORT") || 4646), token };
}

export function plist(o: { node: string; entry: string; root: string; log: string }): string {
  const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${x(o.node)}</string>
    <string>${x(o.entry)}</string>
    <string>--http</string>
  </array>
  <key>WorkingDirectory</key><string>${x(o.root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${x(o.log)}</string>
  <key>StandardErrorPath</key><string>${x(o.log)}</string>
</dict>
</plist>
`;
}

function launchctl(...args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function jobState(): { loaded: boolean; pid: number | null; lastExit: string | null } {
  const { ok, out } = launchctl("print", `${domain()}/${LABEL}`);
  if (!ok) return { loaded: false, pid: null, lastExit: null };
  return {
    loaded: true,
    pid: Number(/^\s*pid = (\d+)/m.exec(out)?.[1]) || null,
    lastExit: /last exit code = (.+)$/m.exec(out)?.[1]?.trim() ?? null,
  };
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer().once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if (await check()) return true;
  return false;
}

/** Installs (or reinstalls, on the current build) the service, starts it, and points Claude at it. */
export async function installService(o: { code?: boolean; desktop?: boolean } = {}): Promise<string[]> {
  if (process.platform !== "darwin") throw new Error("npm run service only knows macOS (launchd) so far");
  if (!fs.existsSync(ENTRY)) throw new Error(`${ENTRY} is missing; run npm run build first`);
  const { port, token } = serviceSettings();

  if (jobState().loaded) {
    launchctl("bootout", `${domain()}/${LABEL}`);
    await waitFor(async () => !jobState().loaded && (await portFree(port)), 10_000);
  }
  if (!(await portFree(port))) {
    throw new Error(`Something else is using port ${port}. Set JELLY_MCP_PORT in .env to a free port and run this again.`);
  }

  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(PLIST, plist({ node: process.execPath, entry: ENTRY, root: ROOT, log: LOG_FILE }));
  let started = launchctl("bootstrap", domain(), PLIST);
  // launchd sometimes needs a moment after a bootout before it takes the job back.
  for (let i = 0; !started.ok && i < 5; i++) {
    await sleep(700);
    started = launchctl("bootstrap", domain(), PLIST);
  }
  if (!started.ok) throw new Error(`launchctl couldn't start the service: ${started.out.trim()}`);
  if (!(await waitFor(() => serviceIsUp(port), 15_000))) {
    throw new Error(`The service didn't come up on port ${port}. The log says:\n${tail(10)}`);
  }
  if (!(await serviceAccepts(port, token))) throw new Error("The service is up but turned away its own token; check .env");

  const lines = [`✓ Service running on ${serviceUrl(port)} (starts at login, restarts if it stops). Log: ${LOG_FILE}`];
  if (o.code !== false) {
    lines.push(addToClaudeCode({ type: "http", url: serviceUrl(port), headers: { Authorization: `Bearer ${token}` } }));
  }
  if (o.desktop !== false) lines.push(updateDesktopConfig(desktopRelay()));
  return lines;
}

export function uninstallService(): string[] {
  const lines: string[] = [];
  if (jobState().loaded) launchctl("bootout", `${domain()}/${LABEL}`);
  if (fs.existsSync(PLIST)) {
    fs.rmSync(PLIST);
    lines.push("✓ Service stopped and removed.");
  } else lines.push("- The service wasn't installed.");
  // Back to Claude starting jelly-mcp itself.
  lines.push(addToClaudeCode(direct()), updateDesktopConfig(desktopDirect()));
  return lines;
}

export async function serviceStatus(): Promise<string[]> {
  if (!serviceInstalled()) return ["Not installed: Claude starts jelly-mcp by itself. Run npm run service to keep it running all the time."];
  const { port } = serviceSettings();
  const job = jobState();
  const up = await serviceIsUp(port);
  return [
    `${up ? "✓ Running" : "✗ Not answering"} on ${serviceUrl(port)}${job.pid ? ` (pid ${job.pid})` : ""}${job.loaded ? "" : " (not loaded in launchd)"}${!up && job.lastExit ? `, last exit: ${job.lastExit}` : ""}`,
    `Log: ${LOG_FILE}`,
    tail(5),
  ];
}

function tail(n: number): string {
  if (!fs.existsSync(LOG_FILE)) return "(no log yet)";
  return fs.readFileSync(LOG_FILE, "utf8").trimEnd().split("\n").slice(-n).join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const say = (lines: string[] | string): void => {
    process.stdout.write(`${([] as string[]).concat(lines).join("\n")}\n`);
  };
  if (args.includes("--status")) return say(await serviceStatus());
  if (args.includes("--logs")) return say(tail(50));
  if (args.includes("--uninstall")) {
    say(uninstallService());
    return say("Start a new Claude Code session (and restart Claude Desktop) to pick up the change.");
  }
  if (args.includes("--restart")) {
    if (!serviceInstalled()) return say("Not installed. Run npm run service first.");
    launchctl("kickstart", "-k", `${domain()}/${LABEL}`);
    const { port } = serviceSettings();
    return say((await waitFor(() => serviceIsUp(port), 15_000)) ? "✓ Restarted." : `✗ Didn't come back up. Log:\n${tail(10)}`);
  }
  say(await installService());
  say("Start a new Claude Code session (and restart Claude Desktop once) to use it.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
