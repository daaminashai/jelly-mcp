import { describe, expect, it } from "vitest";
import { JellyClient, JellySendError, JellySessionError } from "../src/jelly/client.js";
import { conversationRef, Jelly, snoozeTime } from "../src/jelly/service.js";
import { checkJellyLogin } from "../src/login.js";
import { composePage, conversationPage, fakeJelly, listPage, redirect, replyDraftStream, type Call } from "./fixtures.js";

const CONV = "/hack-club/conversations/help-with-venue";

function jellyWith(routes: Parameters<typeof fakeJelly>[0]) {
  const fake = fakeJelly(routes);
  const client = new JellyClient({
    baseUrl: "https://app.letsjelly.com",
    team: "hack-club",
    cookie: "current_user_session_token=abc; _jelly_session=s1",
    timezone: "Asia/Kolkata",
    fetch: fake.fetch,
  });
  return { jelly: new Jelly(client), calls: fake.calls };
}

const field = (call: Call | undefined, name: string) => call?.fields.filter(([n]) => n === name).map(([, v]) => v);
const posts = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

describe("conversationRef", () => {
  it("takes slugs, ids and links", () => {
    expect(conversationRef("help-with-venue")).toBe("help-with-venue");
    expect(conversationRef("1045092")).toBe("1045092");
    expect(conversationRef("https://app.letsjelly.com/hack-club/conversations/venue-issues#note_61006")).toBe("venue-issues");
    expect(() => conversationRef("not a slug")).toThrow();
  });
});

describe("reply", () => {
  const routes = (archiveChecked = false) => ({
    [`GET ${CONV}`]: () => conversationPage(),
    "POST /hack-club/drafts/reply": () => replyDraftStream({ archiveChecked }),
    "POST /hack-club/conversations/help-with-venue/messages/msg-draft1": () => redirect(CONV, 303),
    "PUT /hack-club/drafts/k1": () => "<turbo-stream></turbo-stream>",
    "POST /hack-club/drafts/k1/release": () => "",
  });

  it("sends the way the Reply button does", async () => {
    const { jelly, calls } = jellyWith(routes(true));
    const { detail } = await jelly.reply("help-with-venue", { text: "Yes, the gym works.\nSee example.org", expectLatest: "msg-bbb", cc: ["dean@example.com"] }, "send");
    const [open, send] = posts(calls);
    expect(open!.path).toBe("/hack-club/drafts/reply?message%5Bconversation_id%5D=555&message%5Bprevious_message_id%5D=101&timezone=Asia%2FKolkata&include_quote=true");
    expect(open!.headers).toMatchObject({ "turbo-frame": "message-form-101", "x-csrf-token": "page-csrf" });
    expect(send!.path).toBe("/hack-club/conversations/help-with-venue/messages/msg-draft1");
    expect(field(send, "_method")).toEqual(["patch"]);
    expect(field(send, "draft_lock_token")).toEqual(["lock-1"]);
    expect(field(send, "message[cc]")).toEqual(["dean@example.com"]);
    expect(field(send, "message[html_body]")![0]).toBe(
      '<div>Yes, the gym works.</div><div>See <a href="https://example.org">example.org</a></div><div class="jelly-signature">Pat</div><div class="jelly-quote">q</div>',
    );
    // Jelly's own "archive after sending" box was ticked, so it stays.
    expect(field(send, "archive_conversation")).toEqual(["true"]);
    expect(detail).toContain("archived");
  });

  it("leaves the conversation open when asked", async () => {
    const { jelly, calls } = jellyWith(routes(true));
    await jelly.reply("help-with-venue", { text: "Hi", archive: false }, "send");
    expect(field(posts(calls)[1], "archive_conversation")).toEqual([]);
  });

  it("answers an earlier message when told to", async () => {
    const { jelly, calls } = jellyWith(routes());
    await jelly.reply("help-with-venue", { text: "Hi", replyTo: "msg-aaa" }, "send");
    expect(posts(calls)[0]!.path).toContain("previous_message_id%5D=msg-aaa");
    expect(posts(calls)[0]!.headers["turbo-frame"]).toBe("message-form-100");
  });

  it("refuses when a newer message arrived, before touching anything", async () => {
    const { jelly, calls } = jellyWith(routes());
    await expect(jelly.reply("help-with-venue", { text: "Hi", expectLatest: "msg-aaa" }, "send")).rejects.toThrow(/latest message is now msg-bbb/);
    expect(posts(calls)).toEqual([]);
  });

  it("refuses while a teammate has a draft open", async () => {
    const { jelly, calls } = jellyWith({ ...routes(), [`GET ${CONV}`]: () => conversationPage({ drafts: true }) });
    await expect(jelly.reply("help-with-venue", { text: "Hi" }, "send")).rejects.toThrow(/unsent draft open/);
    expect(posts(calls)).toEqual([]);
  });

  it("saves a draft instead of sending, then lets go of the edit lock", async () => {
    const { jelly, calls } = jellyWith(routes());
    const { detail } = await jelly.reply("help-with-venue", { text: "Draft text" }, "draft");
    const [, save, release] = posts(calls);
    expect(save!.method).toBe("PUT");
    expect(save!.path).toBe("/hack-club/drafts/k1");
    expect(field(save, "_method")).toEqual([]);
    expect(field(save, "button")).toEqual([]);
    expect(field(save, "message[html_body]")![0]).toMatch(/^<div>Draft text<\/div><div class="jelly-signature">/);
    expect(release!.path).toBe("/hack-club/drafts/k1/release");
    expect(field(release, "_method")).toEqual(["delete"]);
    expect(field(release, "draft_lock_token")).toEqual(["lock-1"]);
    expect(calls.some((c) => c.path.endsWith("/messages/msg-draft1"))).toBe(false);
    expect(detail).toContain("draft");
    expect(detail).not.toContain("being edited");
  });

  it("says so when Jelly wouldn't release the draft's lock", async () => {
    const { jelly } = jellyWith({ ...routes(), "POST /hack-club/drafts/k1/release": () => new Response("no", { status: 500 }) });
    const { detail } = await jelly.reply("help-with-venue", { text: "Draft text" }, "draft");
    expect(detail).toContain("Edit draft");
  });

  it("treats a failure after the send left as maybe sent", async () => {
    const { jelly } = jellyWith({
      ...routes(),
      "POST /hack-club/conversations/help-with-venue/messages/msg-draft1": () => new Response("boom", { status: 502 }),
    });
    const err = await jelly.reply("help-with-venue", { text: "Hi" }, "send").catch((e) => e);
    expect(err).toBeInstanceOf(JellySendError);
    expect(err.maybeSent).toBe(true);
  });
});

