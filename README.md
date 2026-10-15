<h2 align="center" style="font-size: 52px; font-family: 'system-ui';">jelly-mcp</h2>
<p align="center">your <a href="https://letsjelly.com">Jelly</a> inbox, inside Claude</p>
<p align="center">
 <img src="https://img.shields.io/badge/License-MIT-blue.svg">
 <img src="https://img.shields.io/badge/version-0.1.0-green.svg">
</p>

jelly-mcp is a [Model Context Protocol](https://modelcontextprotocol.io) server for Jelly, the shared inbox. Add it to
Claude and you can ask things like "what's still unanswered in Haven from this week?", "draft replies to the venue
questions", or "archive every sign-up confirmation and assign the rest to me".

It reads through [Marmalade](https://github.com/hackclub/marmalade) (Hack Club's read-only, audited mirror of Jelly)
and through your own Jelly login, and it acts through your Jelly login, the same way you would in the browser. It runs
on your computer; nothing goes anywhere but Jelly and Marmalade.

## what it can do

**reading**

| tool | what it does |
| --- | --- |
| `whoami` | who you're logged in as, your mailboxes and sending addresses, what Marmalade can read |
| `list_conversations` | the inbox, all, snoozed, sent, drafts, scheduled, bookmarks, spam or trash, with Jelly's filters (mailbox, assignee or unassigned, label, status, unread, following, oldest first) |
| `search_conversations` | Jelly's full-text search (`from:`, `"exact phrase"`, `@example.com`, `pdf`, `this week`, …) with the same filters |
| `list_mailbox_conversations` | Marmalade: a mailbox's conversations by status and date range |
| `get_conversation` | a whole thread, every email and internal note in order, plus status, mailboxes, labels and assignees |
| `get_message_source` | one email's raw source with all its headers |
| `list_labels`, `list_saved_replies`, `list_team` | labels, the team's saved replies (full text), and everyone on the team |

**doing**

| tool | what it does |
| --- | --- |
| `draft_reply` | writes a reply as a draft in Jelly, with your signature and the quoted email, for a person to check and send |
| `send_reply` | sends a reply, exactly like the Reply button |
| `draft_email` / `send_email` | starts a new conversation from one of your mailboxes |
| `add_note` | an internal comment; `@Full Name` mentions a teammate |
| `update_conversation` | archive or reopen, snooze, assign/unassign, labels, mailboxes, bookmark, follow, read/unread, rename, trash, spam. Takes up to 50 conversations at once |

Claude asks before every tool that changes something, unless you've told it not to.

## setting it up

You need Node 20 or newer.

```bash
npm install
npm run cookie   # with a "Copy as cURL" from Jelly on your clipboard, see below
npm run setup    # builds, checks both logins, and adds it to Claude Code and Claude Desktop
```

Then restart Claude Desktop, or start a new Claude Code session. Run `npm run check` any time to see if both logins
still work.

`npm run setup` adds the server for all your projects in Claude Code (user scope) and to Claude Desktop's
`claude_desktop_config.json`, pointing at this folder. `--no-code` or `--no-desktop` skips one; `--uninstall` removes it
from both. If you already have a `.env` for [pudding](https://github.com/daaminashai/pudding), `npm run setup -- --import
../pudding/.env` copies the Jelly login and Marmalade key from it.

### your Jelly login

1. Open [app.letsjelly.com](https://app.letsjelly.com) in Chrome, logged in.
2. Open DevTools → Network, reload, right-click the first request → Copy → **Copy as cURL**.
3. Run `npm run cookie`.

Only the two login cookies are kept, they're checked against Jelly, and they're saved to `.env` (readable only by you)
without being printed. When Jelly logs you out, tools say so; run `npm run cookie` again.

### Marmalade (optional)

Marmalade adds date and status queries over a mailbox and the team list. Create a key at
[marmalade.hackclub.com/keys](https://marmalade.hackclub.com/keys) and put it in `.env` as `MARMALADE_API_KEY`, with
`MARMALADE_MAILBOX` set to the mailbox you use most (e.g. `haven`). Without it, everything else still works, and when
Jelly can't be reached `get_conversation` falls back to Marmalade.

## careful by default

- **Draft first.** Claude is told to use `draft_reply` unless you asked it to send, so a person reads every reply in
  Jelly before it goes out.
- **No surprise sends.** `send_reply` won't send if someone has an unsent draft open in the conversation, or if a new
  message has arrived since Claude read it. If a send fails in a way where it might have gone out anyway, it says so
  instead of retrying.
- **Turn things off.** `JELLY_READ_ONLY=1` in `.env` hides every tool that changes anything. `JELLY_ALLOW_SEND=0` keeps
  drafting but hides the two send tools.
- **Secrets stay put.** The cookie and key never show up in tool output or errors.

Reading a conversation marks it read for you, the same as opening it in Jelly.

## how it works

Jelly has no API for people, so the server does what the browser does. It loads Jelly's pages with your cookie, reads
conversations from the plain-text version Jelly makes for AI ("copy for AI"), and makes changes by submitting the same
forms Jelly's buttons submit, with the page's CSRF token. Jelly applies its own rules, so you can only do what you
could do yourself. Replies go through Jelly's own reply box, so signatures, quoting, "from" addresses and the team Bcc
come out as usual.

Marmalade is read-only for API keys, so it's only used for reading.

## development

```bash
npm test          # unit tests against fake Jelly pages
npm run typecheck
npm run try       # lists the tools of the built server
npm run try -- get_conversation '{"conversation":"some-slug"}'
```

Settings are explained in [`.env.example`](.env.example).
