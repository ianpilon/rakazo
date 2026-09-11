import type { MessagingInboundMessage } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createMessagingInboundHandler } from "./messaging-inbound.js";

/** One SMS line linked to the owner's cell, currently pointed at Chief, with two bots to choose from. */
function createDeps() {
  const identity = {
    id: "mi-1",
    provider: "twilio",
    address: "+15195550123",
    userId: "user-1",
    spaceId: "space-1",
    botId: "bot-chief",
  };
  const bots = [
    { id: "bot-chief", name: "Chief" },
    { id: "bot-skill", name: "Skill Builder bot" },
  ];
  const outbound: Array<Record<string, unknown>> = [];
  const prisma = {
    messagingIdentity: {
      findUnique: vi.fn(async () => identity),
      findFirst: vi.fn(async () => identity),
      update: vi.fn(async ({ data }: { data: { botId?: string } }) => {
        if (data.botId) identity.botId = data.botId;
        return identity;
      }),
    },
    bot: {
      findMany: vi.fn(async () => bots),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          bots.find((bot) => bot.id === where.id) ?? null,
      ),
    },
    thread: {
      findFirst: vi.fn(async ({ where }: { where: { botId: string } }) => ({
        id: `thread-${where.botId}`,
      })),
    },
    routine: { findMany: vi.fn(async () => []) },
    messagingLinkCode: { findUnique: vi.fn(async () => null) },
    messagingOutbound: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        outbound.push(...data);
        return { count: data.length };
      }),
    },
  };
  const events = {
    sendUserMessage: vi.fn(async () => ({ runId: "run-1", messageId: "m-1" })),
    notify: vi.fn(async () => undefined),
  };
  const jobs = { enqueue: vi.fn(async () => undefined) };
  const handler = createMessagingInboundHandler({
    prisma: prisma as unknown as PrismaClient,
    events: events as never,
    jobs,
    provision: vi.fn(async () => {
      throw new Error("must not provision");
    }),
    openSignup: false,
    signupPolicy: {} as never,
  });
  return { handler, prisma, events, jobs, identity, outbound };
}

function inbound(content: string): MessagingInboundMessage {
  return {
    type: "message",
    provider: "twilio",
    transport: "SMS",
    handle: `SM-${content.length}`,
    threadId: "twilio:abc",
    isDirect: true,
    from: "+15195550123",
    fromLabel: null,
    channelName: null,
    participants: [],
    content,
    mediaUrl: null,
  };
}

describe("team line routing", () => {
  it("routes a plain text to the bot the line currently follows", async () => {
    const { handler, events, identity } = createDeps();
    await handler(inbound("what is on today?"));
    expect(identity.botId).toBe("bot-chief");
    expect(events.sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: "bot-chief",
        threadId: "thread-bot-chief",
        prompt: "what is on today?",
        trigger: "messaging",
      }),
    );
  });

  it("a text that names a bot switches the line to it and delivers the rest", async () => {
    const { handler, events, identity, prisma } = createDeps();
    await handler(inbound("Skill Builder bot: turn yesterday's steps into a skill"));
    expect(prisma.messagingIdentity.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { botId: "bot-skill" } }),
    );
    expect(identity.botId).toBe("bot-skill");
    expect(events.sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: "bot-skill",
        threadId: "thread-bot-skill",
        prompt: "turn yesterday's steps into a skill",
      }),
    );
  });

  it("naming a bot with nothing else just switches and confirms by text", async () => {
    const { handler, events, identity, outbound } = createDeps();
    await handler(inbound("@Skill Builder bot"));
    expect(identity.botId).toBe("bot-skill");
    expect(events.sendUserMessage).not.toHaveBeenCalled();
    expect(outbound).toEqual([
      expect.objectContaining({ identityId: "mi-1", body: "Now talking to Skill Builder bot." }),
    ]);
  });
});