describe("compose", () => {
  const routes = {
    "GET /hack-club/conversations/new": () => composePage(),
    "POST /hack-club/messages": () => redirect("https://app.letsjelly.com/hack-club/conversations/hello-there", 303),
    "POST /hack-club/drafts": () =>
      new Response(JSON.stringify({ draftReleaseUrl: "/hack-club/drafts/k9/release", draftLockToken: "lock-9", conversationId: 77 }), {
        headers: { "content-type": "application/json" },
      }),
    "POST /hack-club/drafts/k9/release": () => "",
  };

  it("sends from the mailbox's own address", async () => {
    const { jelly, calls } = jellyWith(routes);
    const out = await jelly.compose({ to: ["jo@example.com"], subject: "Hello", text: "Hi Jo", mailbox: "haven", bcc: ["log@example.org"] }, "send");
    const send = posts(calls)[0]!;
    expect(send.path).toBe("/hack-club/messages");
    expect(field(send, "message[mailbox_id]")).toEqual(["30"]);
    expect(field(send, "message[from]")).toEqual(['"Pat Lee (Haven)" <haven@example.org>']);
    expect(field(send, "message[to]")).toEqual(["jo@example.com"]);
    expect(field(send, "message[bcc]")).toEqual(["team-bcc@example.org, log@example.org"]);
    expect(field(send, "message[html_body]")).toEqual(['<div>Hi Jo</div><div class="jelly-signature">Pat</div>']);
    expect(field(send, "authenticity_token")).toEqual(["form-token-compose"]);
    expect(out).toContain("/conversations/hello-there");
  });

  it("asks which mailbox when there are several", async () => {
    const { jelly } = jellyWith(routes);
    await expect(jelly.compose({ to: ["jo@example.com"], subject: "Hello", text: "Hi" }, "send")).rejects.toThrow(/Ambassadors, Haven/);
  });

  it("saves a draft as JSON and releases its lock", async () => {
    const { jelly, calls } = jellyWith(routes);
    await jelly.compose({ to: ["jo@example.com"], subject: "Hello", text: "Hi", from: "haven@" }, "draft");
    const [create, release] = posts(calls);
    expect(create!.path).toBe("/hack-club/drafts");
    expect(create!.headers.accept).toBe("application/json");
    expect(field(create, "message[mailbox_id]")).toEqual(["30"]);
    expect(field(release, "draft_lock_token")).toEqual(["lock-9"]);
  });
});

