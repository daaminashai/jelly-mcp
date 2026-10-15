// What the MCP tools do in Jelly, built from the pages and forms a person would
// use. Reads GET pages; every change submits the same form the matching button
// submits, so Jelly applies its own rules (permissions, signatures, archiving).
import { composeHtmlBody, escapeHtml, textToHtml } from "../html.js";
import { JellyClient, JellyError, JellySendError, type Fields } from "./client.js";
import {
  actionTail,
  csrfToken,
  fieldValue,
  parseConversationList,
  parseConversationPage,
  parseHtml,
  parseIdentity,
  parseFilterLinks,
  parseMessageForm,
  parseSavedReplies,
  quoted,
  type ConversationList,
  type ConversationPage,
  type Filters,
  type Identity,
  type MessageForm,
  type Named,
  type PageForm,
  type SavedReply,
} from "./pages.js";

export const VIEWS = ["inbox", "all", "snoozed", "sent", "drafts", "scheduled", "bookmarks", "spam", "trash"] as const;
export type View = (typeof VIEWS)[number];

/** The filters Jelly's list pages share, by name; resolved to Jelly's ids before use. */
export interface ListFilters {
  page?: number;
  label?: string;
  mailbox?: string;
  /** A teammate's name, "me", or "unassigned". */
  assignee?: string;
  status?: "inbox" | "archived" | "spam" | "trash";
  unread?: boolean;
  following?: boolean;
  sort?: "newest" | "oldest";
}

