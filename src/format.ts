// Plain-text renderings of Jelly data for the model: compact, with the slug or
// id it needs for the next call on every line.
import { htmlToText } from "./html.js";
import type { ConversationList, ConversationPage, ConversationRow } from "./jelly/pages.js";
import type { ConversationDetail, ConversationSummary } from "./marmalade.js";

export function formatList(title: string, list: ConversationList): string {
  const lines = [title];
  if (list.sections.length) {
    const sections = list.sections.map((s) => {
      const total = Number(/\((\d+)\)/.exec(s.title)?.[1] ?? s.shown);
      return total > s.shown ? `${s.title}, ${s.shown} shown` : s.title;
    });
    lines.push(`Sections: ${sections.join(" · ")}`);
    if (list.sections.some((s) => Number(/\((\d+)\)/.exec(s.title)?.[1] ?? 0) > s.shown)) {
      lines.push("(The inbox only shows the first few of a big section: use view all with status inbox and assignee unassigned to page through brand-new ones.)");
    }
  }
  if (list.range) lines.push(`Showing ${list.range}`);
  if (list.rows.length === 0) lines.push("", "No conversations.");
  let section: string | null = null;
  for (const row of list.rows) {
    if (row.section && row.section !== section) {
      section = row.section;
      lines.push("", `## ${section}`);
    }
    lines.push(formatRow(row));
  }
  if (list.nextPage) lines.push("", `More: page ${list.nextPage}`);
  return lines.join("\n");
}

function formatRow(row: ConversationRow): string {
  const flags = row.flags.filter((f) => ["unread", "snoozed", "unclaimed"].includes(f));
  const meta = [
    row.with.join(", "),
    row.at,
    row.mailboxes.length ? `in ${row.mailboxes.join(", ")}` : null,
    row.labels.length ? `labels: ${row.labels.join(", ")}` : null,
    row.assignees.length ? `assigned: ${row.assignees.join(", ")}` : null,
    row.status,
    row.messages ? `${row.messages} msgs` : null,
    flags.length ? flags.join(", ") : null,
  ].filter(Boolean);
  const ref = row.slug ? row.slug : `id ${row.id}`;
  const head = `- ${ref} — "${row.subject || "(no subject)"}" — ${meta.join(" — ")}`;
  return `${head}${row.preview ? `\n  > ${row.preview.length > 160 ? `${row.preview.slice(0, 160)}…` : row.preview}` : ""}`;
}

export function formatConversation(page: ConversationPage, url: string, maxCharsPerItem: number): string {
  const s = page.state;
  const status = s.trashed ? "in trash" : s.archived ? "archived" : s.archived === false ? "open (in the inbox)" : "unknown";
  const latest = page.timeline.filter((t) => t.kind === "message").at(-1);
  const lines = [
    `# ${page.subject}`,
    `Link: ${url}`,
    `Slug: ${page.slug} · Jelly id ${page.id}`,
    `Status: ${[status, s.snoozed ? "snoozed" : null, s.following ? "you follow it" : null, s.bookmarked ? "bookmarked" : null].filter(Boolean).join(" · ")}`,
    `Mailboxes: ${s.mailboxes.join(", ") || "?"} · Labels: ${s.labels.join(", ") || "none"} · Assigned: ${s.assignees.join(", ") || "nobody"}`,
    `Latest message: ${latest?.messageId ?? "?"}${page.drafts ? ` · ${page.drafts} unsent draft(s) open` : ""}`,
  ];
  if (page.options.assignable.length) lines.push(`Can also assign: ${page.options.assignable.map((a) => a.name).join(", ")}`);
  page.timeline.forEach((item, i) => {
    const heading =
      item.kind === "note" ? `## ${i + 1}. Internal note (team only)` : `## ${i + 1}. Email ${item.messageId ?? ""}`.trimEnd();
    lines.push("", heading, clip(item.text, maxCharsPerItem));
  });
  if (page.timeline.length === 0) lines.push("", "(Jelly showed no messages.)");
  return lines.join("\n");
}

export function formatMarmaladeConversation(c: ConversationDetail, mailbox: string, maxCharsPerItem: number): string {
  const lines = [
    `# ${c.subject ?? "(no subject)"}`,
    `From Marmalade (mailbox ${mailbox}); Jelly wasn't reachable, so assignees, labels and notes' authors may be missing.`,
    c.url ? `Link: ${c.url}` : null,
    `Slug: ${c.id} · Status: ${c.status}${c.snoozedUntil ? ` · snoozed until ${c.snoozedUntil}` : ""}`,
  ].filter((l): l is string => l !== null);
  const items = [
    ...c.messages.map((m) => ({
      at: m.sentAt ?? m.createdAt,
      text: [
        `Date: ${m.sentAt ?? m.createdAt}`,
        `Direction: ${m.isInbound ? "Inbound" : "Outbound"}`,
        m.subject ? `Subject: ${m.subject}` : null,
        m.attachmentsCount ? `Attachments: ${m.attachmentsCount}` : null,
        "Body:",
        stripQuoted(m.content?.trim() || htmlToText(m.contentHtml ?? "")),
      ]
        .filter((l) => l !== null)
        .join("\n"),
      heading: "Email",
    })),
    ...c.comments.map((n) => ({
      at: n.createdAt,
      text: `At: ${n.createdAt}\nContent:\n${(n.body ?? "").trim()}`,
      heading: "Internal note (team only)",
    })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  items.forEach((item, i) => lines.push("", `## ${i + 1}. ${item.heading}`, clip(item.text, maxCharsPerItem)));
  return lines.join("\n");
}

export function formatMarmaladeRow(c: ConversationSummary): string {
  return `- ${c.id} — "${c.subject ?? "(no subject)"}" — ${c.status} — last message ${c.lastMessageAt}${c.snoozedUntil ? ` — snoozed until ${c.snoozedUntil}` : ""}`;
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[… ${text.length - max} more characters cut]`;
}

// Lines that start the quoted history most clients append below a reply. (pudding's thread.ts)
const QUOTE_MARKERS = [/^-{2,}\s*Original Message\s*-{2,}/i, /^-{2,}\s*Forwarded message\s*-{2,}/i, /^From:\s.+/, /^_{10,}\s*$/];

/** Drops quoted history ("On … wrote:", "> …") so only what the message added is left. */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const attribution = /^On\s/.test(line.trim()) && /^On\s.{4,300}?\bwrote:/.test(lines.slice(i, i + 3).map((l) => l.trim()).join(" "));
    if (attribution || QUOTE_MARKERS.some((re) => re.test(line.trim()))) break;
    if (line.trimStart().startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}