describe("notes", () => {
  it("turns @Full Name into a mention", async () => {
    const { jelly, calls } = jellyWith({ [`GET ${CONV}`]: () => conversationPage(), [`POST ${CONV}/notes`]: () => redirect(CONV) });
    await jelly.addNote("help-with-venue", "@sam rivera can you call them? cc @Pat Lee");
    const note = posts(calls)[0]!;
    expect(field(note, "note[body]")).toEqual([
      '<div><action-text-attachment sgid="sgid-sam" content-type="application/octet-stream"><span class="note-mention">Sam Rivera</span></action-text-attachment> can you call them? cc <action-text-attachment sgid="sgid-pat" content-type="application/octet-stream"><span class="note-mention">Pat Lee</span></action-text-attachment></div>',
    ]);
    expect(field(note, "note[attachments][]")).toEqual([]);
  });
});

describe("update", () => {
  const ok = () => redirect(CONV, 303);
  const routes = {
    [`GET ${CONV}`]: () => conversationPage(),
    [`POST ${CONV}`]: ok,
    [`POST ${CONV}/archive`]: ok,
    [`POST ${CONV}/assignments`]: ok,
    [`POST ${CONV}/assignments/901`]: ok,
    [`POST ${CONV}/conversation_labels`]: ok,
    [`POST ${CONV}/conversation_labels/88`]: ok,
    [`POST ${CONV}/conversation_mailboxes`]: ok,
    [`POST ${CONV}/snooze`]: ok,
    [`POST ${CONV}/bookmarks`]: ok,
    "POST /hack-club/bulk_action": ok,
  };

  it("uses each button's own form", async () => {
    const { jelly, calls } = jellyWith(routes);
    const { results } = await jelly.update("help-with-venue", {
      archive: true,
      assign: ["alex kim"],
      unassign: ["me"],
      addLabels: ["visas"],
      removeLabels: ["Urgent"],
      moveToMailbox: "Horizons",
      bookmark: true,
      spam: true,
      subject: "Venue: gym",
    });
    expect(results).toEqual([
      'renamed to "Venue: gym"',
      "assigned Alex Kim",
      "unassigned Pat Lee",
      'label "Visas" added',
      'label "Urgent" removed',
      'moved to mailbox "Horizons"',
      "bookmarked",
      "reported as spam",
      "archived",
    ]);
    const sent = posts(calls);
    expect(sent.map((c) => c.path)).toEqual([
      CONV,
      `${CONV}/assignments`,
      `${CONV}/assignments/901`,
      `${CONV}/conversation_labels`,
      `${CONV}/conversation_labels/88`,
      `${CONV}/conversation_mailboxes`,
      `${CONV}/bookmarks`,
      "/hack-club/bulk_action",
      `${CONV}/archive`,
    ]);
    expect(field(sent[0], "conversation[custom_subject]")).toEqual(["Venue: gym"]);
    expect(field(sent[1], "assignee_id")).toEqual(["12"]);
    expect(field(sent[2], "_method")).toEqual(["delete"]);
    expect(field(sent[5], "replace_default")).toEqual(["true"]);
    expect(field(sent[5], "mailbox_id")).toEqual(["31"]);
    expect(sent[7]!.fields).toEqual([["conversation_ids[]", "555"], ["operation", "spam"], ["authenticity_token", "page-csrf"]]);
    expect(field(sent[8], "_method")).toEqual([]);
  });

  it("says when there is nothing to do instead of guessing", async () => {
    const { jelly, calls } = jellyWith(routes);
    const { results } = await jelly.update("help-with-venue", {
      archive: false,
      assign: ["Alex"],
      addLabels: ["Nope"],
      removeMailboxes: ["Haven"],
    });
    expect(results).toEqual([
      "assign Alex: no such teammate in this conversation's mailboxes (or already assigned)",
      "label Nope: no such label",
      "mailbox Haven: a conversation must stay in at least one mailbox",
      "wasn't archived",
    ]);
    expect(posts(calls)).toEqual([]);
  });

  it("snoozes until a time, as the snooze menu does", async () => {
    const { jelly, calls } = jellyWith(routes);
    const until = new Date(Date.now() + 86_400_000).toISOString();
    await jelly.update("help-with-venue", { snooze: until });
    expect(posts(calls)[0]!.path).toBe(`${CONV}/snooze?snooze_until=${encodeURIComponent(until)}`);
  });
});

