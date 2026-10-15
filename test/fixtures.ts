// Small stand-ins for Jelly's pages with the same structure as the real ones
// (forms, thread items, rows), and no real people's mail.

const token = (n = "") => `<input type="hidden" name="authenticity_token" value="form-token${n}" />`;
const buttonTo = (action: string, label: string, extra = "", method?: string) =>
  `<form class="button_to" method="post" action="${action}">${method ? `<input type="hidden" name="_method" value="${method}" />` : ""}<button type="submit" title="${label}">${label}</button>${extra}${token()}</form>`;

export interface ConversationOptions {
  slug?: string;
  archived?: boolean;
  bookmarked?: boolean;
  drafts?: boolean;
  snoozed?: boolean;
}

export function conversationPage(o: ConversationOptions = {}): string {
  const slug = o.slug ?? "help-with-venue";
  const base = `/hack-club/conversations/${slug}`;
  return `<!doctype html><html><head><title>Help with venue · Hack Club · Jelly</title>
<meta name="csrf-token" content="page-csrf" />
<script type="application/json" id="posthog-identity">{"user":{"id":"1","properties":{"email":"me@example.org","name":"Pat Lee"}},"account":{"properties":{"name":"Club","plan":"Royal Jelly"}},"team":{"properties":{"name":"Club"}}}</script>
</head><body>
<form class="edit_conversation" id="edit_conversation_555" action="${base}" method="post"><input type="hidden" name="_method" value="patch" />${token()}<textarea name="conversation[custom_subject]"></textarea><input type="submit" name="commit" value="Save" /></form>
${buttonTo(`${base}/assignments/901`, "Unassign yourself from this conversation", "", "delete")}
${buttonTo(`${base}/assignments/902`, "Unassign Sam Rivera from this conversation", "", "delete")}
${buttonTo(`${base}/assignments`, "Assign this conversation to Alex Kim", '<input type="hidden" name="assignee_id" value="12" />')}
${buttonTo(`${base}/assignments`, "Assign this conversation to Alexandra Wu", '<input type="hidden" name="assignee_id" value="13" />')}
${o.archived ? buttonTo(`${base}/archive`, "Unarchive", "", "delete") : buttonTo(`${base}/archive`, "Archive")}
${buttonTo(`${base}/conversation_labels`, "Add “Visas” label to conversation", '<input type="hidden" name="label_id" value="7" />')}
${buttonTo(`${base}/conversation_labels/88`, "Remove “Urgent” label from conversation", "", "delete")}
${buttonTo(`${base}/conversation_mailboxes`, "Add to “Horizons” mailbox", '<input type="hidden" name="mailbox_id" value="31" />')}
${buttonTo(`${base}/conversation_mailboxes`, "Move to “Horizons” mailbox", '<input type="hidden" name="mailbox_id" value="31" /><input type="hidden" name="replace_default" value="true" />')}
${buttonTo(`${base}/conversation_mailboxes`, "Move to “Haven” mailbox", '<input type="hidden" name="mailbox_id" value="30" /><input type="hidden" name="replace_default" value="true" />')}
<form class="button_to" method="post" action="${base}/conversation_mailboxes/30" data-turbo-confirm="Removing this conversation from “Haven” will unassign Sam. Continue?"><input type="hidden" name="_method" value="delete" /><button type="submit" title="A conversation must be in at least one mailbox"></button>${token()}</form>
${buttonTo(`${base}/mark_unread`, "Mark as unread (for me)")}
${o.bookmarked ? buttonTo(`${base}/bookmarks/4`, "Remove bookmark", "", "delete") : buttonTo(`${base}/bookmarks`, "Bookmark (for me)")}
${o.snoozed ? buttonTo(`${base}/snooze`, "Unsnooze", "", "delete") : buttonTo(`${base}/snooze`, "Tomorrow 9 AM")}
${buttonTo(`${base}/trash`, "Delete")}
${buttonTo(`${base}/unsubscribe`, "Unfollow")}
<div class="thread-item ti-message opened inbound seen"><div id="ts_message_100"></div>
  <input type="hidden" name="ai_source" id="ai_source" value="Date: 2026-10-01T10:00:00Z&#10;Direction: Inbound&#10;From: Jo &lt;jo@example.com&gt;&#10;Body:&#10;Can we use the gym?" />
  <a href="/hack-club/messages/msg-aaa/raw">Raw</a>
  <form class="message-reply-button-form" method="post" action="/hack-club/drafts/reply?message%5Bconversation_id%5D=555&amp;message%5Bprevious_message_id%5D=msg-aaa"><button data-turbo-frame="message-form-100" type="submit" aria-label="Reply"></button>${token()}</form>
</div>
<div class="thread-item ti-note opened " id="ts_note_7">
  <input type="hidden" name="ai_source" id="ai_source" value="INTERNAL COMMENT&#10;By: Sam Rivera&#10;At: 2026-10-01T11:00:00Z&#10;Content:&#10;@Pat Lee can you take this?" />
</div>
<div class="thread-item ti-message opened reply seen"><div id="ts_message_101"></div>
  <input type="hidden" name="ai_source" id="ai_source" value="Date: 2026-10-01T12:00:00Z&#10;Direction: Outbound&#10;Body:&#10;Checking!" />
  <a href="/hack-club/messages/msg-bbb">Link</a>
  <form class="message-reply-button-form" method="post" action="/hack-club/drafts/reply?message%5Bconversation_id%5D=555&amp;message%5Bprevious_message_id%5D=msg-bbb"><button data-turbo-frame="message-form-101" type="submit" aria-label="Reply"></button>${token()}</form>
</div>
${o.drafts ? `<turbo-frame id="message-form-x" src="${base}/messages/msg-ccc/edit"></turbo-frame>` : ""}
<form class="note-form hidden" id="new_note" action="${base}/notes" method="post">${token()}<input type="hidden" name="note[body]" value="" /><input type="hidden" name="note[attachments][]" value="" /><button name="button" type="submit">Comment</button></form>
<ul class="note-mention-suggestion-list" hidden>
  <li role="option" data-name="pat lee" data-trix-attachment-sgid="sgid-pat"><span class="note-mention">Pat Lee</span></li>
  <li role="option" data-name="sam rivera" data-trix-attachment-sgid="sgid-sam"><span class="note-mention">Sam Rivera</span></li>
</ul>
<div id="ts_responder"><form class="button_to" method="post" action="/hack-club/drafts/reply?message%5Bconversation_id%5D=555&amp;message%5Bprevious_message_id%5D=101"><button data-turbo-frame="message-form-101" type="submit">Reply</button>${token()}</form></div>
</body></html>`;
}

