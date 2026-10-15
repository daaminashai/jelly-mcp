import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { startHttpServer } from "../src/http.js";
import { plist } from "../src/service.js";

const TOKEN = "test-token-123456";
const config: Config = {
  jelly: { baseUrl: "https://app.letsjelly.com", team: "hack-club", timezone: "UTC" },
  readOnly: false,
  draftOnly: false,
  service: { port: 0, token: TOKEN },
};

let server: http.Server;
let port: number;
const logs: string[] = [];

beforeAll(async () => {
  server = await startHttpServer({ config }, { port: 0, token: TOKEN, log: (l) => logs.push(l) });
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** A raw request, so headers like Host can be anything. */
function raw(o: { method?: string; path?: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: o.method ?? "POST", path: o.path ?? "/mcp", headers: o.headers },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on("error", reject);
    req.end(o.body);
  });
}

const json = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const init = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});

describe("the always-on HTTP mode", () => {
  it("serves MCP to a client with the token", async () => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["whoami", "get_conversation"]);
    const res = await client.callTool({ name: "whoami", arguments: {} });
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain("Jelly: no login configured");
    await client.close();
    expect(logs).toContain(logs.find((l) => /^tool whoami \(\d+ms\)$/.test(l)));
  });

  it("answers /health without the token, and nothing else", async () => {
    expect(await raw({ method: "GET", path: "/health" })).toEqual({ status: 200, body: "ok\n" });
    expect((await raw({ method: "GET", path: "/" })).status).toBe(404);
  });

  it("turns away a missing or wrong token", async () => {
    expect((await raw({ headers: json, body: init })).status).toBe(401);
    expect((await raw({ headers: { ...json, authorization: "Bearer nope" }, body: init })).status).toBe(401);
    expect((await raw({ headers: { ...json, authorization: `Bearer ${TOKEN}` }, body: init })).status).toBe(200);
  });

  it("turns away other hosts and web pages, even with the token", async () => {
    const auth = { ...json, authorization: `Bearer ${TOKEN}` };
    expect((await raw({ headers: { ...auth, host: `evil.example:${port}` }, body: init })).status).toBe(403);
    expect((await raw({ headers: { ...auth, origin: "https://evil.example" }, body: init })).status).toBe(403);
    expect((await raw({ headers: { ...auth, origin: `http://localhost:${port}` }, body: init })).status).toBe(200);
  });

  it("only takes POST, since it keeps no sessions", async () => {
    const res = await raw({ method: "GET", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(405);
  });
});

describe("the launchd job", () => {
  it("starts at login, restarts when it stops, and runs the HTTP mode", () => {
    const xml = plist({ node: "/n/node", entry: "/a & b/dist/index.js", root: "/a & b", log: "/l.log" });
    expect(xml).toContain("<string>/a &amp; b/dist/index.js</string>\n    <string>--http</string>");
    expect(xml).toContain("<key>RunAtLoad</key><true/>");
    expect(xml).toContain("<key>KeepAlive</key><true/>");
    expect(xml).toContain("<key>Label</key><string>com.jelly-mcp</string>");
  });
});
