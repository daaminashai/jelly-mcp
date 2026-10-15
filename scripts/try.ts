// Calls the built server like Claude would, for trying tools by hand:
//   npm run try                                  list the tools
//   npm run try -- get_conversation '{"conversation":"some-slug"}' [maxChars]
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [tool, json = "{}", max = "1500"] = process.argv.slice(2);
const client = new Client({ name: "local-test", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve("dist/index.js")], cwd: "/", env: { ...getDefaultEnvironment(), ...JSON.parse(process.env.JM_ENV ?? "{}") } }));
if (!tool || tool === "--list") {
  const { tools } = await client.listTools();
  for (const t of tools) console.log(`${t.name}  ${JSON.stringify(t.annotations)}  args: ${Object.keys((t.inputSchema as { properties?: object }).properties ?? {}).join(",")}`);
  console.log("instructions:", client.getInstructions()?.slice(0, 80));
} else {
  const t0 = Date.now();
  const res = await client.callTool({ name: tool, arguments: JSON.parse(json) });
  const text = (res.content as Array<{ text?: string }>).map((c) => c.text).join("\n");
  console.log(`[${tool} ${res.isError ? "ERROR" : "ok"} ${Date.now() - t0}ms ${text.length} chars]`);
  console.log(text.slice(0, Number(max)));
}
await client.close();
