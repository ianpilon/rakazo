import { createHmac, timingSafeEqual } from "node:crypto";
import type { MessagingOutboundStatus } from "@rakazo/adapter-kit";
import {
  type Adapter,
  type AdapterPostableMessage,
  type ChatInstance,
  ConsoleLogger,
  type FetchResult,
  type FormattedContent,
  type Logger,
  Message,
  parseMarkdown,
  type RawMessage,
  stringifyMarkdown,
  type ThreadInfo,
  type WebhookOptions,
} from "chat";
import type { MessagingPlatform } from "./chat-sdk-surface.js";

export const TWILIO_PROVIDER = "twilio";
const DEFAULT_API_BASE_URL = "https://api.twilio.com";

/** Account details for one SMS line. Read on demand so settings can change without a restart. */
export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** E.164 number the line sends from and receives on. */
  fromNumber: string;
  /** Public URL Twilio posts to; part of the signature Twilio computes. */
  webhookUrl: string;
}

export type TwilioConfigSource = () => Promise<TwilioConfig | null>;

/** Form fields Twilio posts for an inbound message or a status callback. */
export type TwilioWebhookParams = Record<string, string>;

type ThreadData = { contactNumber: string };

/**
 * Twilio's request signature: base64(HMAC-SHA1(authToken, url + concat(sorted key+value))).
 */
export function signTwilioRequest(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join("");
  return createHmac("sha1", authToken).update(data).digest("base64");
}

