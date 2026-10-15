<h2 align="center" style="font-size: 52px; font-family: 'system-ui';">jelly-mcp</h2>
<p align="center">use your <a href="https://letsjelly.com">Jelly</a> inbox from Claude</p>

## setup

You need [Node.js](https://nodejs.org) 20 or newer, and Chrome.

```bash
git clone https://github.com/daaminashai/jelly-mcp
cd jelly-mcp
npm install
npm run setup
```

Setup shows you how to copy your Jelly login from Chrome, then adds jelly-mcp to Claude Code and Claude Desktop.
Restart Claude and ask something like _"what's unassigned in Haven?"_ or _"draft a reply to the venue question"_.

Logged out of Jelly later? Run `npm run login`; no need to restart Claude.

## what Claude can do

- **read**: your inbox and every other view, search, whole threads with internal notes, labels, saved replies and
  the team
- **act**: draft (and redo or discard drafts), send replies and new emails, add internal notes (with @mentions),
  archive, snooze, assign, label, move between mailboxes, bookmark, mark read, trash

Claude asks before anything that changes Jelly, and drafts replies for you to send unless you ask it to send. In
`.env`, `READ_ONLY=1` lets Claude only read, and `DRAFT_ONLY_NO_SEND=1` lets it draft but never send.

## keep it running (optional, macOS)

```bash
npm run service
```

Runs jelly-mcp all the time in the background instead of Claude starting it each time: it starts when you log in,
restarts by itself if it ever stops, and every Claude window shares it, so it's quicker. It only listens on your own
computer and needs a secret token that's kept in `.env`. `npm run service -- --status` shows how it's doing, and
`npm run service -- --uninstall` goes back to normal.

## how it works

It runs on your computer with your own Jelly login and does what the Jelly website does, so it can only do what you
can. Your login stays in `.env` in this folder. If you have a [Marmalade](https://github.com/hackclub/marmalade) key,
setup can add it too, for date-range questions and the team list.

To remove it from Claude: `npm run setup -- --uninstall`.
