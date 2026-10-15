// The always-on mode: the MCP server over HTTP on this computer only, for the
// launchd service (npm run service). It can send email as you, so it listens on
// 127.0.0.1, wants the token from .env on every request, and turns away any
// request whose Host or Origin isn't this machine, so a web page can't reach it.
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { errorMessage } from "./redact.js";
import { createMcpServer } from "./server.js";
import type { Deps } from "./tools.js";

const MAX_BODY = 4 * 1024 * 1024;

export interface HttpOptions {
  port: number;
  token: string;
  log?: (line: string) => void;
}

export function startHttpServer(deps: Deps, o: HttpOptions): Promise<http.Server> {
  const log = o.log ?? ((line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`error: ${errorMessage(err)}`);
      if (!res.headersSent) reply(res, 500, "internal error");
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const port = (server.address() as { port: number }).port;
    const local = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!local.includes(req.headers.host ?? "")) return reply(res, 403, "wrong host");
    const origin = req.headers.origin;
    if (origin && !local.some((h) => origin === `http://${h}`)) return reply(res, 403, "wrong origin");

    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/health") return reply(res, 200, "ok");
    if (path !== "/mcp") return reply(res, 404, "not found");
    if (!tokenMatches(req.headers.authorization, o.token)) return reply(res, 401, "missing or wrong token");
    // Stateless: every request stands alone, so there are no streams or sessions to GET or DELETE.
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return reply(res, 405, "POST only");
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      return reply(res, 400, errorMessage(err));
    }
    const started = Date.now();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: local,
    });
    const mcp = createMcpServer(deps);
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
    for (const call of toolCalls(body)) log(`${call} (${Date.now() - started}ms)`);
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(/^Bearer\s+(.+)$/i.exec(header ?? "")?.[1] ?? "");
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("request too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function reply(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(`${text}\n`);
}

/** Tool names called in a request, for the log (never their arguments). */
function toolCalls(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages
    .filter((m): m is { method: string; params?: { name?: string } } => typeof m === "object" && m !== null && "method" in m)
    .filter((m) => m.method === "tools/call")
    .map((m) => `tool ${m.params?.name ?? "?"}`);
}
