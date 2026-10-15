// Reads Jelly's server-rendered pages. Every action in Jelly is a Rails form on
// the page (button_to), so a page tells us both what a conversation looks like
// and exactly which requests change it. Nothing here touches the network.
import { parse, type HTMLElement } from "node-html-parser";
import { decodeEntities, squish } from "../html.js";
import { JellyError, type Fields } from "./client.js";

export function parseHtml(html: string): HTMLElement {
  return parse(html, { comment: false });
}

export function csrfToken(root: HTMLElement): string {
  const token = root.querySelector('meta[name="csrf-token"]')?.getAttribute("content");
  if (!token) throw new JellyError("Jelly's page had no CSRF token");
  return token;
}

export interface Identity {
  userId: string;
  name: string;
  email: string;
  team: string;
  account: string;
  plan: string | null;
}

/** Who is logged in, from the analytics identity Jelly embeds in every page. */
export function parseIdentity(root: HTMLElement): Identity | null {
  const script = root.querySelector("script#posthog-identity");
  if (!script) return null;
  try {
    const data = JSON.parse(script.rawText) as {
      user?: { id?: string; properties?: { email?: string; name?: string } };
      account?: { properties?: { name?: string; plan?: string } };
      team?: { properties?: { name?: string } };
    };
    return {
      userId: String(data.user?.id ?? ""),
      name: data.user?.properties?.name ?? "",
      email: data.user?.properties?.email ?? "",
      team: data.team?.properties?.name ?? "",
      account: data.account?.properties?.name ?? "",
      plan: data.account?.properties?.plan ?? null,
    };
  } catch {
    return null;
  }
}

// ---------- forms ----------

export interface PageForm {
  /** As written in the page, relative to Jelly's origin. */
  action: string;
  /** What the form really does: `_method` wins over the form's own POST. */
  method: "get" | "post" | "patch" | "put" | "delete";
  fields: Fields;
  /** The button's title, aria-label, or text. */
  label: string;
  /** Text of a data-turbo-confirm prompt, if the button asks first. */
  confirm: string | null;
  className: string;
  id: string | null;
  el: HTMLElement;
}

/** Every named field a browser would submit, in order (unchecked boxes and buttons left out). */
export function formFields(form: HTMLElement): Fields {
  const fields: Fields = [];
  for (const el of form.querySelectorAll("input, textarea, select")) {
    const name = el.getAttribute("name");
    if (!name) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (tag === "input" && ["submit", "button", "file", "image", "reset"].includes(type)) continue;
    if (tag === "input" && (type === "checkbox" || type === "radio") && !el.hasAttribute("checked")) continue;
    if (tag === "textarea") fields.push([name, decodeEntities(el.rawText)]);
    else if (tag === "select") {
      const option = el.querySelector("option[selected]") ?? el.querySelector("option");
      fields.push([name, option?.getAttribute("value") ?? option?.text ?? ""]);
    } else fields.push([name, el.getAttribute("value") ?? ""]);
  }
  return fields;
}

export function parseForms(root: HTMLElement): PageForm[] {
  return root.querySelectorAll("form").map((el) => {
    const fields = formFields(el);
    const override = fields.find(([n]) => n === "_method")?.[1]?.toLowerCase();
    const own = (el.getAttribute("method") ?? "get").toLowerCase();
    const button = el.querySelector("button[title], button[aria-label]") ?? el.querySelector("button");
    const label =
      button?.getAttribute("title") ?? button?.getAttribute("aria-label") ?? squish(button?.text ?? el.text ?? "");
    return {
      action: el.getAttribute("action") ?? "",
      method: (override ?? own) as PageForm["method"],
      fields,
      label: squish(label),
      confirm: el.getAttribute("data-turbo-confirm") ?? button?.getAttribute("data-turbo-confirm") ?? null,
      className: el.getAttribute("class") ?? "",
      id: el.getAttribute("id") ?? null,
      el,
    };
  });
}

