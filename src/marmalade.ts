import { z } from "zod";
import { redact } from "./redact.js";

// Read-only client for Marmalade (https://github.com/hackclub/marmalade), the
// audited mirror of Jelly. Its write endpoints are for Jelly's webhooks only, so
// this client can only GET. (Adapted from pudding's marmalade.ts.)

export const MessageSchema = z.looseObject({
  id: z.string(),
  conversationId: z.string(),
  subject: z.string().nullable(),
  content: z.string().nullable(),
  contentHtml: z.string().nullable(),
  senderId: z.string().nullable(),
  isInbound: z.boolean(),
  attachmentsCount: z.number(),
  metadata: z.unknown().optional(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
});

export const CommentSchema = z.looseObject({
  id: z.string(),
  conversationId: z.string(),
  body: z.string().nullable(),
  authorId: z.string().nullable(),
  metadata: z.unknown().optional(),
  createdAt: z.string(),
});

const conversationFields = {
  id: z.string(),
  subject: z.string().nullable(),
  status: z.string(),
  snoozedUntil: z.string().nullable(),
  url: z.string().nullable(),
  createdAt: z.string(),
  lastMessageAt: z.string(),
  updatedAt: z.string(),
};

export const ConversationSummarySchema = z.looseObject(conversationFields);

export const ConversationListSchema = z.array(
  z.looseObject({ conversation: ConversationSummarySchema, mailboxId: z.string() }),
);

export const ConversationDetailSchema = z.looseObject({
  ...conversationFields,
  messages: z.array(MessageSchema),
  comments: z.array(CommentSchema),
});

export const AssignmentListSchema = z.array(
  z.looseObject({ id: z.number(), conversationId: z.string(), jellyContactId: z.string(), createdAt: z.string() }),
);

const JellyMemberSchema = z.looseObject({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  role: z.string().optional(),
  active: z.boolean().optional(),
});

export const MailboxListSchema = z.array(
  z.looseObject({
    jellyMailbox: z.looseObject({
      id: z.number(),
      jellyMailboxId: z.string(),
      name: z.string(),
      isArchived: z.boolean(),
      memberCount: z.number().optional(),
    }),
    marmaladeMailbox: z.looseObject({ id: z.number(), active: z.boolean() }).nullable(),
  }),
);

export const MemberListSchema = z.array(z.looseObject({ jelly: JellyMemberSchema.nullable() }));

export type Message = z.infer<typeof MessageSchema>;
export type Comment = z.infer<typeof CommentSchema>;
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;
export type ConversationDetail = z.infer<typeof ConversationDetailSchema>;
export type JellyMember = z.infer<typeof JellyMemberSchema>;

export interface ListConversationsParams {
  status?: string;
  /** Matches the subject: words anywhere, "quoted" for the exact subject. */
  search?: string;
  sortBy?: "createdAt" | "updatedAt" | "lastMessageAt";
  sortOrder?: "asc" | "desc";
  startDate?: string;
  endDate?: string;
}

export class MarmaladeError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    /** Network errors, timeouts, 429 and 5xx: worth retrying. */
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "MarmaladeError";
  }
}

export interface MarmaladeClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

export class MarmaladeClient {
  private readonly root: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: MarmaladeClientOptions) {
    this.root = `${options.baseUrl.replace(/\/+$/, "").replace(/\/api\/rpc$/, "")}/api/rpc`;
    this.fetchImpl = options.fetch ?? fetch;
  }

  listMailboxes() {
    return this.get("/mailboxes", {}, MailboxListSchema);
  }

  listMembers() {
    return this.get("/members", {}, MemberListSchema);
  }

  /** Marmalade can repeat a conversation in this list; each comes back once here. */
  async listConversations(mailboxId: string, params: ListConversationsParams) {
    const rows = await this.get(`/mailboxes/${enc(mailboxId)}/conversations`, { ...params }, ConversationListSchema);
    const seen = new Set<string>();
    return rows.filter(({ conversation }) => !seen.has(conversation.id) && seen.add(conversation.id));
  }

  getConversation(mailboxId: string, conversationId: string) {
    return this.get(`/mailboxes/${enc(mailboxId)}/conversations/${enc(conversationId)}`, {}, ConversationDetailSchema);
  }

  getAssignment(mailboxId: string, conversationId: string) {
    return this.get(`/mailboxes/${enc(mailboxId)}/conversations/${enc(conversationId)}/assignment`, {}, AssignmentListSchema);
  }

  private async get<T>(path: string, query: Record<string, string | undefined>, schema: z.ZodType<T>): Promise<T> {
    const url = new URL(this.root + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const retries = this.options.retries ?? 2;
    const retryDelayMs = this.options.retryDelayMs ?? 1000;
    let lastError: MarmaladeError | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
      try {
        return await this.getOnce(url, path, schema);
      } catch (err) {
        if (!(err instanceof MarmaladeError) || !err.transient) throw err;
        lastError = err;
      }
    }
    throw lastError!;
  }

  private async getOnce<T>(url: URL, path: string, schema: z.ZodType<T>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.options.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new MarmaladeError(redact(`Marmalade GET ${path} failed: ${reason}`), undefined, true);
    }
    const text = await response.text();
    if (!response.ok) {
      const transient = response.status === 429 || response.status >= 500;
      const hint =
        response.status === 401 || response.status === 403
          ? " (the API key is wrong, revoked, or can't see this mailbox)"
          : response.status === 404
            ? " (not found, or not in a mailbox this key can read)"
            : "";
      throw new MarmaladeError(
        redact(`Marmalade GET ${path} returned ${response.status}${hint}: ${text.slice(0, 200)}`),
        response.status,
        transient,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new MarmaladeError(`Marmalade GET ${path} returned non-JSON`, response.status, false);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new MarmaladeError(`Marmalade GET ${path} returned an unexpected shape: ${issues}`, response.status, false);
    }
    return parsed.data;
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}