/** Accepts a slug, a numeric id, or any Jelly link to the conversation. */
export function conversationRef(input: string): string {
  const trimmed = input.trim();
  const match = /\/conversations\/([^/?#\s]+)/.exec(trimmed);
  const ref = match ? decodeURIComponent(match[1]!) : trimmed.replace(/[?#].*$/, "");
  if (!ref || /\s|\//.test(ref)) throw new JellyError(`"${input}" isn't a Jelly conversation (use its link, slug or id)`);
  return ref;
}

export interface ReplyOptions {
  text: string;
  /** Public id (msg-…) of the message to answer; the latest one by default. */
  replyTo?: string;
  /** Refuse unless this is still the latest message (it changed means someone else wrote). */
  expectLatest?: string;
  cc?: string[];
  bcc?: string[];
  /** Archive after sending. Left out, Jelly's own default for the reply box applies. */
  archive?: boolean;
  /** Send even if someone has an unsent draft open in the conversation. */
  allowOpenDrafts?: boolean;
}

export interface ComposeOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  /** Mailbox name or id, e.g. "Haven". */
  mailbox?: string;
  /** Sending address, or part of it, e.g. "haven@hackclub.com". */
  from?: string;
  archive?: boolean;
}

export interface ConversationChanges {
  archive?: boolean;
  trash?: boolean;
  spam?: boolean;
  /** "later_today" | "tomorrow_morning" | "next_week" | an ISO time; null wakes it up. */
  snooze?: string | null;
  bookmark?: boolean;
  follow?: boolean;
  read?: boolean;
  assign?: string[];
  unassign?: string[];
  addLabels?: string[];
  removeLabels?: string[];
  addMailboxes?: string[];
  removeMailboxes?: string[];
  moveToMailbox?: string;
  /** A new subject; "" goes back to the original. */
  subject?: string;
}

const LOCK_NOTE =
  " (Jelly may show it as being edited for a few minutes; if so, press Edit draft there to take it over.)";

export class Jelly {
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(readonly client: JellyClient) {}

  link(path: string): string {
    return this.client.absolute(path);
  }

  conversationUrl(slug: string): string {
    return this.client.absolute(this.client.conversationPath(slug));
  }

  // ---------- reads ----------

  /** Opening a conversation marks it read for you, as in the browser. */
  async conversation(input: string): Promise<ConversationPage> {
    const { body, url } = await this.client.get(this.client.conversationPath(conversationRef(input)));
    return parseConversationPage(body, url);
  }

  async list(view: View, filters: ListFilters = {}): Promise<ConversationList> {
    const params = await this.filterParams(filters);
    const { body } = await this.client.get(this.client.teamPath(`/${view}${params.size ? `?${params}` : ""}`));
    return parseConversationList(body);
  }

  async search(q: string, filters: ListFilters & { includeSpamTrash?: boolean } = {}): Promise<ConversationList> {
    const params = await this.filterParams(filters);
    params.set("q", q);
    if (filters.includeSpamTrash) params.set("include_spam_trash", "1");
    const { body } = await this.client.get(this.client.teamPath(`/search?${params}`));
    return parseConversationList(body);
  }

  /** Labels, mailboxes and teammates as Jelly's filter links name them. */
  async filters(): Promise<Filters> {
    return (await this.inboxFacts()).filters;
  }

  /** Who you are and the filter links, both read off the inbox page and kept for a while. */
  private inboxFacts(): Promise<{ me: Identity | null; filters: Filters }> {
    return this.cached("inbox", async () => {
      const { body } = await this.client.get(this.client.teamPath("/inbox"));
      return { me: parseIdentity(parseHtml(body)), filters: parseFilterLinks(body) };
    });
  }

  private async filterParams(f: ListFilters): Promise<URLSearchParams> {
    const params = new URLSearchParams();
    if (f.label || f.mailbox || f.assignee) {
      const known = await this.filters();
      const pick = (kind: keyof Filters, wanted: string, me?: string) => {
        const target = /^(me|myself)$/i.test(wanted) && me ? me : wanted;
        const found = known[kind].find((x) => x.id === target || same(x.name, target));
        const noun = { labels: "label", mailboxes: "mailbox", members: "teammate" }[kind];
        if (!found) throw new JellyError(`No ${noun} "${wanted}". Known: ${known[kind].map((x) => x.name).join(", ")}`);
        return found.id;
      };
      if (f.label) params.set("label_id", pick("labels", f.label));
      if (f.mailbox) params.set("mailbox", pick("mailboxes", f.mailbox));
      if (f.assignee) {
        // Your own filter is labelled "Mine" rather than with your name.
        const mine = known.members.find((m) => same(m.name, "Mine"));
        const isMe = /^(me|myself|mine)$/i.test(f.assignee);
        params.set(
          "membership_id",
          /^unassigned$/i.test(f.assignee)
            ? "unassigned"
            : isMe && mine
              ? mine.id
              : pick("members", f.assignee, isMe ? (await this.identity()).name : undefined),
        );
      }
    }
    if (f.status) params.set("status", f.status);
    if (f.unread) params.set("unread", "1");
    if (f.following) params.set("following", "1");
    if (f.sort) params.set("sort", f.sort);
    if (f.page && f.page > 1) params.set("page", String(f.page));
    return params;
  }

  /** A message's original email, headers and all. */
  async rawMessage(messageId: string): Promise<string> {
    if (!/^msg-[\w-]+$/.test(messageId)) throw new JellyError(`"${messageId}" isn't a message id (they look like msg-…)`);
    const { body } = await this.client.get(this.client.teamPath(`/messages/${messageId}/raw`), "text/plain");
    return body;
  }

  async identity(): Promise<Identity> {
    const { me } = await this.inboxFacts();
    if (!me) throw new JellyError("Couldn't tell who is logged in to Jelly");
    return me;
  }

  async labels(): Promise<Named[]> {
    return (await this.filters()).labels.filter((l) => /^\d+$/.test(l.id));
  }

  /** The new-email form: sending addresses, mailboxes, signature and saved replies. */
  async composeForm(): Promise<{ form: MessageForm; savedReplies: SavedReply[]; csrf: string }> {
    const { body } = await this.client.get(this.client.teamPath("/conversations/new"));
    return { form: parseMessageForm(body), savedReplies: parseSavedReplies(body), csrf: csrfToken(parseHtml(body)) };
  }

  // ---------- replies and new email ----------

  /** Opens a reply draft in Jelly (with signature and quote filled in) and either sends it or leaves it saved. */
  async reply(input: string, o: ReplyOptions, mode: "send" | "draft"): Promise<{ page: ConversationPage; detail: string }> {
    const page = await this.conversation(input);
    const latest = page.timeline.filter((t) => t.kind === "message").at(-1);
    if (o.expectLatest && latest?.messageId !== o.expectLatest) {
      throw new JellySendError(
        `Nothing ${mode === "send" ? "sent" : "saved"}: the latest message is now ${latest?.messageId ?? "unknown"}, not ${o.expectLatest}. Read the conversation again.`,
        false,
      );
    }
    if (page.drafts > 0 && !o.allowOpenDrafts) {
      throw new JellySendError(
        `Nothing ${mode === "send" ? "sent" : "saved"}: someone has an unsent draft open in this conversation. Check it in Jelly, or pass allow_open_drafts.`,
        false,
      );
    }
    const target = o.replyTo ? page.messageReplies.get(o.replyTo) : page.reply;
    if (!target) {
      throw new JellySendError(
        o.replyTo ? `No message ${o.replyTo} to reply to in this conversation` : "This conversation has no Reply button in Jelly",
        false,
      );
    }
    const referer = this.client.conversationPath(page.slug);
    const open = new URL(target.action, this.client.baseUrl);
    open.searchParams.set("timezone", this.client.timezone);
    open.searchParams.set("include_quote", "true");
    const opened = await this.client.submit(open.pathname + open.search, [["authenticity_token", page.csrfToken]], {
      csrf: page.csrfToken,
      frame: target.frame,
      referer,
    });
    const form = parseMessageForm(opened.body);
    const fields = withBody(form.fields, o.text);
    appendAddresses(fields, "message[cc]", o.cc);
    appendAddresses(fields, "message[bcc]", o.bcc);

    if (mode === "draft") {
      const released = await this.saveDraft(form, fields, page.csrfToken, referer);
      return { page, detail: `Reply saved as a draft in Jelly for review: ${this.conversationUrl(page.slug)}${released ? "" : LOCK_NOTE}` };
    }

    if (o.archive === true) setField(fields, "archive_conversation", "true");
    if (o.archive === false) removeField(fields, "archive_conversation");
    if (!fields.some(([n]) => n === "_method")) fields.unshift(["_method", "patch"]);
    setField(fields, "message[schedule_sending_at]", "");
    setField(fields, "button", "");
    await this.client.submit(form.action, fields, { csrf: page.csrfToken, frame: target.frame, referer, sends: true });
    const archived = fields.some(([n, v]) => n === "archive_conversation" && v === "true");
    return { page, detail: `Reply sent${archived ? " and the conversation archived" : ""}: ${this.conversationUrl(page.slug)}` };
  }

  async compose(o: ComposeOptions, mode: "send" | "draft"): Promise<string> {
    const { form, csrf } = await this.composeForm();
    const mailbox = pickMailbox(form, o);
    const from = pickFrom(form, mailbox, o.from);
    const fields = withBody(form.fields, o.text);
    setField(fields, "message[to]", o.to.join(", "));
    setField(fields, "message[cc]", (o.cc ?? []).join(", "));
    appendAddresses(fields, "message[bcc]", o.bcc);
    setField(fields, "message[subject]", o.subject);
    setField(fields, "message[mailbox_id]", mailbox.id);
    setField(fields, "message[from]", from.value);
    const referer = this.client.teamPath("/conversations/new");

    if (mode === "draft") {
      if (!form.draftCreateUrl) throw new JellyError("Jelly's compose form has no draft address");
      const created = await this.client.submit(form.draftCreateUrl, fields, { csrf, referer, accept: "application/json" });
      let data: { draftReleaseUrl?: string; draftLockToken?: string; conversationId?: string | number };
      try {
        data = JSON.parse(created.body);
      } catch {
        throw new JellyError("Jelly didn't confirm the draft was saved");
      }
      const released = await this.releaseDraft(data.draftReleaseUrl ?? null, data.draftLockToken ?? null, csrf);
      return `Draft saved in Jelly from ${from.label}: ${this.link(this.client.teamPath("/drafts"))}${released ? "" : LOCK_NOTE}`;
    }

    if (o.archive) setField(fields, "archive_conversation", "true");
    setField(fields, "message[schedule_sending_at]", "");
    setField(fields, "button", "");
    const sent = await this.client.submit(form.action, fields, { csrf, referer, sends: true });
    const where = sent.location && /\/conversations\//.test(sent.location) ? `: ${sent.location}` : "";
    return `Email sent from ${from.label}${where}`;
  }

  /** Autosaves the reply into its draft (as the editor does) and lets go of the edit lock. */
  private async saveDraft(form: MessageForm, fields: Fields, csrf: string, referer: string): Promise<boolean> {
    if (!form.draftUpdateUrl) {
      throw new JellyError("Jelly's reply box didn't say where to save the draft; an empty reply draft may be left open");
    }
    const body = fields.filter(([n]) => n !== "_method" && n !== "button");
    await this.client.submit(form.draftUpdateUrl, body, { csrf, method: "PUT", referer });
    return this.releaseDraft(form.draftReleaseUrl, form.draftLockToken, csrf);
  }

  /** Lets go of the draft's edit lock (DELETE /drafts/<id>/release), so a person can open it. */
  private async releaseDraft(url: string | null, lockToken: string | null, csrf: string): Promise<boolean> {
    if (!url || !lockToken) return false;
    try {
      await this.client.submit(url, [["_method", "delete"], ["draft_lock_token", lockToken]], { csrf });
      return true;
    } catch {
      return false; // the lock lapses on its own soon after
    }
  }

  // ---------- notes ----------

  /** An internal comment only the team sees. "@Name" mentions a teammate, as typing @ in Jelly does. */
  async addNote(input: string, text: string): Promise<ConversationPage> {
    const page = await this.conversation(input);
    const form = this.pageForm(page, (f, tail) => tail === "/notes" && f.method === "post");
    if (!form) throw new JellyError("This conversation has no comment box in Jelly");
    const mentions = [...page.mentions].sort((a, b) => b.name.length - a.name.length);
    const html = textToHtml(text, (escaped) => {
      if (!escaped.includes("@")) return escaped;
      let out = escaped;
      for (const m of mentions) {
        const re = new RegExp(`@${escapeRegExp(escapeHtml(m.name))}(?![\\w])`, "gi");
        out = out.replace(
          re,
          `<action-text-attachment sgid="${escapeHtml(m.sgid)}" content-type="application/octet-stream"><span class="note-mention">${escapeHtml(m.name)}</span></action-text-attachment>`,
        );
      }
      return out;
    });
    const fields = form.fields.filter(([n]) => n !== "note[attachments][]");
    setField(fields, "note[body]", html);
    await this.client.submit(form.action, fields, { csrf: page.csrfToken, referer: this.client.conversationPath(page.slug) });
    return page;
  }

  // ---------- state changes ----------

  /** Applies each change with the button Jelly shows for it; reports what happened to each. */
  async update(input: string, changes: ConversationChanges): Promise<{ page: ConversationPage; results: string[] }> {
    const page = await this.conversation(input);
    const results: string[] = [];
    const csrf = page.csrfToken;
    const referer = this.client.conversationPath(page.slug);
    const submit = async (form: PageForm, extra: Fields = [], query?: Record<string, string>) => {
      const url = new URL(form.action, this.client.baseUrl);
      for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
      const fields = [...form.fields];
      for (const [k, v] of extra) setField(fields, k, v);
      await this.client.submit(url.pathname + url.search, fields, { csrf, referer });
    };
    const find = (pred: (f: PageForm, tail: string) => boolean) => this.pageForm(page, pred);
    const toggle = async (path: RegExp, on: boolean, done: [string, string], already: [string, string]) => {
      const form = find((f, tail) => path.test(tail) && (on ? f.method === "post" : f.method === "delete"));
      if (!form) return results.push(on ? already[0] : already[1]);
      await submit(form);
      results.push(on ? done[0] : done[1]);
    };

    if (changes.subject !== undefined) {
      const form = find((f) => /^edit_conversation_\d+$/.test(f.id ?? ""));
      if (!form) results.push("subject: no rename box on this conversation");
      else {
        await submit(form, [["conversation[custom_subject]", changes.subject]]);
        results.push(changes.subject ? `renamed to "${changes.subject}"` : "subject reset to the original");
      }
    }

    for (const name of changes.assign ?? []) {
      const form = matchNamed(
        page.forms.filter((f) => actionTail(f.action, referer) === "/assignments" && fieldValue(f, "assignee_id")),
        name,
        (f) => assigneeName(f, page),
        page.me?.name,
      );
      if (!form) results.push(`assign ${name}: no such teammate in this conversation's mailboxes (or already assigned)`);
      else {
        await submit(form);
        results.push(`assigned ${assigneeName(form, page)}`);
      }
    }
    for (const name of changes.unassign ?? []) {
      const form = matchNamed(
        page.forms.filter((f) => /^\/assignments\/\d+$/.test(actionTail(f.action, referer)) && f.method === "delete"),
        name,
        (f) => unassignName(f, page),
        page.me?.name,
      );
      if (!form) results.push(`unassign ${name}: not assigned`);
      else {
        await submit(form);
        results.push(`unassigned ${unassignName(form, page)}`);
      }
    }

    for (const name of changes.addLabels ?? []) {
      const form = matchNamed(
        page.forms.filter((f) => actionTail(f.action, referer) === "/conversation_labels" && f.method === "post"),
        name,
        (f) => quoted(f.label) ?? f.label,
      );
      if (!form) {
        results.push(
          page.state.labels.some((l) => same(l, name)) ? `label ${name}: already on it` : `label ${name}: no such label`,
        );
      } else {
        await submit(form);
        results.push(`label "${quoted(form.label)}" added`);
      }
    }
    for (const name of changes.removeLabels ?? []) {
      const form = matchNamed(
        page.forms.filter((f) => /^\/conversation_labels\/\d+$/.test(actionTail(f.action, referer)) && f.method === "delete"),
        name,
        (f) => quoted(f.label) ?? quoted(f.confirm) ?? f.label,
      );
      if (!form) results.push(`label ${name}: not on this conversation`);
      else {
        await submit(form);
        results.push(`label "${quoted(form.label) ?? name}" removed`);
      }
    }

    const mailboxForms = page.forms.filter((f) => actionTail(f.action, referer) === "/conversation_mailboxes" && f.method === "post");
    const isMove = (f: PageForm) => fieldValue(f, "replace_default") === "true" || /^move/i.test(f.label);
    for (const name of changes.addMailboxes ?? []) {
      const form = matchNamed(mailboxForms.filter((f) => !isMove(f)), name, (f) => quoted(f.label) ?? "");
      if (!form) results.push(`mailbox ${name}: already in it, or not a mailbox you can use`);
      else {
        await submit(form);
        results.push(`added to mailbox "${quoted(form.label)}"${warning(form)}`);
      }
    }
    if (changes.moveToMailbox) {
      const form = matchNamed(mailboxForms.filter(isMove), changes.moveToMailbox, (f) => quoted(f.label) ?? "");
      if (!form) results.push(`move to ${changes.moveToMailbox}: not a mailbox you can use`);
      else {
        await submit(form);
        results.push(`moved to mailbox "${quoted(form.label)}"${warning(form)}`);
      }
    }
    for (const name of changes.removeMailboxes ?? []) {
      const removers = page.forms.filter(
        (f) => /^\/conversation_mailboxes\/\d+$/.test(actionTail(f.action, referer)) && f.method === "delete",
      );
      const form = matchNamed(removers, name, (f) => quoted(f.confirm) ?? page.options.mailboxes.find((m) => f.action.endsWith(`/${m.id}`))?.name ?? "");
      if (!form) results.push(`mailbox ${name}: the conversation isn't in it`);
      else if (/must be in at least one mailbox/i.test(form.label)) results.push(`mailbox ${name}: a conversation must stay in at least one mailbox`);
      else {
        await submit(form);
        results.push(`removed from mailbox ${name}${warning(form)}`);
      }
    }

    if (changes.bookmark !== undefined) {
      await toggle(/^\/bookmarks?(\/\d+)?$/, changes.bookmark, ["bookmarked", "bookmark removed"], ["already bookmarked", "wasn't bookmarked"]);
    }
    if (changes.follow !== undefined) {
      const form = find((f, tail) => tail === (changes.follow ? "/subscribe" : "/unsubscribe"));
      if (!form) results.push(changes.follow ? "already following" : "wasn't following (or can't unfollow while assigned)");
      else {
        await submit(form);
        results.push(changes.follow ? "following" : "unfollowed");
      }
    }
    if (changes.read === false) {
      const form = find((f, tail) => tail === "/mark_unread");
      if (!form) results.push("mark unread: no button for it");
      else {
        await submit(form);
        results.push("marked unread (for you)");
      }
    }
    if (changes.read === true) {
      await this.bulk(page, "mark_as_read");
      results.push("marked read (for you)");
    }

    if (changes.snooze !== undefined) {
      if (changes.snooze === null) {
        await toggle(/^\/snooze$/, false, ["", "woken up (snooze removed)"], ["", "wasn't snoozed"]);
      } else {
        const until = snoozeTime(changes.snooze);
        const form = find((f, tail) => tail === "/snooze" && f.method === "post");
        if (!form) results.push("snooze: no snooze button on this conversation");
        else {
          await submit(form, [], { snooze_until: until.toISOString() });
          results.push(`snoozed until ${until.toISOString()}`);
        }
      }
    }

    if (changes.spam) {
      await this.bulk(page, "spam");
      results.push("reported as spam");
    }
    if (changes.trash !== undefined) {
      await toggle(/^\/trash$/, changes.trash, ["moved to trash", "restored from trash"], ["already in trash", "wasn't in trash"]);
    }
    if (changes.archive !== undefined) {
      await toggle(/^\/archive$/, changes.archive, ["archived", "unarchived (back in the inbox)"], ["already archived", "wasn't archived"]);
    }
    return { page, results };
  }

  private async bulk(page: ConversationPage, operation: string): Promise<void> {
    if (!page.id) throw new JellyError("Couldn't find this conversation's id in Jelly");
    await this.client.submit(
      this.client.teamPath("/bulk_action"),
      [["conversation_ids[]", page.id], ["operation", operation]],
      { csrf: page.csrfToken, referer: this.client.conversationPath(page.slug) },
    );
  }

  private pageForm(page: ConversationPage, pred: (f: PageForm, tail: string) => boolean): PageForm | undefined {
    const slugPath = this.client.conversationPath(page.slug);
    return page.forms.find((f) => pred(f, actionTail(f.action, slugPath)));
  }

  /** Shares one load between concurrent callers; a failed load isn't kept. */
  private cached<T>(key: string, load: () => Promise<T>, ttlMs = 10 * 60_000): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
    const value = load();
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }
}

// ---------- helpers ----------

function withBody(formFields: Fields, text: string): Fields {
  const fields = [...formFields];
  const prefilled = fields.find(([n]) => n === "message[html_body]")?.[1] ?? "";
  setField(fields, "message[html_body]", composeHtmlBody(text, prefilled));
  return fields;
}

export function setField(fields: Fields, name: string, value: string): void {
  const i = fields.findIndex(([n]) => n === name);
  if (i === -1) fields.push([name, value]);
  else fields[i] = [name, value];
}

function removeField(fields: Fields, name: string): void {
  for (let i = fields.length - 1; i >= 0; i--) if (fields[i]![0] === name) fields.splice(i, 1);
}

function appendAddresses(fields: Fields, name: string, extra: string[] | undefined): void {
  if (!extra?.length) return;
  const current = fields.find(([n]) => n === name)?.[1] ?? "";
  setField(fields, name, [current, ...extra].map((s) => s.trim()).filter(Boolean).join(", "));
}

function pickMailbox(form: MessageForm, o: ComposeOptions): { id: string; name: string } {
  const options = form.mailboxOptions;
  if (options.length === 0) throw new JellyError("Jelly's compose form lists no mailboxes for you");
  const wanted = o.mailbox?.trim();
  if (wanted) {
    const found = options.find((m) => m.id === wanted || same(m.name, wanted));
    if (!found) throw new JellyError(`No mailbox "${wanted}". Yours: ${options.map((m) => m.name).join(", ")}`);
    return found;
  }
  if (o.from) {
    const byFrom = options.find((m) => form.fromOptions.some((f) => f.label.includes(`(${m.name})`) && f.label.toLowerCase().includes(o.from!.toLowerCase())));
    if (byFrom) return byFrom;
  }
  if (options.length === 1) return options[0]!;
  throw new JellyError(`Say which mailbox to send from: ${options.map((m) => m.name).join(", ")}`);
}

function pickFrom(form: MessageForm, mailbox: { name: string }, from: string | undefined): { value: string; label: string } {
  const options = form.fromOptions;
  if (from) {
    const found = options.find((f) => f.label.toLowerCase().includes(from.toLowerCase()) || f.value.toLowerCase().includes(from.toLowerCase()));
    if (!found) throw new JellyError(`No sending address matches "${from}". Yours: ${options.map((f) => f.label).join("; ")}`);
    return found;
  }
  const forMailbox = options.find((f) => f.label.includes(`(${mailbox.name})`));
  if (forMailbox) return forMailbox;
  const selected = options.find((f) => f.selected) ?? options[0];
  if (!selected) throw new JellyError("Jelly's compose form lists no sending addresses");
  return selected;
}

function assigneeName(form: PageForm, page: ConversationPage): string {
  const id = fieldValue(form, "assignee_id");
  return page.options.assignable.find((a) => a.id === id)?.name ?? form.label;
}

function unassignName(form: PageForm, page: ConversationPage): string {
  const who = (/^Unassign (.+?)( from this conversation)?$/i.exec(form.label)?.[1] ?? form.label).trim();
  return /^yourself$/i.test(who) ? (page.me?.name ?? "you") : who;
}

/** Exact (case-insensitive) match first, then a unique prefix/word match. "me" means you. */
function matchNamed<T>(items: T[], wanted: string, nameOf: (item: T) => string, me?: string): T | undefined {
  const target = /^(me|myself|yourself)$/i.test(wanted.trim()) && me ? me : wanted.trim();
  const exact = items.find((i) => same(nameOf(i), target));
  if (exact) return exact;
  const loose = items.filter((i) => {
    const name = nameOf(i).toLowerCase();
    return name.startsWith(target.toLowerCase()) || name.split(/\s+/).includes(target.toLowerCase());
  });
  return loose.length === 1 ? loose[0] : undefined;
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function warning(form: PageForm): string {
  return form.confirm ? ` (Jelly's note: ${form.confirm})` : "";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Jelly's snooze presets, worked out in local time as its snooze menu does. */
export function snoozeTime(value: string, now = new Date()): Date {
  const d = new Date(now);
  switch (value) {
    case "later_today":
      d.setHours(18, 0, 0, 0);
      return d > now ? d : new Date(now.getTime() + 4 * 3600_000);
    case "tomorrow_morning":
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d;
    case "next_week": {
      d.setDate(d.getDate() + ((8 - now.getDay()) % 7 || 7));
      d.setHours(9, 0, 0, 0);
      return d;
    }
    default: {
      const t = new Date(value);
      if (Number.isNaN(t.getTime())) {
        throw new JellyError(`Snooze needs later_today, tomorrow_morning, next_week or an ISO time, not "${value}"`);
      }
      if (t <= now) throw new JellyError(`Snooze time ${value} is in the past`);
      return t;
    }
  }
}
