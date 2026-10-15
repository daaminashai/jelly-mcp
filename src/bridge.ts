// For apps that can only start a local program (Claude Desktop): passes Claude's
// messages through to the always-on service and its answers back.
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isJSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { errorMessage } from "./redact.js";

export function serviceUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/** Whether the service answers on this port right now. */
export async function serviceIsUp(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Whether the service is up and takes this token: it starts an MCP session, as Claude would. */
export async function serviceAccepts(port: number, token: string, timeoutMs = 5000): Promise<boolean> {
  if (!(await serviceIsUp(port))) return false;
  try {
    const res = await fetch(serviceUrl(port), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "jelly-mcp-check", version: "0" } },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function runBridge(port: number, token: string): Promise<void> {
  const remote = new StreamableHTTPClientTransport(new URL(serviceUrl(port)), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const local = new StdioServerTransport();
  local.onmessage = (message) => {
    remote.send(message).catch((err) => {
      // Answer the request ourselves so Claude isn't left waiting.
      if (!isJSONRPCRequest(message)) return;
      void local.send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: `The jelly-mcp service couldn't take this (${errorMessage(err).trim()}). If it stopped, it restarts by itself within a few seconds: try again, or run npm run service -- --status.`,
        },
      });
    });
  };
  remote.onmessage = (message) => void local.send(message);
  remote.onerror = (err) => process.stderr.write(`jelly-mcp relay: ${errorMessage(err)}\n`);
  local.onclose = () => void remote.close();
  await remote.start();
  await local.start();
}