/** The path part of a form action, without the team or conversation prefix: "/assignments/12". */
export function actionTail(action: string, slugPath: string): string {
  const path = new URL(action, "https://jelly.invalid").pathname;
  return path.startsWith(slugPath) ? path.slice(slugPath.length) : path;
}

export function fieldValue(form: Pick<PageForm, "fields" | "action">, name: string): string | null {
  const own = form.fields.find(([n]) => n === name)?.[1];
  if (own !== undefined) return own;
  return new URL(form.action, "https://jelly.invalid").searchParams.get(name);
}

/** The first “quoted” name in a label: 'Add “Visas” label to conversation' -> "Visas". */
export function quoted(text: string | null | undefined): string | null {
  const match = /[“"]([^”"]+)[”"]/.exec(text ?? "");
  return match ? decodeEntities(match[1]!) : null;
}

// ---------- conversation page ----------

export interface TimelineItem {
  kind: "message" | "note";
  /** Jelly's internal id: ts_message_<id> / ts_note_<id>. */
  id: string;
  /** A message's public id (msg-…), used to reply to it or read its raw source. */
  messageId: string | null;
  /** Jelly's own plain-text rendering (its "copy for AI"), headers included. */
  text: string;
}

export interface Named {
  id: string;
  name: string;
}

export interface ConversationPage {
  slug: string;
  /** Jelly's numeric conversation id. */
  id: string;
  subject: string;
  csrfToken: string;
  forms: PageForm[];
  timeline: TimelineItem[];
  state: {
    archived: boolean | null;
    trashed: boolean;
    snoozed: boolean;
    /** When a snoozed conversation comes back to the inbox. */
    snoozedUntil: string | null;
    bookmarked: boolean | null;
    following: boolean | null;
    assignees: string[];
    labels: string[];
    mailboxes: string[];
  };
  options: {
    assignable: Named[];
    labels: Named[];
    mailboxes: Named[];
  };
  /** The main Reply button: always answers the latest message. */
  reply: { action: string; frame: string; latestId: string } | null;
  /** Reply buttons on each message, by public message id. */
  messageReplies: Map<string, { action: string; frame: string }>;
  /** Unsent drafts open in the conversation. */
  drafts: number;
  /** Each open reply draft's frame: it loads a preview with an "Edit draft" button. */
  draftFrames: Array<{ frame: string; src: string }>;
  /** People who can be @mentioned in a note, with the token Jelly's editor inserts. */
  mentions: Array<{ name: string; sgid: string }>;
  me: Identity | null;
}