export function verifyTwilioSignature(input: {
  authToken: string;
  url: string;
  params: Record<string, string>;
  signature: string;
}): boolean {
  const expected = Buffer.from(signTwilioRequest(input.authToken, input.url, input.params));
  const actual = Buffer.from(input.signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Twilio reports delivery through the same webhook; map the states the outbox cares about. */
export function parseTwilioStatus(payload: unknown): MessagingOutboundStatus | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as Record<string, unknown>;
  const sid = body.MessageSid ?? body.SmsSid;
  const status = body.MessageStatus ?? body.SmsStatus;
  if (typeof sid !== "string" || !sid || typeof status !== "string") return null;
  if (typeof body.Body === "string" && body.Body.length > 0 && typeof body.From === "string") {
    // An inbound message also carries a status ("received"); that is not a delivery report.
    return null;
  }
  const mapped =
    status === "delivered" || status === "sent"
      ? "DELIVERED"
      : status === "failed" || status === "undelivered"
        ? "ERROR"
        : null;
  if (!mapped) return null;
  return { type: "status", provider: TWILIO_PROVIDER, handle: sid, status: mapped };
}

function twiml(): Response {
  return new Response("<Response></Response>", {
    status: 200,
    headers: { "content-type": "text/xml" },
  });
}

function mediaType(mimeType: string | undefined): "image" | "file" | "video" | "audio" {
  if (!mimeType) return "file";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

function renderOutbound(message: AdapterPostableMessage): string {
  if (typeof message === "string") return message;
  if ("markdown" in message && typeof message.markdown === "string") return message.markdown;
  if ("ast" in message) return stringifyMarkdown(message.ast);
  if ("raw" in message && typeof message.raw === "string") return message.raw;
  return "";
}

/**
 * Plain SMS over Twilio, behind the Chat SDK adapter contract the messaging surface expects.
 * One line, direct messages only. The adapter reads its configuration on every call so the
 * line can be set up or changed from the app without restarting the server.
 */
export class TwilioSmsAdapter implements Adapter<ThreadData, TwilioWebhookParams> {
  readonly name = TWILIO_PROVIDER;
  readonly userName = TWILIO_PROVIDER;
  private chat: ChatInstance | null = null;
  private logger: Logger = new ConsoleLogger();
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;

  constructor(
    private readonly options: {
      config: TwilioConfigSource;
      fetch?: typeof fetch;
      apiBaseUrl?: string;
    },
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = chat.getLogger(TWILIO_PROVIDER);
  }

  encodeThreadId(data: ThreadData): string {
    return `${TWILIO_PROVIDER}:${Buffer.from(data.contactNumber).toString("base64url")}`;
  }

  decodeThreadId(threadId: string): ThreadData {
    const [provider, contact] = threadId.split(":");
    if (provider !== TWILIO_PROVIDER || !contact) {
      throw new Error(`Invalid Twilio thread ID: ${threadId}`);
    }
    return { contactNumber: Buffer.from(contact, "base64url").toString() };
  }

  isDM(): boolean {
    return true;
  }

  async openDM(userId: string): Promise<string> {
    return this.encodeThreadId({ contactNumber: userId });
  }

  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }

  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const config = await this.options.config();
    if (!config) return new Response("Not configured", { status: 404 });
    const params = Object.fromEntries(new URLSearchParams(await request.text()));
    const signature = request.headers.get("x-twilio-signature") ?? "";
    if (
      !verifyTwilioSignature({
        authToken: config.authToken,
        url: config.webhookUrl,
        params,
        signature,
      })
    ) {
      this.logger.warn("Twilio webhook signature mismatch");
      return new Response("Unauthorized", { status: 401 });
    }
    const isStatusCallback =
      typeof params.MessageStatus === "string" && typeof params.Body !== "string";
    if (isStatusCallback) return twiml();
    if (typeof params.From !== "string" || typeof params.MessageSid !== "string") {
      return new Response("Bad Request", { status: 400 });
    }
    if (params.To !== config.fromNumber) {
      // Another number on the same account; not this line.
      return twiml();
    }
    if (this.chat) {
      const threadId = this.encodeThreadId({ contactNumber: params.From });
      const raw = params;
      void this.chat.processMessage(
        this,
        threadId,
        () => Promise.resolve(this.parseMessage(raw)),
        options,
      );
    }
    return twiml();
  }

  parseMessage(raw: TwilioWebhookParams): Message<TwilioWebhookParams> {
    const text = raw.Body ?? "";
    const attachments: Message["attachments"] = [];
    const count = Number(raw.NumMedia ?? 0);
    for (let index = 0; index < count; index += 1) {
      const url = raw[`MediaUrl${index}`];
      if (!url) continue;
      const mimeType = raw[`MediaContentType${index}`];
      attachments.push({ type: mediaType(mimeType), url, mimeType });
    }
    return new Message<TwilioWebhookParams>({
      id: raw.MessageSid ?? "",
      threadId: this.encodeThreadId({ contactNumber: raw.From ?? "" }),
      text,
      formatted: parseMarkdown(text),
      raw,
      author: {
        userId: raw.From ?? "",
        userName: raw.From ?? "",
        fullName: "",
        isBot: false,
        isMe: false,
      },
      metadata: { dateSent: new Date(), edited: false },
      isMention: true,
      attachments,
    });
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<TwilioWebhookParams>> {
    const config = await this.options.config();
    if (!config) throw new Error("Text messaging is not configured");
    const { contactNumber } = this.decodeThreadId(threadId);
    const text = renderOutbound(message);
    if (!text.trim()) return { raw: {}, id: "", threadId };
    const credentials = Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${credentials}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: config.fromNumber,
          To: contactNumber,
          Body: text,
          StatusCallback: config.webhookUrl,
        }).toString(),
      },
    );
    if (!response.ok) {
      throw new Error(`Twilio send failed with status ${response.status}`);
    }
    const json = (await response.json().catch(() => ({}))) as { sid?: unknown };
    return {
      raw: { sid: typeof json.sid === "string" ? json.sid : "" },
      id: typeof json.sid === "string" ? json.sid : "",
      threadId,
    };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    return { id: threadId, channelId: threadId, isDM: true, metadata: {} };
  }

  async fetchMessages(): Promise<FetchResult<TwilioWebhookParams>> {
    return { messages: [] };
  }

  async addReaction(): Promise<void> {
    // SMS has no reactions.
  }

  async removeReaction(): Promise<void> {
    // SMS has no reactions.
  }

  async startTyping(): Promise<void> {
    // SMS has no typing indicator.
  }

  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content);
  }

  async deleteMessage(): Promise<void> {
    throw new Error("SMS messages cannot be deleted");
  }

  async editMessage(): Promise<RawMessage<TwilioWebhookParams>> {
    throw new Error("SMS messages cannot be edited");
  }
}

export function createTwilioPlatform(options: {
  config: TwilioConfigSource;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
}): MessagingPlatform {
  const adapter = new TwilioSmsAdapter(options);
  return {
    provider: TWILIO_PROVIDER,
    capabilities: { direct: true, groups: false, typing: false },
    adapter,
    directThreadId: (address) => adapter.encodeThreadId({ contactNumber: address }),
    peekStatus: (payload) => parseTwilioStatus(payload),
    transport: () => "SMS",
  };
}
