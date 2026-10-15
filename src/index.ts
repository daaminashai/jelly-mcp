#!/usr/bin/env node
// The Jelly MCP server. stdout is the protocol in the stdio modes, so anything
// for people goes to stderr.
//   node dist/index.js            stdio: Claude starts it and talks to it directly
//   node dist/index.js --http     the always-on service (npm run service runs this)
//   node dist/index.js --bridge   stdio relay to the service, for Claude Desktop;
//                                 runs the tools itself if the service is down
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runBridge, serviceAccepts, serviceUrl } from "./bridge.js";
import { ConfigError, loadConfig, loadEnvFile } from "./config.js";
import { startHttpServer } from "./http.js";
import { errorMessage } from "./redact.js";
import { buildDeps, createMcpServer, describeDeps } from "./server.js";

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const mode = process.argv.includes("--http") ? "http" : process.argv.includes("--bridge") ? "bridge" : "stdio";
  const { port, token } = config.service;

  // The relay only relays to a service that's up and takes our token; otherwise it serves directly.
  if (mode === "bridge" && token && (await serviceAccepts(port, token))) {
    await runBridge(port, token);
    process.stderr.write(`jelly-mcp relay to ${serviceUrl(port)}\n`);
    return;
  }

  const deps = buildDeps(config);
  if (mode === "http") {
    if (!token) throw new ConfigError("The service needs JELLY_MCP_TOKEN in .env: run npm run service to set it up");
    const server = await startHttpServer(deps, { port, token });
    const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
    log(`jelly-mcp service on ${serviceUrl(port)} (${describeDeps(deps)})`);
    const stop = () => server.close(() => process.exit(0));
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    // Keep serving through a failed request; launchd restarts it if it ever dies.
    process.on("unhandledRejection", (err) => log(`unhandled: ${errorMessage(err)}`));
    return;
  }

  await createMcpServer(deps).connect(new StdioServerTransport());
  const why = mode === "bridge" ? "; the service wasn't running or didn't take the token, so serving directly" : "";
  process.stderr.write(`jelly-mcp ready (${describeDeps(deps)}${why})\n`);
}

main().catch((err) => {
  process.stderr.write(`jelly-mcp: ${errorMessage(err)}\n`);
  process.exit(1);
});