/** The turbo-stream Jelly answers POST /drafts/reply with: the reply box, already a saved draft. */
export function replyDraftStream(o: { archiveChecked?: boolean } = {}): string {
  return `<turbo-stream action="replace" target="message-form-101"><template><turbo-frame id="message-form-101">
<form class="edit_message" action="/hack-club/conversations/help-with-venue/messages/msg-draft1" method="post"
  data-controller="reply" data-reply-draft-update-url-value="/hack-club/drafts/k1" data-reply-draft-release-url-value="/hack-club/drafts/k1/release" data-reply-draft-lock-token-value="lock-1">
<input type="hidden" name="_method" value="patch" />${token("-reply")}
<input type="hidden" name="draft_lock_token" value="lock-1" />
<input type="hidden" name="message[conversation_id]" value="555" />
<input type="text" name="message[to]" value="Jo &lt;jo@example.com&gt;" />
<input type="text" name="message[cc]" value="" />
<input type="text" name="message[bcc]" value="team-bcc@example.org" />
<input type="hidden" name="message[html_body]" value="&lt;br&gt;&#10;&lt;br&gt;&#10;&lt;div class=&quot;jelly-signature&quot;&gt;Pat&lt;/div&gt;&lt;div class=&quot;jelly-quote&quot;&gt;q&lt;/div&gt;" />
<input type="checkbox" name="archive_conversation" value="true" ${o.archiveChecked ? "checked" : ""} />
<input type="text" name="message[schedule_sending_at]" value="" />
<button name="button" type="submit">Send</button>
</form></turbo-frame></template></turbo-stream>`;
}

