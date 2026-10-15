#!/usr/bin/env node
// The Jelly MCP server, over stdio. Claude starts it; stdout is the protocol,
// so anything for people goes to stderr.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, loadEnvFile } from "./config.js";
import { JellyClient } from "./jelly/client.js";
import { Jelly } from "./jelly/service.js";
import { MarmaladeClient } from "./marmalade.js";
import { errorMessage } from "./redact.js";
import { registerTools } from "./tools.js";

const INSTRUCTIONS = `Jelly (letsjelly.com) is the team's shared email inbox. Conversations are email threads; each has a slug used by every tool.
- Orient with whoami. Find work with list_conversations (Jelly's inbox and other views), search_conversations (full text), or list_mailbox_conversations (Marmalade: by status and date).
- Read a thread with get_conversation before acting on it. Internal notes there are team-only.
- To answer, prefer draft_reply so a person can review it in Jelly; only use send_reply/send_email when asked to send. Pass expected_latest_message_id from get_conversation when replying.
- Replies go out from the conversation's address with the user's signature already added; write the body only.
- update_conversation archives, assigns, labels, snoozes and more, as Jelly's buttons do.`;

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const jelly = config.jelly.cookie
    ? new Jelly(
        new JellyClient({
          baseUrl: config.jelly.baseUrl,
          team: config.jelly.team,
          cookie: config.jelly.cookie,
          timezone: config.jelly.timezone,
        }),
      )
    : undefined;
  const marmalade = config.marmalade ? new MarmaladeClient(config.marmalade) : undefined;

  const server = new McpServer({ name: "jelly", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  registerTools(server, { config, jelly, marmalade });
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `jelly-mcp ready (Jelly ${jelly ? "connected" : "off"}, Marmalade ${marmalade ? "connected" : "off"}${config.readOnly ? ", read only" : config.draftOnly ? ", drafts only" : ""})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`jelly-mcp: ${errorMessage(err)}\n`);
  process.exit(1);
});
