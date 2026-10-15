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

  // 1 hides every tool that changes anything in Jelly.
  JELLY_READ_ONLY: flag(false),
  // 0 keeps drafting but hides the tools that send email.
  JELLY_ALLOW_SEND: flag(true),
});

export interface Config {
  jelly: { baseUrl: string; team: string; timezone: string; cookie?: string };
  marmalade?: { baseUrl: string; apiKey: string; defaultMailbox?: string };
  readOnly: boolean;
  allowSend: boolean;
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
    readOnly: e.JELLY_READ_ONLY,
    allowSend: e.JELLY_ALLOW_SEND,
  };
}

/** Loads .env from the repo root. Values already in the environment (from the MCP client config) win. */
export function loadEnvFile(): void {
  dotenv.config({ path: ENV_FILE, quiet: true });
}