describe("lists", () => {
  it("turns filter names into Jelly's own query", async () => {
    const { jelly, calls } = jellyWith({ "GET /hack-club/inbox": () => listPage(), "GET /hack-club/all": () => listPage() });
    await jelly.list("all", { status: "inbox", assignee: "unassigned", mailbox: "haven", label: "visas", unread: true, page: 2 });
    expect(calls.at(-1)!.path).toBe("/hack-club/all?label_id=7&mailbox=haven&membership_id=unassigned&status=inbox&unread=1&page=2");
    await expect(jelly.list("inbox", { mailbox: "Nowhere" })).rejects.toThrow(/No mailbox "Nowhere". Known: Haven/);
  });
});

describe("session handling", () => {
  it("reports a dead login clearly", async () => {
    const { jelly } = jellyWith({ [`GET ${CONV}`]: () => redirect("https://app.letsjelly.com/login") });
    await expect(jelly.conversation("help-with-venue")).rejects.toBeInstanceOf(JellySessionError);
  });

  it("follows Jelly's redirect from an id to the slug, keeping rotated cookies", async () => {
    const { jelly, calls } = jellyWith({
      "GET /hack-club/conversations/555": () =>
        new Response(null, { status: 301, headers: { location: `https://app.letsjelly.com${CONV}`, "set-cookie": "_jelly_session=s2; path=/" } }),
      [`GET ${CONV}`]: () => conversationPage(),
    });
    const page = await jelly.conversation("555");
    expect(page.slug).toBe("help-with-venue");
    expect(calls[1]!.headers.cookie).toBe("current_user_session_token=abc; _jelly_session=s2");
  });
});

describe("checkJellyLogin", () => {
  it("finds your team from where Jelly sends you", async () => {
    const fake = fakeJelly({
      "GET /": () => redirect("https://app.letsjelly.com/some-team/inbox"),
      "GET /some-team/inbox": () => conversationPage(),
    });
    const { me, team } = await checkJellyLogin("current_user_session_token=abc", { fetch: fake.fetch });
    expect(team).toBe("some-team");
    expect(me.name).toBe("Pat Lee");
  });

  it("fails clearly when the login is dead", async () => {
    const fake = fakeJelly({ "GET /": () => redirect("https://app.letsjelly.com/login") });
    await expect(checkJellyLogin("current_user_session_token=old", { fetch: fake.fetch })).rejects.toThrow(/npm run login/);
  });
});

describe("snoozeTime", () => {
  const now = new Date(2026, 9, 15, 10, 30); // Thursday 10:30 local
  it("matches Jelly's presets", () => {
    expect(snoozeTime("later_today", now)).toEqual(new Date(2026, 9, 15, 18, 0));
    expect(snoozeTime("tomorrow_morning", now)).toEqual(new Date(2026, 9, 16, 9, 0));
    expect(snoozeTime("next_week", now)).toEqual(new Date(2026, 9, 19, 9, 0));
    expect(snoozeTime("later_today", new Date(2026, 9, 15, 19, 0))).toEqual(new Date(2026, 9, 15, 23, 0));
  });
  it("refuses times in the past and nonsense", () => {
    expect(() => snoozeTime("2020-01-01T00:00:00Z", now)).toThrow(/past/);
    expect(() => snoozeTime("soon", now)).toThrow();
  });
});
