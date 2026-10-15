import { describe, expect, it } from "vitest";
import {
  parseConversationList,
  parseConversationPage,
  parseFilterLinks,
  parseMessageForm,
  parseSavedReplies,
} from "../src/jelly/pages.js";
import { composePage, conversationPage, listPage, replyDraftStream } from "./fixtures.js";

const URL_ = "https://app.letsjelly.com/hack-club/conversations/help-with-venue";

describe("parseConversationPage", () => {
  it("reads state off the buttons the page offers", () => {
    const page = parseConversationPage(conversationPage(), URL_);
    expect(page).toMatchObject({ slug: "help-with-venue", id: "555", subject: "Help with venue", csrfToken: "page-csrf" });
    expect(page.state).toEqual({
      archived: false,
      trashed: false,
      snoozed: false,
      bookmarked: false,
      following: true,
      assignees: ["Pat Lee", "Sam Rivera"],
      labels: ["Urgent"],
      mailboxes: ["Haven"],
    });
    expect(page.options.assignable).toEqual([
      { id: "12", name: "Alex Kim" },
      { id: "13", name: "Alexandra Wu" },
    ]);
    expect(page.options.mailboxes).toEqual([
      { id: "31", name: "Horizons" },
      { id: "30", name: "Haven" },
    ]);
    expect(page.me?.name).toBe("Pat Lee");
  });

  it("knows archived, bookmarked, snoozed and open drafts", () => {
    const page = parseConversationPage(conversationPage({ archived: true, bookmarked: true, snoozed: true, drafts: true }), URL_);
    expect(page.state).toMatchObject({ archived: true, bookmarked: true, snoozed: true });
    expect(page.drafts).toBeGreaterThan(0);
  });

  it("keeps emails and internal notes in order, with message ids", () => {
    const page = parseConversationPage(conversationPage(), URL_);
    expect(page.timeline.map((t) => [t.kind, t.id, t.messageId])).toEqual([
      ["message", "100", "msg-aaa"],
      ["note", "7", null],
      ["message", "101", "msg-bbb"],
    ]);
    expect(page.timeline[0]!.text).toBe("Date: 2026-10-01T10:00:00Z\nDirection: Inbound\nFrom: Jo <jo@example.com>\nBody:\nCan we use the gym?");
    expect(page.reply).toMatchObject({ frame: "message-form-101", latestId: "101" });
    expect([...page.messageReplies.keys()]).toEqual(["msg-aaa", "msg-bbb"]);
    expect(page.mentions).toEqual([
      { name: "Pat Lee", sgid: "sgid-pat" },
      { name: "Sam Rivera", sgid: "sgid-sam" },
    ]);
  });
});

describe("parseMessageForm", () => {
  it("finds the reply draft's form, autosave address and lock", () => {
    const form = parseMessageForm(replyDraftStream());
    expect(form.action).toBe("/hack-club/conversations/help-with-venue/messages/msg-draft1");
    expect(form).toMatchObject({ draftUpdateUrl: "/hack-club/drafts/k1", draftReleaseUrl: "/hack-club/drafts/k1/release", draftLockToken: "lock-1" });
    expect(form.fields.find(([n]) => n === "message[html_body]")?.[1]).toContain('<div class="jelly-signature">Pat</div>');
    expect(form.fields.some(([n]) => n === "archive_conversation")).toBe(false);
  });

  it("reads the compose form's addresses and mailboxes", () => {
    const form = parseMessageForm(composePage());
    expect(form.action).toBe("/hack-club/messages");
    expect(form.draftCreateUrl).toBe("/hack-club/drafts");
    expect(form.fromOptions.map((f) => f.label)).toEqual([
      "Pat Lee (Ambassadors) <ambassadors@example.org>",
      "Pat Lee (Haven) <haven@example.org>",
    ]);
    expect(form.mailboxOptions).toEqual([
      { id: "29", name: "Ambassadors", selected: true },
      { id: "30", name: "Haven", selected: false },
    ]);
    expect(form.fields.filter(([n]) => n === "subscriber_ids[]")).toEqual([["subscriber_ids[]", "1"]]);
  });

  it("reads saved replies", () => {
    expect(parseSavedReplies(composePage())).toEqual([
      { id: "5", name: "Venue FAQ", html: '<div>Hi there,<br></div><div>See <a href="https://example.org/venues">our venue guide</a>.</div>' },
    ]);
  });
});

describe("parseConversationList", () => {
  it("reads rows once each, with sections, mailboxes vs labels, and paging", () => {
    const list = parseConversationList(listPage());
    expect(list.rows.map((r) => r.slug)).toEqual(["first-one", "second-one"]);
    expect(list.rows[0]).toMatchObject({
      id: "1",
      subject: "Subject 1",
      with: ["Jo <jo@example.com>"],
      mailboxes: ["Haven"],
      labels: ["Visas"],
      messages: 3,
      status: "Your team replied last",
      section: "brand new",
      flags: ["unread", "unclaimed"],
    });
    expect(list.rows[1]!.assignees).toEqual(["Pat Lee"]);
    expect(list.sections).toEqual([
      { key: "brand-new", title: "Brand new (40)", shown: 1 },
      { key: "mine", title: "Mine", shown: 1 },
    ]);
    expect(list).toMatchObject({ range: "1-25 of 60", nextPage: 2 });
  });

  it("finds the filter links", () => {
    expect(parseFilterLinks(listPage())).toEqual({
      labels: [
        { id: "7", name: "Visas" },
        { id: "unlabeled", name: "Unlabeled" },
      ],
      mailboxes: [{ id: "haven", name: "Haven" }],
      members: [
        { id: "21", name: "Pat Lee" },
        { id: "unassigned", name: "Unassigned" },
      ],
    });
  });
});
