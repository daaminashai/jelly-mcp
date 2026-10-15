// Reads and edits the .env file without disturbing other lines or printing values.
import fs from "node:fs";

export function readEnvFile(file: string): Map<string, string> {
  const values = new Map<string, string>();
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) values.set(match[1]!, match[2]!.trim().replace(/^(['"])(.*)\1$/, "$2"));
  }
  return values;
}

/** Sets KEY=value lines, keeping everything else. The file stays readable only by you. */
export function setEnvValues(file: string, updates: Record<string, string>): void {
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, () => line) : `${text.replace(/\n*$/, "")}${text ? "\n" : ""}${line}\n`;
  }
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