export function parseConversationPage(html: string, finalUrl: string): ConversationPage {
  const root = parseHtml(html);
  const slug = decodeURIComponent(/\/conversations\/([^/?#]+)/.exec(new URL(finalUrl).pathname)?.[1] ?? "");
  if (!slug) throw new JellyError(`Not a conversation page: ${new URL(finalUrl).pathname}`);
  const slugPath = new URL(finalUrl).pathname.replace(/\/$/, "");
  const forms = parseForms(root);
  const tail = (f: PageForm) => actionTail(f.action, slugPath);
  const formsAt = (re: RegExp) => forms.filter((f) => re.test(tail(f)));
  const me = parseIdentity(root);

  const editForm = forms.find((f) => /^edit_conversation_\d+$/.test(f.id ?? ""));
  const id =
    editForm?.id?.replace("edit_conversation_", "") ??
    forms.map((f) => fieldValue(f, "message[conversation_id]")).find(Boolean) ??
    "";
  const title = squish(root.querySelector("title")?.text ?? "");
  const subject = title.split(" · ")[0] ?? title;

  // State, read off which buttons the page offers.
  const archiveForms = formsAt(/^\/archive$/);
  const toggle = (path: RegExp): boolean | null => {
    const found = formsAt(path);
    if (found.length === 0) return null;
    return found.some((f) => f.method === "delete");
  };

  const named = new Map<string, string>();
  const unassign = formsAt(/^\/assignments\/\d+$/).filter((f) => f.method === "delete");
  const assignees = unique(
    unassign.map((f) => {
      const match = /^Unassign (.+?) from this conversation$/i.exec(f.label) ?? /^Unassign (.+)$/i.exec(f.label);
      const who = match?.[1] ?? f.label;
      return /^yourself$/i.test(who) ? (me?.name ?? "you") : who;
    }),
  );
  for (const f of formsAt(/^\/assignments$/)) {
    const assigneeId = fieldValue(f, "assignee_id");
    if (!assigneeId || named.has(assigneeId)) continue;
    // Your own button reads "I got this" / "Assign to yourself"; teammates' read "Assign to <name>".
    const self = /^i got this$/i.test(f.label) || /\byourself\b/i.test(f.label);
    const who = self ? (me?.name ?? "you") : (/assign (?:this conversation )?to (.+)$/i.exec(f.label)?.[1] ?? f.label);
    named.set(assigneeId, who);
  }

  const labelOptions = new Map<string, string>();
  for (const f of formsAt(/^\/conversation_labels$/)) {
    const labelId = fieldValue(f, "label_id");
    const name = quoted(f.label) ?? f.label;
    if (labelId && name) labelOptions.set(labelId, name);
  }
  const labels = unique(
    formsAt(/^\/conversation_labels\/\d+$/)
      .filter((f) => f.method === "delete")
      .map((f) => quoted(f.label) ?? quoted(f.confirm) ?? f.label),
  );

  const mailboxOptions = new Map<string, string>();
  for (const f of formsAt(/^\/conversation_mailboxes$/)) {
    const mailboxId = fieldValue(f, "mailbox_id");
    const name = quoted(f.label);
    if (mailboxId && name) mailboxOptions.set(mailboxId, name);
  }
  const mailboxes = unique(
    formsAt(/^\/conversation_mailboxes\/\d+$/)
      .filter((f) => f.method === "delete")
      .map((f) => quoted(f.confirm) ?? mailboxOptions.get(tail(f).split("/").pop()!) ?? quoted(f.label) ?? "")
      .filter(Boolean),
  );

  // Timeline: messages and internal notes, oldest first, as Jelly renders them for AI.
  const timeline: TimelineItem[] = [];
  for (const item of root.querySelectorAll(".thread-item")) {
    const cls = item.getAttribute("class") ?? "";
    const kind = /\bti-note\b/.test(cls) ? "note" : /\bti-message\b/.test(cls) ? "message" : null;
    if (!kind) continue;
    const source = item.querySelector('input[name="ai_source"]')?.getAttribute("value");
    if (!source) continue;
    const domId =
      item.getAttribute("id") ??
      item.querySelector('[id^="ts_message_"], [id^="ts_note_"]')?.getAttribute("id") ??
      "";
    const messageId =
      kind === "message"
        ? (/\/messages\/(msg-[^/?#"]+)/.exec(
            item.querySelectorAll("a[href]").map((a) => a.getAttribute("href")).find((h) => /\/messages\/msg-/.test(h ?? "")) ?? "",
          )?.[1] ?? null)
        : null;
    timeline.push({
      kind,
      id: domId.replace(/^ts_(message|note)_/, ""),
      messageId,
      text: source.replace(/\r\n/g, "\n").replace(/ /g, " ").trim(),
    });
  }

  // Reply buttons (pudding's parseConversationPage).
  const responder = root.querySelector("#ts_responder form.button_to");
  const responderAction = responder?.getAttribute("action");
  const responderFrame = responder?.querySelector("button")?.getAttribute("data-turbo-frame");
  const latestId = responderAction
    ? new URL(responderAction, "https://jelly.invalid").searchParams.get("message[previous_message_id]")
    : null;
  const messageReplies = new Map<string, { action: string; frame: string }>();
  for (const form of root.querySelectorAll("form.message-reply-button-form")) {
    const action = form.getAttribute("action") ?? "";
    const frame = form.querySelector("button")?.getAttribute("data-turbo-frame");
    const publicId = new URL(action, "https://jelly.invalid").searchParams.get("message[previous_message_id]");
    if (publicId && frame) messageReplies.set(publicId, { action, frame });
  }

  const mentions = root
    .querySelectorAll("li[data-trix-attachment-sgid]")
    .map((li) => ({ name: squish(li.text) || (li.getAttribute("data-name") ?? ""), sgid: li.getAttribute("data-trix-attachment-sgid")! }))
    .filter((m) => m.name);

  return {
    slug,
    id,
    subject,
    csrfToken: csrfToken(root),
    forms,
    timeline,
    state: {
      archived: archiveForms.length ? archiveForms.some((f) => f.method === "delete") : null,
      trashed: formsAt(/^\/trash$/).some((f) => f.method === "delete"),
      snoozed: formsAt(/^\/unsnooze$/).length > 0 || formsAt(/^\/snooze$/).some((f) => f.method === "delete"),
      // The "Conversation snoozed until …" banner (not the "snoozed this until" lines in the history).
      snoozedUntil:
        root
          .querySelectorAll("time[datetime]")
          .find((t) => !t.closest(".ti-activity") && /snoozed until/i.test(t.parentNode?.text ?? ""))
          ?.getAttribute("datetime") ?? null,
      bookmarked: toggle(/^\/bookmarks?(\/\d+)?$/),
      following: formsAt(/^\/unsubscribe$/).length > 0 ? true : formsAt(/^\/subscribe$/).length > 0 ? false : null,
      assignees,
      labels,
      mailboxes,
    },
    options: {
      assignable: [...named].map(([id, name]) => ({ id, name })),
      labels: [...labelOptions].map(([id, name]) => ({ id, name })),
      mailboxes: [...mailboxOptions].map(([id, name]) => ({ id, name })),
    },
    reply: responderAction && responderFrame && latestId ? { action: responderAction, frame: responderFrame, latestId } : null,
    messageReplies,
    drafts: countDrafts(root),
    draftFrames: root
      .querySelectorAll("turbo-frame[src]")
      .filter((f) => /\/messages\/[^/]+\/edit(\?|$)/.test(f.getAttribute("src") ?? ""))
      .map((f) => ({ frame: f.getAttribute("id") ?? "", src: f.getAttribute("src")! })),
    mentions: uniqueBy(mentions, (m) => m.sgid),
    me,
  };
}

/**
 * Unsent drafts in the conversation. An open draft shows up as a lazy frame that
 * loads its edit form: <turbo-frame id="message-form-…" src="…/messages/msg-…/edit">.
 * Anything else marked as a draft counts too, to stay on the safe side. (pudding)
 */
function countDrafts(root: HTMLElement): number {
  let n = root
    .querySelectorAll("turbo-frame[src]")
    .filter((f) => /\/messages\/[^/]+\/edit(\?|$)/.test(f.getAttribute("src") ?? "")).length;
  for (const el of root.querySelectorAll("[class], [id]")) {
    const cls = el.getAttribute("class") ?? "";
    const id = el.getAttribute("id") ?? "";
    if (/(^|[\s_-])draft($|[\s_-])/i.test(cls) || /^draft[_-]/i.test(id)) n++;
  }
  return n;
}

// ---------- drafts ----------

export interface DraftPreview {
  /** The draft's message id, msg-…; null if the page didn't say. */
  messageId: string | null;
  /** The "Edit draft" button, which takes the draft's edit lock. Null when you already hold it. */
  claimAction: string | null;
  /** Who started it ("Draft · started by Sana Deghat"); null means you did. */
  startedBy: string | null;
  /** The text of the draft, without signature or quote. */
  text: string;
}

/** A draft's frame as Jelly shows it to someone not editing it: a preview and "Edit draft". */
export function parseDraftPreview(html: string): DraftPreview {
  const root = parseHtml(html);
  const claimAction = root.querySelector('form[action$="/claim"]')?.getAttribute("action") ?? null;
  const provenance = squish(root.querySelector(".draft-provenance")?.text ?? "");
  const body = root.querySelector(".draft-locked-body");
  body?.querySelectorAll(".jelly-signature, .jelly-quote, blockquote").forEach((el) => el.remove());
  const discard = parseDraftDiscard(html);
  const messageId =
    /\/drafts\/(msg-[^/]+)\/claim/.exec(claimAction ?? "")?.[1] ?? /\/messages\/(msg-[^/?]+)/.exec(discard ?? "")?.[1] ?? null;
  return {
    messageId,
    claimAction,
    startedBy: /started by (.+)$/i.exec(provenance)?.[1]?.trim() ?? null,
    text: body ? squish(body.text) : "",
  };
}

/** The editor's Discard link (DELETE /messages/msg-…?discard=true&draft_lock_token=…), once you hold the draft. */
export function parseDraftDiscard(html: string): string | null {
  const root = parseHtml(html);
  const link = root
    .querySelectorAll('a[data-turbo-method="delete"][href]')
    .find((a) => /\/messages\/msg-[^?]+\?(.*&)?discard=true/.test(a.getAttribute("href")!));
  return link?.getAttribute("href") ?? null;
}

// ---------- reply / compose forms ----------

export interface MessageForm {
  action: string;
  fields: Fields;
  /** Where the editor autosaves the draft (PUT), and how it lets go of its edit lock. */
  draftUpdateUrl: string | null;
  draftReleaseUrl: string | null;
  draftCreateUrl: string | null;
  draftLockToken: string | null;
  fromOptions: Array<{ value: string; label: string; selected: boolean }>;
  mailboxOptions: Array<{ id: string; name: string; selected: boolean }>;
}

/** The message form in a reply draft (a turbo-stream) or on the compose page. */
export function parseMessageForm(html: string): MessageForm {
  const root = parseHtml(html);
  const form =
    root.querySelector("form#new_message") ??
    root
      .querySelectorAll("form")
      .find((f) => /\/conversations\/[^/]+\/messages\/[^/?#]+|\/messages$/.test(f.getAttribute("action") ?? ""));
  if (!form) throw new JellyError("Jelly's response didn't contain a message form");
  const attr = (name: string) => form.getAttribute(`data-reply-${name}-value`) || null;
  const select = (name: string) => form.querySelector(`select[name="${name}"]`)?.querySelectorAll("option") ?? [];
  return {
    action: form.getAttribute("action")!,
    fields: formFields(form),
    draftUpdateUrl: attr("draft-update-url"),
    draftReleaseUrl: attr("draft-release-url"),
    draftCreateUrl: attr("draft-create-url"),
    draftLockToken: attr("draft-lock-token") ?? formFields(form).find(([n]) => n === "draft_lock_token")?.[1] ?? null,
    fromOptions: select("message[from]").map((o) => ({
      value: o.getAttribute("value") ?? "",
      label: squish(o.text),
      selected: o.hasAttribute("selected"),
    })),
    mailboxOptions: select("message[mailbox_id]").map((o) => ({
      id: o.getAttribute("value") ?? "",
      name: squish(o.text),
      selected: o.hasAttribute("selected"),
    })),
  };
}

export interface SavedReply {
  id: string;
  name: string;
  html: string;
}

export function parseSavedReplies(html: string): SavedReply[] {
  const root = parseHtml(html);
  return uniqueBy(
    root.querySelectorAll("button.squire-saved-reply-option[data-reply-id]").map((b) => {
      const id = b.getAttribute("data-reply-id")!;
      return {
        id,
        name: squish(b.querySelector("strong")?.text ?? ""),
        html: b.querySelector(`#saved-reply-content-${id}`)?.innerHTML ?? "",
      };
    }),
    (r) => r.id,
  );
}

// ---------- conversation lists ----------

export interface ConversationRow {
  id: string;
  slug: string;
  subject: string;
  /** "Name <email>" of the people on the other side. */
  with: string[];
  preview: string;
  mailboxes: string[];
  labels: string[];
  assignees: string[];
  messages: number | null;
  status: string | null;
  section: string | null;
  at: string | null;
  flags: string[];
}

export interface ConversationList {
  rows: ConversationRow[];
  /** Inbox sections; `shown` can be less than the count in the title (Jelly shows the first 25). */
  sections: Array<{ key: string; title: string; shown: number }>;
  /** "1-25 of 1513", when Jelly shows it. */
  range: string | null;
  nextPage: number | null;
}

const chipName = (chip: HTMLElement) => squish(chip.getAttribute("title") ?? chip.text);

const SECTION_NAMES: Record<string, string> = { new: "brand new", mine: "mine", others: "assigned to someone else" };

export function parseConversationList(html: string): ConversationList {
  const root = parseHtml(html);
  const rows: ConversationRow[] = [];
  for (const li of root.querySelectorAll('li[id^="ts_conversation_"]')) {
    const link = li.querySelector("a.record-row") ?? li.querySelector('a[href*="/conversations/"]');
    const href = link?.getAttribute("href") ?? "";
    const slug = decodeURIComponent(/\/conversations\/([^/?#]+)/.exec(href)?.[1] ?? "");
    const chips = li.querySelector(".rr-labels")?.querySelectorAll(".label") ?? [];
    const context = li.getAttribute("data-context");
    const cls = li.getAttribute("class") ?? "";
    rows.push({
      id: li.getAttribute("data-conversation-id") ?? li.getAttribute("id")!.replace("ts_conversation_", ""),
      slug,
      subject: squish(li.querySelector(".rr-subject")?.text ?? ""),
      with: li.querySelectorAll(".rr-contacts [title]").map((s) => squish(s.getAttribute("title") ?? s.text)),
      preview: squish(li.querySelector(".rr-body")?.text ?? ""),
      // Mailbox chips carry an inbox icon; the rest are labels.
      mailboxes: chips.filter((c) => c.querySelector(".fa-inbox")).map(chipName),
      labels: chips.filter((c) => !c.querySelector(".fa-inbox")).map(chipName),
      assignees: li.querySelectorAll(".rr-assignments figure[aria-label]").map((f) => f.getAttribute("aria-label")!),
      messages: Number(li.querySelector(".rr-message-count")?.text.trim()) || null,
      status: squish(li.querySelector(".rr-status-icon .sr-only")?.text ?? "") || null,
      section: context ? (SECTION_NAMES[context] ?? context) : null,
      at: li.querySelector("time[datetime]")?.getAttribute("datetime") ?? null,
      flags: cls
        .split(/\s+/)
        .filter((c) => c.startsWith("rr-"))
        .map((c) => c.slice(3)),
    });
  }
  const next = root.querySelector('a[rel="next"]')?.getAttribute("href");
  const nextPage = next ? Number(new URL(next, "https://jelly.invalid").searchParams.get("page")) || null : null;
  return {
    rows: uniqueBy(rows, (r) => r.id),
    sections: root.querySelectorAll("section.inbox-section").map((s) => ({
      key: (s.getAttribute("id") ?? "").replace(/^inbox-|-section$/g, ""),
      title: squish(s.querySelector(".inbox-section-header")?.text ?? ""),
      shown: new Set(s.querySelectorAll('li[id^="ts_conversation_"]').map((li) => li.getAttribute("id"))).size,
    })),
    range: squish(root.querySelector('a.info-link[aria-label="Jump to most recent"]')?.text ?? "") || null,
    nextPage,
  };
}

export interface Filters {
  labels: Named[];
  /** Mailboxes by their slug in Jelly's URLs, e.g. { id: "haven", name: "Haven" }. */
  mailboxes: Named[];
  /** Teammates by membership id, plus "unassigned". */
  members: Named[];
}

/** The filter links in a list page's sidebar and menus: ?label_id=, ?mailbox=, ?membership_id= */
export function parseFilterLinks(html: string): Filters {
  const root = parseHtml(html);
  const collect = (param: string) =>
    uniqueBy(
      root
        .querySelectorAll(`a[href*="${param}="]`)
        .map((a) => ({
          id: new URL(a.getAttribute("href")!, "https://jelly.invalid").searchParams.get(param) ?? "",
          name: squish(a.text),
        }))
        .filter((l) => l.id && l.name),
      (l) => l.id,
    );
  return { labels: collect("label_id"), mailboxes: collect("mailbox"), members: collect("membership_id") };
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
