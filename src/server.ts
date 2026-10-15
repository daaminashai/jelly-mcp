// Builds the MCP server. The Jelly and Marmalade clients are made once and
// shared, so the always-on service keeps one login and one cache for every
// Claude window.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENV_FILE, type Config } from "./config.js";
import { readEnvFile } from "./envfile.js";
import { JellyClient } from "./jelly/client.js";
import { Jelly } from "./jelly/service.js";
import { MarmaladeClient } from "./marmalade.js";
import { registerSecret } from "./redact.js";
import { registerTools, type Deps } from "./tools.js";

const INSTRUCTIONS = `Jelly (letsjelly.com) is the team's shared email inbox. Conversations are email threads; each has a slug used by every tool.
- Orient with whoami. Find work with list_conversations (Jelly's inbox and other views), search_conversations (full text), or list_mailbox_conversations (Marmalade: by status and date).
- Read a thread with get_conversation before acting on it. Internal notes there are team-only.
- To answer, prefer draft_reply so a person can review it in Jelly; only use send_reply/send_email when asked to send. Pass expected_latest_message_id from get_conversation when replying.
- To redo a reply you drafted, call draft_reply again with replace_my_draft; discard_draft removes one. Teammates' drafts are never touched.
- Replies go out from the conversation's address with the user's signature already added; write the body only.
- update_conversation archives, assigns, labels, snoozes and more, as Jelly's buttons do.`;

export function buildDeps(config: Config): Deps {
  const jelly = config.jelly.cookie
    ? new Jelly(
        new JellyClient({
          baseUrl: config.jelly.baseUrl,
          team: config.jelly.team,
          cookie: config.jelly.cookie,
          timezone: config.jelly.timezone,
          reloadCookie: () => {
            const latest = readEnvFile(ENV_FILE).get("JELLY_SESSION_COOKIE");
            registerSecret(latest);
            for (const part of (latest ?? "").split(";")) registerSecret(part.split("=").slice(1).join("=").trim());
            return latest;
          },
        }),
      )
    : undefined;
  const marmalade = config.marmalade ? new MarmaladeClient(config.marmalade) : undefined;
  return { config, jelly, marmalade };
}

export function createMcpServer(deps: Deps): McpServer {
  const server = new McpServer({ name: "jelly", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  registerTools(server, deps);
  return server;
}

export function describeDeps({ config, jelly, marmalade }: Deps): string {
  const mode = config.readOnly ? ", read only" : config.draftOnly ? ", drafts only" : "";
  return `Jelly ${jelly ? "connected" : "off"}, Marmalade ${marmalade ? "connected" : "off"}${mode}`;
}
