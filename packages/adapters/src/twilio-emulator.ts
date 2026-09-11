import type { MessagingPlatform } from "./chat-sdk-surface.js";
import { createTwilioPlatform, signTwilioRequest, type TwilioConfig } from "./twilio-messaging.js";

interface SentMessage {
  to: string;
  from: string;
  body: string;
  sid: string;
  statusCallback: string | null;
}

/**
 * Deterministic Twilio boundary emulator: serves the Messages API over an injected fetch,
 * records outbound sends, and builds correctly signed inbound and status webhook requests.
 */
export class TwilioEmulator {
  readonly accountSid = "ACemulated000000000000000000000000";
  readonly authToken = "emulated-auth-token";
  readonly phoneNumber = "+15550001111";
  readonly webhookUrl = "https://openbot.test/api/v1/messaging/webhook/twilio";
  readonly sent: SentMessage[] = [];
  private sidCounter = 0;
  private failRemaining = 0;

  readonly config: TwilioConfig = {
    accountSid: this.accountSid,
    authToken: this.authToken,
    fromNumber: this.phoneNumber,
    webhookUrl: this.webhookUrl,
  };

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname !== "api.twilio.com") {
      throw new Error(`Twilio emulator received unexpected URL ${url}`);
    }
    const expectedPath = `/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    if (url.pathname !== expectedPath || (init?.method ?? "GET").toUpperCase() !== "POST") {
      return Response.json({ message: "not found" }, { status: 404 });
    }
    const headers = new Headers(init?.headers);
    const expectedAuth = `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`;
    if (headers.get("authorization") !== expectedAuth) {
      return Response.json({ message: "unauthorized" }, { status: 401 });
    }
    if (this.failRemaining > 0) {
      this.failRemaining -= 1;
      return Response.json({ message: "emulated failure" }, { status: 500 });
    }
    const body = new URLSearchParams(String(init?.body ?? ""));
    const sid = this.nextSid();
    this.sent.push({
      to: body.get("To") ?? "",
      from: body.get("From") ?? "",
      body: body.get("Body") ?? "",
      sid,
      statusCallback: body.get("StatusCallback"),
    });
    return Response.json({ sid, status: "queued" }, { status: 201 });
  };

  failNextSends(count: number): void {
    this.failRemaining = count;
  }

  /** A signed inbound SMS as Twilio would post it. */
  buildInboundRequest(input: {
    from: string;
    body: string;
    sid?: string;
    to?: string;
    mediaUrl?: string;
    signature?: string;
  }): Request {
    const params: Record<string, string> = {
      MessageSid: input.sid ?? this.nextSid(),
      AccountSid: this.accountSid,
      From: input.from,
      To: input.to ?? this.phoneNumber,
      Body: input.body,
      NumMedia: input.mediaUrl ? "1" : "0",
      SmsStatus: "received",
    };
    if (input.mediaUrl) {
      params.MediaUrl0 = input.mediaUrl;
      params.MediaContentType0 = "image/jpeg";
    }
    return this.signedRequest(params, input.signature);
  }

  /** A signed delivery status callback for an outbound message. */
  buildStatusRequest(input: { sid: string; status: string; signature?: string }): Request {
    return this.signedRequest(
      {
        MessageSid: input.sid,
        AccountSid: this.accountSid,
        From: this.phoneNumber,
        MessageStatus: input.status,
      },
      input.signature,
    );
  }

  private signedRequest(params: Record<string, string>, signature?: string): Request {
    return new Request(this.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature":
          signature ?? signTwilioRequest(this.authToken, this.webhookUrl, params),
      },
      body: new URLSearchParams(params).toString(),
    });
  }

  private nextSid(): string {
    this.sidCounter += 1;
    return `SM${String(this.sidCounter).padStart(32, "0")}`;
  }
}

/** The production Twilio platform wired to the emulator: only the HTTP boundary is swapped. */
export function createEmulatedTwilioPlatform(emulator: TwilioEmulator): MessagingPlatform {
  return createTwilioPlatform({ config: async () => emulator.config, fetch: emulator.fetch });
}
