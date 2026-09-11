import type { PrismaClient } from "@rakazo/db";
import { findTeamLineIdentityForBot } from "./team-line-tools.js";

/**
 * Executor dep answering "can this bot reach a messaging identity?": its own linked chat app,
 * or the owner's team line when the owner allowed it to text. None when messaging is absent.
 */
export function createMessagingContextLoader(prisma: PrismaClient) {
  return {
    hasIdentity: async (botId: string): Promise<boolean> => {
      const own = await prisma.messagingIdentity.findFirst({
        where: { botId },
        select: { id: true },
      });
      if (own) return true;
      return Boolean(await findTeamLineIdentityForBot(prisma, botId));
    },
  };
}
