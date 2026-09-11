import type { AdapterContext, MessagingInboundEvent } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import { createEmulatedTwilioPlatform, TwilioEmulator } from "./twilio-emulator.js";
import { parseTwilioStatus, signTwilioRequest, verifyTwilioSignature } from "./twilio-messaging.js";

const context: AdapterContext = {
  operationId: "twilio-test",
  traceId: "twilio-test",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

describe("Twilio SMS platform", () => {
  let emulator: TwilioEmulator;
  let surface: ChatSdkMessagingSurface;
  let events: MessagingInboundEvent[];

  beforeEach(() => {
    emulator = new TwilioEmulator();
    surface = new ChatSdkMessagingSurface([createEmulatedTwilioPlatform(emulator)]);
    events = [];
    surface.onInbound(async (event) => {
      events.push(event);
    });
  });

  it("turns a signed inbound text into a direct SMS message for the sink", async () => {
    const response = await surface.handleWebhook(
      "twilio",
      emulator.buildInboundRequest({ from: "+15195550123", body: "Skill Builder: make a skill" }),
    );
    expect(response?.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message",
      provider: "twilio",
      transport: "SMS",
      isDirect: true,
      from: "+15195550123",
      content: "Skill Builder: make a skill",
      participants: [],
    });
    expect((events[0] as { threadId: string }).threadId.startsWith("twilio:")).toBe(true);
  });

  it("rejects a webhook with a bad signature and never reaches the sink", async () => {
    const response = await surface.handleWebhook(
      "twilio",
      emulator.buildInboundRequest({ from: "+15195550123", body: "hi", signature: "forged" }),
    );
    expect(response?.status).toBe(401);
    expect(events).toHaveLength(0);
  });

  it("ignores texts sent to another number on the same account", async () => {
    const response = await surface.handleWebhook(
      "twilio",
      emulator.buildInboundRequest({ from: "+15195550123", body: "hi", to: "+15550009999" }),
    );
    expect(response?.status).toBe(200);
    expect(events).toHaveLength(0);
  });

  it("sends through the Messages API from the line's number with a status callback", async () => {
    const threadId = await surface.openDirectThread("twilio", "+15195550123", context);
    const sent = await surface.sendToThread(
      { threadId, body: "Open Bot\nfrom Chief\n\nhello" },
      context,
    );
    expect(sent.handle).toMatch(/^SM/);
    expect(emulator.sent).toEqual([
      {
        to: "+15195550123",
        from: emulator.phoneNumber,
        body: "Open Bot\nfrom Chief\n\nhello",
        sid: sent.handle,
        statusCallback: emulator.webhookUrl,
      },
    ]);
  });

  it("surfaces a signed delivery report as an outbound status", async () => {
    const response = await surface.handleWebhook(
      "twilio",
      emulator.buildStatusRequest({ sid: "SM123", status: "delivered" }),
    );
    expect(response?.status).toBe(200);
    expect(events).toEqual([
      { type: "status", provider: "twilio", handle: "SM123", status: "DELIVERED" },
    ]);
  });

  it("maps Twilio statuses and ignores inbound receipts", () => {
    expect(parseTwilioStatus({ MessageSid: "SM1", MessageStatus: "failed" })).toEqual({
      type: "status",
      provider: "twilio",
      handle: "SM1",
      status: "ERROR",
    });
    expect(parseTwilioStatus({ MessageSid: "SM1", MessageStatus: "queued" })).toBeNull();
    expect(
      parseTwilioStatus({ MessageSid: "SM1", SmsStatus: "received", From: "+1", Body: "hi" }),
    ).toBeNull();
  });

  it("signs the way Twilio does and verifies in constant time", () => {
    const params = { To: "+1555", From: "+1444", Body: "hi" };
    const url = "https://openbot.test/api/v1/messaging/webhook/twilio";
    const signature = signTwilioRequest("token", url, params);
    expect(verifyTwilioSignature({ authToken: "token", url, params, signature })).toBe(true);
    expect(verifyTwilioSignature({ authToken: "other", url, params, signature })).toBe(false);
    expect(
      verifyTwilioSignature({ authToken: "token", url: `${url}?x=1`, params, signature }),
    ).toBe(false);
  });
});
