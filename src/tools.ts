import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { clip, formatConversation, formatList, formatMarmaladeConversation, formatMarmaladeRow } from "./format.js";
import { htmlToText } from "./html.js";
import { JellyError, JellySendError, JellySessionError } from "./jelly/client.js";
import { conversationRef, Jelly, VIEWS, type ConversationChanges } from "./jelly/service.js";
import { MarmaladeClient, MarmaladeError } from "./marmalade.js";
import { errorMessage } from "./redact.js";

export interface Deps {
  config: Config;
  jelly?: Jelly;
  marmalade?: MarmaladeClient;
}

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const SENDS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

const conversation = z
  .string()
  .min(1)
  .describe("The conversation: its slug (e.g. i-can-t-log-back-in), numeric id, or Jelly link");
const addresses = z.array(z.string().min(3)).describe("Email addresses");
const body = z
  .string()
  .min(1)
  .describe(
    "Plain text. Blank lines separate paragraphs; email addresses and URLs become links, and [words](https://…) links words. Your Jelly signature is added for you, so don't sign off with it.",
  );

export function registerTools(server: McpServer, deps: Deps): void {
  const { config } = deps;
  const needJelly = (): Jelly => {
    if (!deps.jelly) {
      throw new JellyError("This needs your Jelly login: run `npm run login` in the jelly-mcp folder, then restart Claude");
    }
    return deps.jelly;
  };
  const needMarmalade = (): MarmaladeClient => {
    if (!deps.marmalade) throw new JellyError("This needs MARMALADE_API_KEY in jelly-mcp's .env");
    return deps.marmalade;
  };

  // ---------- reads ----------

  server.registerTool(
    "whoami",
    {
      title: "Who am I in Jelly",
      description:
        "Who you're logged in to Jelly as, the mailboxes and addresses you can send from, which mailboxes Marmalade can read, and whether sending is enabled. Call this first to orient yourself.",
      annotations: READ,
    },
    () =>
      run(async () => {
        const lines: string[] = [];
        if (deps.jelly) {
          try {
            const me = await deps.jelly.identity();
            lines.push(`Jelly: ${me.name} <${me.email}> on team "${me.team}" (${deps.jelly.link(deps.jelly.client.teamPath(""))})`);
            const { form } = await deps.jelly.composeForm();
            lines.push(`Your mailboxes: ${form.mailboxOptions.map((m) => m.name).join(", ") || "none"}`);
            lines.push("You can send as:", ...form.fromOptions.map((f) => `  ${f.label}`));
          } catch (err) {
            lines.push(`Jelly: not connected (${errorMessage(err)})`);
          }
        } else lines.push("Jelly: no login configured (run `npm run login` in the jelly-mcp folder)");
        if (deps.marmalade) {
          try {
            const mailboxes = await deps.marmalade.listMailboxes();
            lines.push(
              `Marmalade can read: ${mailboxes.map((m) => `${m.jellyMailbox.jellyMailboxId} ("${m.jellyMailbox.name}")`).join(", ") || "no mailboxes"}`,
            );
            if (config.marmalade?.defaultMailbox) lines.push(`Default Marmalade mailbox: ${config.marmalade.defaultMailbox}`);
          } catch (err) {
            lines.push(`Marmalade: not reachable (${errorMessage(err)})`);
          }
        } else lines.push("Marmalade: not configured (MARMALADE_API_KEY)");
        lines.push(
          `Mode: ${config.readOnly ? "read-only (JELLY_READ_ONLY=1)" : config.allowSend ? "read, draft and send" : "read and draft (sending off: JELLY_ALLOW_SEND=0)"}`,
        );
        return lines.join("\n");
      }),
  );

  if (deps.jelly) {
    const filterInput = {
      mailbox: z.string().optional().describe("Only this mailbox (name, e.g. Haven)"),
      assignee: z.string().optional().describe('Only conversations assigned to this teammate (name, "me", or "unassigned")'),
      label: z.string().optional().describe("Only conversations with this label"),
      unread: z.boolean().optional().describe("Only ones unread by you"),
      following: z.boolean().optional().describe("Only ones you follow"),
      sort: z.enum(["newest", "oldest"]).optional(),
      page: z.number().int().min(1).default(1).describe("Page number (25 per page)"),
    };
    const filtersFrom = (a: { mailbox?: string; assignee?: string; label?: string; unread?: boolean; following?: boolean; sort?: "newest" | "oldest"; page: number; status?: "inbox" | "archived" | "spam" | "trash" }) => ({
      mailbox: a.mailbox,
      assignee: a.assignee,
      label: a.label,
      unread: a.unread,
      following: a.following,
      sort: a.sort,
      page: a.page,
      status: a.status,
    });
    const describe = (title: string, a: Record<string, unknown>) =>
      `${title}${Object.entries(a)
        .filter(([k, v]) => v !== undefined && v !== false && !(k === "page" && v === 1) && k !== "view" && k !== "query")
        .map(([k, v]) => ` · ${k}: ${v}`)
        .join("")}`;

    server.registerTool(
      "list_conversations",
      {
        title: "List conversations",
        description:
          "Lists conversations in one of Jelly's views, newest first, as in Jelly's sidebar, with Jelly's own filters. The inbox (open conversations) is grouped into brand new / mine / assigned to someone else and shows only the first 25 of a big section; view \"all\" pages through everything and takes a status. Each line starts with the slug to pass to other tools.",
        inputSchema: {
          view: z.enum(VIEWS).default("inbox").describe("Which view"),
          status: z.enum(["inbox", "archived", "spam", "trash"]).optional().describe("With view all: only open (inbox), archived, spam or trash"),
          ...filterInput,
        },
        annotations: READ,
      },
      (a) =>
        run(async () => {
          const list = await needJelly().list(a.view, filtersFrom(a));
          return formatList(describe(`Jelly ${a.view}`, a), list);
        }),
    );

    server.registerTool(
      "search_conversations",
      {
        title: "Search conversations",
        description:
          'Full-text search across every conversation you can see in Jelly: message and comment text, attachment names and labels. Supports "exact phrases", from:/to:/cc:/bcc: (also partial, e.g. from:jan), an address or @example.com for a whole domain, @name for comments mentioning someone, file types like pdf, and dates like today, yesterday, this week, last week, this month. Takes the same filters as list_conversations.',
        inputSchema: {
          query: z.string().min(1).describe("What to search for"),
          status: z.enum(["inbox", "archived", "spam", "trash"]).optional().describe("Only open (inbox), archived, spam or trash"),
          include_spam_trash: z.boolean().default(false).describe("Also search spam and trash"),
          ...filterInput,
        },
        annotations: READ,
      },
      (a) =>
        run(async () => {
          const list = await needJelly().search(a.query, { ...filtersFrom(a), includeSpamTrash: a.include_spam_trash });
          return formatList(describe(`Search "${a.query}"`, a), list);
        }),
    );
  }

  if (deps.marmalade) {
    server.registerTool(
      "list_mailbox_conversations",
      {
        title: "Query a mailbox (Marmalade)",
        description:
          "Lists a mailbox's conversations from Marmalade, the read-only mirror of Jelly, filtered by status and dates. Use it for questions like \"what came in last week\" or \"everything still open in Haven\". It only covers mailboxes the Marmalade key can read (see whoami) and only matches subjects; use search_conversations for full text.",
        inputSchema: {
          mailbox: z.string().optional().describe("Marmalade mailbox id, e.g. haven (defaults to the configured one)"),
          status: z.enum(["open", "archived"]).optional().describe("open = still in the inbox"),
          since: z.string().optional().describe("ISO date/time: only conversations with activity since then"),
          until: z.string().optional().describe("ISO date/time: and before then"),
          subject: z.string().optional().describe('Words in the subject; "quoted" for the exact subject'),
          sort_by: z.enum(["lastMessageAt", "createdAt", "updatedAt"]).default("lastMessageAt"),
          order: z.enum(["desc", "asc"]).default("desc"),
          limit: z.number().int().min(1).max(500).default(50),
        },
        annotations: READ,
      },
      (a) =>
        run(async () => {
          const marmalade = needMarmalade();
          const mailbox = await resolveMailbox(marmalade, a.mailbox ?? config.marmalade?.defaultMailbox);
          const rows = await marmalade.listConversations(mailbox, {
            status: a.status,
            search: a.subject,
            startDate: a.since ? isoDate(a.since) : undefined,
            endDate: a.until ? isoDate(a.until) : undefined,
            sortBy: a.sort_by,
            sortOrder: a.order,
          });
          const shown = rows.slice(0, a.limit);
          return [
            `Marmalade mailbox ${mailbox}: ${rows.length} conversation(s)${rows.length > shown.length ? `, first ${shown.length} shown` : ""}`,
            ...shown.map(({ conversation: c }) => formatMarmaladeRow(c)),
          ].join("\n");
        }),
    );
  }

  server.registerTool(
    "get_conversation",
    {
      title: "Read a conversation",
      description:
        "Reads a whole conversation: every email and internal note in order (with sender, recipients, date and attachment names), plus its status, mailboxes, labels, assignees and the latest message id. Opening it marks it read for you, as in the browser. Falls back to Marmalade when Jelly isn't reachable.",
      inputSchema: {
        conversation,
        max_chars_per_item: z.number().int().min(500).max(100_000).default(8000).describe("Cut each email or note after this many characters"),
      },
      annotations: READ,
    },
    ({ conversation: ref, max_chars_per_item }) =>
      run(async () => {
        let jellyError: unknown = null;
        if (deps.jelly) {
          try {
            const page = await deps.jelly.conversation(ref);
            return formatConversation(page, deps.jelly.conversationUrl(page.slug), max_chars_per_item);
          } catch (err) {
            if (!(err instanceof JellySessionError) || !deps.marmalade) throw err;
            jellyError = err;
          }
        }
        const marmalade = needMarmalade();
        const found = await findInMarmalade(marmalade, conversationRef(ref), config.marmalade?.defaultMailbox);
        const text = formatMarmaladeConversation(found.conversation, found.mailbox, max_chars_per_item);
        return jellyError ? `${errorMessage(jellyError)}\n\n${text}` : text;
      }),
  );

  if (deps.jelly) {
    server.registerTool(
      "get_message_source",
      {
        title: "Raw email source",
        description:
          "The original email of one message, with all headers (Message-ID, Reply-To, authentication results, etc.). Message ids (msg-…) come from get_conversation.",
        inputSchema: {
          message_id: z.string().regex(/^msg-[\w-]+$/).describe("The message's id, msg-…"),
          max_chars: z.number().int().min(1000).max(500_000).default(30_000),
        },
        annotations: READ,
      },
      ({ message_id, max_chars }) => run(async () => clip(await needJelly().rawMessage(message_id), max_chars)),
    );

    server.registerTool(
      "list_labels",
      {
        title: "List labels",
        description: "Every label in the Jelly team, for filtering list_conversations or labelling with update_conversation.",
        annotations: READ,
      },
      () =>
        run(async () => {
          const labels = await needJelly().labels();
          return labels.length ? labels.map((l) => `- ${l.name}`).join("\n") : "No labels.";
        }),
    );

    server.registerTool(
      "list_saved_replies",
      {
        title: "List saved replies",
        description: "The team's saved replies (canned responses) with their full text, to reuse in replies.",
        annotations: READ,
      },
      () =>
        run(async () => {
          const { savedReplies } = await needJelly().composeForm();
          if (savedReplies.length === 0) return "No saved replies.";
          return savedReplies.map((r) => `## ${r.name}\n${htmlToText(r.html)}`).join("\n\n");
        }),
    );
  }

  if (deps.marmalade) {
    server.registerTool(
      "list_team",
      {
        title: "List teammates",
        description: "Everyone on the Jelly team with their email and role, for assigning, @mentioning in notes, or knowing who replied.",
        annotations: READ,
      },
      () =>
        run(async () => {
          const members = (await needMarmalade().listMembers()).map((m) => m.jelly).filter((m) => m !== null);
          members.sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));
          return members.map((m) => `- ${m.name ?? "(no name)"} <${m.email}>${m.role ? ` · ${m.role}` : ""}${m.active === false ? " · inactive" : ""}`).join("\n");
        }),
    );
  }

  // ---------- writes ----------

  if (config.readOnly || !deps.jelly) return;
  const jelly = deps.jelly;

  const replyInput = {
    conversation,
    body,
    reply_to: z.string().optional().describe("The msg-… id of an earlier message to answer instead of the latest"),
    expected_latest_message_id: z
      .string()
      .optional()
      .describe("The latest message id you read; nothing happens if a newer message has arrived since"),
    cc: addresses.optional().describe("Extra Cc addresses"),
    bcc: addresses.optional().describe("Extra Bcc addresses"),
    allow_open_drafts: z.boolean().default(false).describe("Go ahead even if a teammate has an unsent draft open in it"),
  };

  server.registerTool(
    "draft_reply",
    {
      title: "Draft a reply",
      description:
        "Writes a reply as a draft in Jelly, with your signature and the quoted email, for a person to review and send from Jelly. Nothing is emailed. Prefer this over send_reply unless you were asked to send.",
      inputSchema: replyInput,
      annotations: WRITE,
    },
    (a) =>
      run(async () => {
        const { detail } = await jelly.reply(
          a.conversation,
          {
            text: a.body,
            replyTo: a.reply_to,
            expectLatest: a.expected_latest_message_id,
            cc: a.cc,
            bcc: a.bcc,
            allowOpenDrafts: a.allow_open_drafts,
          },
          "draft",
        );
        return detail;
      }),
  );

  if (config.allowSend) {
    server.registerTool(
      "send_reply",
      {
        title: "Send a reply",
        description:
          "Sends a reply email from Jelly right away, from the conversation's address with your signature, exactly as the Reply button would. It cannot be unsent. Read the conversation first and pass expected_latest_message_id so it won't send if something new arrived.",
        inputSchema: {
          ...replyInput,
          archive: z.boolean().optional().describe("Archive the conversation after sending (default: Jelly's own setting)"),
        },
        annotations: SENDS,
      },
      (a) =>
        run(async () => {
          const { detail } = await jelly.reply(
            a.conversation,
            {
              text: a.body,
              replyTo: a.reply_to,
              expectLatest: a.expected_latest_message_id,
              cc: a.cc,
              bcc: a.bcc,
              archive: a.archive,
              allowOpenDrafts: a.allow_open_drafts,
            },
            "send",
          );
          return detail;
        }),
    );
  }

  const composeInput = {
    to: addresses.min(1).describe("Recipients"),
    cc: addresses.optional(),
    bcc: addresses.optional().describe("Bcc, on top of the team's own Bcc address"),
    subject: z.string().min(1),
    body,
    mailbox: z.string().optional().describe("Mailbox to send from, e.g. Haven (required if you have more than one; see whoami)"),
    from: z.string().optional().describe("Sending address if the mailbox has several, e.g. haven@hackclub.com"),
  };

  server.registerTool(
    "draft_email",
    {
      title: "Draft a new email",
      description: "Starts a new email conversation as a draft in Jelly for a person to review and send. Nothing is emailed.",
      inputSchema: composeInput,
      annotations: WRITE,
    },
    (a) =>
      run(() =>
        jelly.compose(
          { to: a.to, cc: a.cc, bcc: a.bcc, subject: a.subject, text: a.body, mailbox: a.mailbox, from: a.from },
          "draft",
        ),
      ),
  );

  if (config.allowSend) {
    server.registerTool(
      "send_email",
      {
        title: "Send a new email",
        description: "Sends a new email from one of your Jelly mailboxes right away, with your signature. It cannot be unsent.",
        inputSchema: {
          ...composeInput,
          archive: z.boolean().default(false).describe("Archive the new conversation once sent"),
        },
        annotations: SENDS,
      },
      (a) =>
        run(() =>
          jelly.compose(
            { to: a.to, cc: a.cc, bcc: a.bcc, subject: a.subject, text: a.body, mailbox: a.mailbox, from: a.from, archive: a.archive },
            "send",
          ),
        ),
    );
  }

  server.registerTool(
    "add_note",
    {
      title: "Add an internal note",
      description:
        "Adds an internal comment to a conversation. Only your team sees it; it is never emailed. Write @Full Name to mention a teammate (they get notified).",
      inputSchema: {
        conversation,
        body: z.string().min(1).describe("Plain text; @Full Name mentions a teammate; URLs become links"),
      },
      annotations: WRITE,
    },
    ({ conversation: ref, body: text }) =>
      run(async () => {
        const page = await jelly.addNote(ref, text);
        return `Note added: ${jelly.conversationUrl(page.slug)}`;
      }),
  );

  server.registerTool(
    "update_conversation",
    {
      title: "Update conversations",
      description:
        "Changes one or more conversations the way Jelly's buttons do: archive or reopen, snooze, assign/unassign, add or remove labels, add/move/remove mailboxes, bookmark, follow, mark read/unread, rename, trash, or report spam. Give only the changes you want. Names match teammates, labels and mailboxes case-insensitively; \"me\" means you. Reports what happened to each.",
      inputSchema: {
        conversations: z.array(conversation).min(1).max(50).describe("Conversations to change"),
        archive: z.boolean().optional().describe("true archives; false moves it back to the inbox"),
        snooze: z
          .string()
          .optional()
          .describe('later_today, tomorrow_morning, next_week, an ISO time, or "off" to wake it up'),
        assign: z.array(z.string()).optional().describe("Teammates to assign (names, or me)"),
        unassign: z.array(z.string()).optional().describe("Teammates to unassign (names, or me)"),
        add_labels: z.array(z.string()).optional(),
        remove_labels: z.array(z.string()).optional(),
        add_mailboxes: z.array(z.string()).optional().describe("Also show it in these mailboxes"),
        remove_mailboxes: z.array(z.string()).optional(),
        move_to_mailbox: z.string().optional().describe("Move it to only this mailbox"),
        bookmark: z.boolean().optional().describe("Bookmark for you"),
        follow: z.boolean().optional().describe("Follow (get notified) or unfollow"),
        read: z.boolean().optional().describe("Mark read (true) or unread (false), for you"),
        subject: z.string().optional().describe('Rename the conversation; "" restores the original subject'),
        trash: z.boolean().optional().describe("true deletes it to the trash; false restores it"),
        spam: z.literal(true).optional().describe("Report as spam"),
      },
      annotations: { ...WRITE, destructiveHint: true },
    },
    (a) =>
      run(async () => {
        const changes: ConversationChanges = {
          archive: a.archive,
          trash: a.trash,
          spam: a.spam,
          snooze: a.snooze === undefined ? undefined : /^(off|none|wake|unsnooze)$/i.test(a.snooze) ? null : a.snooze,
          bookmark: a.bookmark,
          follow: a.follow,
          read: a.read,
          assign: a.assign,
          unassign: a.unassign,
          addLabels: a.add_labels,
          removeLabels: a.remove_labels,
          addMailboxes: a.add_mailboxes,
          removeMailboxes: a.remove_mailboxes,
          moveToMailbox: a.move_to_mailbox,
          subject: a.subject,
        };
        if (Object.values(changes).every((v) => v === undefined)) throw new JellyError("No changes given");
        const out: string[] = [];
        for (const ref of a.conversations) {
          try {
            const { page, results } = await jelly.update(ref, changes);
            out.push(`${page.slug}: ${results.join("; ") || "nothing to do"}`);
          } catch (err) {
            if (err instanceof JellySessionError) throw err;
            out.push(`${ref}: failed — ${errorMessage(err)}`);
          }
        }
        return out.join("\n");
      }),
  );
}

