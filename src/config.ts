import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";
import { registerSecret } from "./redact.js";

/** The repo root. MCP clients start us from anywhere, so .env is found from here, not the cwd. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENV_FILE = path.join(ROOT, ".env");

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const flag = (fallback: boolean) =>
  optionalString.transform((v) => (v === undefined ? fallback : v === "1" || v.toLowerCase() === "true"));

const EnvSchema = z.object({
  // Your Jelly login, from `npm run setup` or `npm run login`. Every action and most reads go through it.
  JELLY_SESSION_COOKIE: optionalString,
  JELLY_BASE_URL: optionalString.transform((v) => (v ?? "https://app.letsjelly.com").replace(/\/+$/, "")),
  JELLY_TEAM: optionalString.transform((v) => v ?? "hack-club"),
  JELLY_TIMEZONE: optionalString.transform((v) => v ?? Intl.DateTimeFormat().resolvedOptions().timeZone),

  // Marmalade, the read-only mirror of Jelly. Optional: it adds date/status queries and the team directory.
  MARMALADE_BASE_URL: optionalString.transform((v) => (v ?? "https://marmalade.hackclub.com").replace(/\/+$/, "")),
  MARMALADE_API_KEY: optionalString,
  // The mailbox list_mailbox_conversations uses when none is given, e.g. "haven".
  MARMALADE_MAILBOX: optionalString,

  // The always-on service (npm run service): its port, and the token every request must carry.
  JELLY_MCP_PORT: optionalString.transform((v, ctx) => {
    const port = Number(v ?? 4646);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      ctx.addIssue({ code: "custom", message: "expected a port number" });
      return z.NEVER;
    }
    return port;
  }),
  JELLY_MCP_TOKEN: optionalString,

  // 1: Claude can only read; every tool that changes Jelly is hidden.
  READ_ONLY: flag(false),
  // 1: Claude can draft replies and emails but not send them.
  DRAFT_ONLY_NO_SEND: flag(false),
});

export interface Config {
  jelly: { baseUrl: string; team: string; timezone: string; cookie?: string };
  marmalade?: { baseUrl: string; apiKey: string; defaultMailbox?: string };
  readOnly: boolean;
  draftOnly: boolean;
  service: { port: number; token?: string };
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new ConfigError(`Invalid configuration:\n${issues}`);
  }
  const e = result.data;
  // Register every credential before anything can log it.
  registerSecret(e.JELLY_SESSION_COOKIE);
  for (const part of (e.JELLY_SESSION_COOKIE ?? "").split(";")) registerSecret(part.split("=").slice(1).join("=").trim());
  registerSecret(e.MARMALADE_API_KEY);
  registerSecret(e.JELLY_MCP_TOKEN);

  if (!e.JELLY_SESSION_COOKIE && !e.MARMALADE_API_KEY) {
    throw new ConfigError(
      `Nothing to connect with: run npm run setup in the jelly-mcp folder (looked in ${ENV_FILE})`,
    );
  }
  return {
    jelly: { baseUrl: e.JELLY_BASE_URL, team: e.JELLY_TEAM, timezone: e.JELLY_TIMEZONE, cookie: e.JELLY_SESSION_COOKIE },
    marmalade: e.MARMALADE_API_KEY
      ? { baseUrl: e.MARMALADE_BASE_URL, apiKey: e.MARMALADE_API_KEY, defaultMailbox: e.MARMALADE_MAILBOX }
      : undefined,
    readOnly: e.READ_ONLY,
    draftOnly: e.DRAFT_ONLY_NO_SEND,
    service: { port: e.JELLY_MCP_PORT, token: e.JELLY_MCP_TOKEN },
  };
}

/** Loads .env from the repo root. Values already in the environment (from the MCP client config) win. */
export function loadEnvFile(): void {
  dotenv.config({ path: ENV_FILE, quiet: true });
}
