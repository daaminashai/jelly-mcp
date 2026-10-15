// `npm run check`: confirms the Jelly login and the Marmalade key work, without
// changing anything or printing secrets.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_FILE, loadConfig, loadEnvFile } from "./config.js";
import { JellyClient } from "./jelly/client.js";
import { Jelly } from "./jelly/service.js";
import { MarmaladeClient } from "./marmalade.js";
import { errorMessage } from "./redact.js";

/** One line per service; `ok` is false when something configured doesn't work. */
export async function runChecks(): Promise<{ ok: boolean; lines: string[] }> {
  loadEnvFile();
  const lines: string[] = [];
  let ok = true;
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    return { ok: false, lines: [`Config (${ENV_FILE}): ${errorMessage(err)}`] };
  }

  if (config.jelly.cookie) {
    const jelly = new Jelly(new JellyClient({ ...config.jelly, cookie: config.jelly.cookie }));
    try {
      const me = await jelly.identity();
      const { form } = await jelly.composeForm();
      lines.push(`✓ Jelly: ${me.name} <${me.email}>, team "${me.team}", mailboxes ${form.mailboxOptions.map((m) => m.name).join(", ")}`);
    } catch (err) {
      ok = false;
      lines.push(`✗ Jelly: ${errorMessage(err)}`);
    }
  } else lines.push("- Jelly: no login yet. Run `npm run login` (reads, actions and replies need it).");

  if (config.marmalade) {
    try {
      const mailboxes = await new MarmaladeClient(config.marmalade).listMailboxes();
      lines.push(`✓ Marmalade: can read ${mailboxes.map((m) => m.jellyMailbox.jellyMailboxId).join(", ") || "no mailboxes"}`);
    } catch (err) {
      ok = false;
      lines.push(`✗ Marmalade: ${errorMessage(err)}`);
    }
  } else lines.push("- Marmalade: no MARMALADE_API_KEY (optional: adds date/status queries and the team list).");

  lines.push(config.readOnly ? "- READ_ONLY is on: Claude can only read." : config.draftOnly ? "- DRAFT_ONLY_NO_SEND is on: Claude can draft but not send." : "- Claude can read, draft and send.");
  return { ok, lines };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runChecks().then(({ ok, lines }) => {
    process.stdout.write(`${lines.join("\n")}\n`);
    process.exit(ok ? 0 : 1);
  });
}