/** Every tool answers in text; errors come back as tool errors the model can read and act on. */
async function run(fn: () => Promise<string>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (err) {
    let text = errorMessage(err);
    if (err instanceof JellySendError && err.maybeSent) {
      text += "\nIt may have been sent anyway. Check the conversation in Jelly before trying again.";
    }
    if (!(err instanceof JellyError) && !(err instanceof MarmaladeError) && !(err instanceof z.ZodError)) {
      text = `Unexpected error: ${text}`;
    }
    return { isError: true, content: [{ type: "text", text }] };
  }
}

async function resolveMailbox(marmalade: MarmaladeClient, wanted: string | undefined): Promise<string> {
  const mailboxes = await marmalade.listMailboxes();
  if (wanted) {
    const found = mailboxes.find(
      (m) => m.jellyMailbox.jellyMailboxId === wanted || m.jellyMailbox.name.toLowerCase() === wanted.toLowerCase(),
    );
    return found?.jellyMailbox.jellyMailboxId ?? wanted;
  }
  if (mailboxes.length === 1) return mailboxes[0]!.jellyMailbox.jellyMailboxId;
  throw new JellyError(
    `Say which mailbox: ${mailboxes.map((m) => m.jellyMailbox.jellyMailboxId).join(", ") || "(this key can't list them; set MARMALADE_MAILBOX)"}`,
  );
}

async function findInMarmalade(marmalade: MarmaladeClient, ref: string, preferred: string | undefined) {
  const mailboxes = (await marmalade.listMailboxes().catch(() => [])).map((m) => m.jellyMailbox.jellyMailboxId);
  const order = [...new Set([preferred, ...mailboxes].filter((m): m is string => Boolean(m)))];
  for (const mailbox of order) {
    try {
      return { mailbox, conversation: await marmalade.getConversation(mailbox, ref) };
    } catch (err) {
      if (!(err instanceof MarmaladeError) || err.status !== 404) throw err;
    }
  }
  throw new JellyError(`Marmalade doesn't have "${ref}" in ${order.join(", ") || "any mailbox it can read"}`);
}

function isoDate(value: string): string {
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) throw new JellyError(`"${value}" isn't a date`);
  return t.toISOString();
}