export function composePage(): string {
  return `<html><head><meta name="csrf-token" content="compose-csrf" /></head><body>
<form class="new_message" id="new_message" action="/hack-club/messages" method="post" data-controller="reply" data-reply-draft-create-url-value="/hack-club/drafts">
${token("-compose")}
<input type="hidden" name="message[conversation_id]" value="" />
<input type="text" name="message[to]" value="" />
<input type="text" name="message[cc]" value="" />
<input type="text" name="message[bcc]" value="team-bcc@example.org" />
<select name="message[from]">
  <option value="&quot;Pat Lee (Ambassadors)&quot; &lt;ambassadors@example.org&gt;" selected="selected">Pat Lee (Ambassadors) &lt;ambassadors@example.org&gt;</option>
  <option value="&quot;Pat Lee (Haven)&quot; &lt;haven@example.org&gt;">Pat Lee (Haven) &lt;haven@example.org&gt;</option>
</select>
<select name="message[mailbox_id]"><option value="29" selected="selected">Ambassadors</option><option value="30">Haven</option></select>
<input type="text" name="message[subject]" value="" />
<input type="hidden" name="message[html_body]" value="&lt;br&gt;&#10;&lt;br&gt;&#10;&lt;div class=&quot;jelly-signature&quot;&gt;Pat&lt;/div&gt;" />
<input type="checkbox" name="subscriber_ids[]" value="1" checked="checked" />
<input type="checkbox" name="subscriber_ids[]" value="2" />
<input type="checkbox" name="archive_conversation" value="true" />
<input type="text" name="message[schedule_sending_at]" value="" />
<button type="button" class="squire-saved-reply-option" data-action="squire-saved-reply#insertReply" data-reply-id="5"><strong>Venue FAQ</strong><small>Hi…</small><div id="saved-reply-content-5" class="hidden"><div>Hi there,<br></div><div>See <a href="https://example.org/venues">our venue guide</a>.</div></div></button>
<button name="button" type="submit">Send</button>
</form></body></html>`;
}

export function listPage(): string {
  const row = (id: string, slug: string, ctx: string, cls: string, chips: string, assignees = "") =>
    `<li id="ts_conversation_${id}" data-conversation-id="${id}" data-context="${ctx}" class="${cls}">
<a class="record-row rr-conversation" href="/hack-club/conversations/${slug}">
<div class="rr-contacts"><span title="Jo &lt;jo@example.com&gt;">Jo</span></div>
<div class="rr-status-icon"><span class="sr-only">Your team replied last</span></div>
<div class="rr-subject"> Subject ${id} </div><div class="rr-message-count">3</div>
<div class="rr-assignments">${assignees}</div>
<div class="rr-labels">${chips}</div><div class="rr-body"> Preview ${id} </div>
<time datetime="2026-10-0${id.slice(-1)}T00:00:00Z"></time></a>
<div class="rr-labels hidden-on-desktop">${chips}</div></li>`;
  const mailbox = (n: string) => `<div class="label" title="${n}"><span><i class="fa-regular fa-inbox"></i> ${n}</span></div>`;
  const label = (n: string) => `<div class="label" title="${n}"><span><i class="fa-solid fa-tag"></i> ${n}</span></div>`;
  return `<html><body>
<a href="/hack-club/inbox?label_id=7">Visas</a><a href="/hack-club/inbox?label_id=unlabeled">Unlabeled</a>
<a href="/hack-club/inbox?mailbox=haven"><i class="fa-inbox"></i> Haven</a>
<a href="/hack-club/inbox?membership_id=21">Pat Lee</a><a href="/hack-club/inbox?membership_id=unassigned">Unassigned</a>
<section class="inbox-section" id="inbox-brand-new-section"><h3 class="inbox-section-header"><button>Brand new (40)</button></h3><ul>
${row("1", "first-one", "new", "rr-unread rr-unclaimed", mailbox("Haven") + label("Visas"))}
</ul></section>
<section class="inbox-section" id="inbox-mine-section"><h3 class="inbox-section-header"><button>Mine</button></h3><ul>
${row("2", "second-one", "mine", "rr-assigned", mailbox("Haven"), '<figure aria-label="Pat Lee"></figure>')}
${row("2", "second-one", "mine", "rr-assigned", mailbox("Haven"))}
</ul></section>
<a class="info-link" aria-label="Jump to most recent" href="/hack-club/all?page=1">1-25 of 60</a>
<a href="/hack-club/all?page=2" rel="next" aria-label="Next">→</a>
</body></html>`;
}

export interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  fields: Array<[string, string]>;
}

/** A fetch that answers from a route table and records every request. */
export function fakeJelly(routes: Record<string, (call: Call) => Response | string>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      headers: (init?.headers ?? {}) as Record<string, string>,
      fields: init?.body ? [...new URLSearchParams(String(init.body))] : [],
    };
    calls.push(call);
    const key = Object.keys(routes).find((k) => {
      const [method, path] = k.split(" ");
      return method === call.method && (path === url.pathname || path === call.path);
    });
    if (!key) return new Response("not found", { status: 404 });
    const out = routes[key]!(call);
    return typeof out === "string" ? new Response(out, { status: 200, headers: { "content-type": "text/html" } }) : out;
  }) as typeof fetch;
  return { fetch: impl, calls };
}

export const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });
