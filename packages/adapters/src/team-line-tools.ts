import { type JobPublisher, messagingDeliverJob } from "@rakazo/adapter-kit";
import { isTeamLineProvider, stampTeamLineBody, TEAM_LINE_PROVIDERS } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

type Result<T extends object = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

/**
 * The team-line identity a bot may text through: the owner's SMS line, when the owner has
 * allowed this bot to send. Bots linked to their own chat app are handled by the caller.
 */
export async function findTeamLineIdentityForBot(prisma: PrismaClient, botId: string) {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: { userId: true, spaceId: true, smsSendAllowed: true },
  });
  if (!bot?.smsSendAllowed) return null;
  return prisma.messagingIdentity.findFirst({
    where: {
      userId: bot.userId,
      spaceId: bot.spaceId,
      provider: { in: [...TEAM_LINE_PROVIDERS] },
    },
  });
}

/** Queues a text from a bot to its owner, stamped with the bot's name on a team line. */
export async function sendTeamLineText(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  sender: { id: string; name: string },
  input: { message: string; deliveryKey: string },
): Promise<Result<{ provider: string }>> {
  const message = input.message.trim();
  if (!message) return { ok: false, error: "message is required" };
  const own = await deps.prisma.messagingIdentity.findFirst({ where: { botId: sender.id } });
  const identity = own ?? (await findTeamLineIdentityForBot(deps.prisma, sender.id));
  if (!identity) {
    return {
      ok: false,
      error: "No phone is linked for texting, or the owner has not allowed this bot to send texts.",
    };
  }
  const teamLine = isTeamLineProvider(identity.provider);
  await deps.prisma.messagingOutbound.createMany({
    data: [
      {
        idempotencyKey: `text:${input.deliveryKey}`,
        kind: "dm",
        identityId: identity.id,
        body: teamLine ? stampTeamLineBody(sender.name, message) : message,
      },
    ],
    skipDuplicates: true,
  });
  if (teamLine && identity.botId !== sender.id) {
    // The owner's next reply goes to the bot that texted last.
    await deps.prisma.messagingIdentity.update({
      where: { id: identity.id },
      data: { botId: sender.id },
    });
  }
  await deps.jobs.enqueue(messagingDeliverJob()).catch((error) => {
    getLogger().error("team line text enqueue error", error);
  });
  return { ok: true, provider: identity.provider };
}

/** A manager bot the owner trusts turns texting on or off for a teammate. */
export async function setBotTexting(
  prisma: PrismaClient,
  actor: { id: string; userId: string; spaceId: string },
  input: { botId?: string; botName?: string; enabled: boolean },
): Promise<Result<{ botId: string; name: string; enabled: boolean }>> {
  const granter = await prisma.bot.findUnique({
    where: { id: actor.id },
    select: { smsGrantAllowed: true },
  });
  if (!granter?.smsGrantAllowed) {
    return { ok: false, error: "The owner has not allowed you to manage texting for other bots." };
  }
  const name = input.botName?.trim();
  const target = await prisma.bot.findFirst({
    where: {
      userId: actor.userId,
      spaceId: actor.spaceId,
      archivedAt: null,
      ...(input.botId ? { id: input.botId } : {}),
      ...(!input.botId && name ? { name: { equals: name, mode: "insensitive" } } : {}),
    },
    select: { id: true, name: true },
  });
  if (!target || (!input.botId && !name)) {
    return { ok: false, error: "Name the bot by bot_id or bot_name from your teammate list." };
  }
  await prisma.bot.update({ where: { id: target.id }, data: { smsSendAllowed: input.enabled } });
  return { ok: true, botId: target.id, name: target.name, enabled: input.enabled };
}
