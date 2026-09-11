import { ORPCError } from "@orpc/server";
import {
  parseSmsLineSettings,
  type SmsLineDeps,
  smsWebhookUrl,
  TWILIO_PROVIDER,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { Prisma } from "@rakazo/db";
import { withSerializableRetry } from "./serializable-retry.js";

const E164 = /^\+[1-9]\d{6,14}$/;

export async function smsLineStatus(deps: SmsLineDeps, actor: Actor) {
  const row = await deps.prisma.messagingProviderConfig.findUnique({
    where: { spaceId_provider: { spaceId: actor.spaceId, provider: TWILIO_PROVIDER } },
    select: { settings: true },
  });
  const settings = parseSmsLineSettings(row?.settings);
  return {
    configured: Boolean(settings),
    fromNumber: settings?.fromNumber ?? null,
    webhookUrl: smsWebhookUrl(deps.webOrigin),
  };
}

export async function persistSmsLineConfig(
  deps: SmsLineDeps,
  actor: Actor,
  input: { accountSid: string; authToken: string; fromNumber: string },
) {
  const accountSid = input.accountSid.trim();
  const authToken = input.authToken.trim();
  const fromNumber = input.fromNumber.replace(/[\s()-]/g, "");
  if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Account SID should start with AC and be 34 characters.",
    });
  }
  if (authToken.length < 16) {
    throw new ORPCError("BAD_REQUEST", { message: "Auth token looks too short." });
  }
  if (!E164.test(fromNumber)) {
    throw new ORPCError("BAD_REQUEST", { message: "Number must be in +1XXXXXXXXXX form." });
  }
  const stored = await deps.secrets.put(JSON.stringify({ authToken }), {
    operationId: "sms-line-config",
    traceId: "sms-line-config",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: new AbortController().signal,
  });
  await withSerializableRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const existing = await tx.messagingProviderConfig.findUnique({
          where: { spaceId_provider: { spaceId: actor.spaceId, provider: TWILIO_PROVIDER } },
          select: { secretId: true },
        });
        const secret = await tx.secret.create({
          data: {
            id: stored.id,
            userId: actor.userId,
            spaceId: actor.spaceId,
            kind: "messaging-provider",
            ciphertext: stored.ciphertext,
          },
        });
        const settings: Record<string, string> = { accountSid, fromNumber };
        await tx.messagingProviderConfig.upsert({
          where: { spaceId_provider: { spaceId: actor.spaceId, provider: TWILIO_PROVIDER } },
          create: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            provider: TWILIO_PROVIDER,
            settings,
            secretId: secret.id,
          },
          update: { userId: actor.userId, settings, secretId: secret.id },
        });
        if (existing && existing.secretId !== secret.id) {
          await tx.secret.deleteMany({ where: { id: existing.secretId } });
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return smsLineStatus(deps, actor);
}

export async function disconnectSmsLine(deps: SmsLineDeps, actor: Actor) {
  const existing = await deps.prisma.messagingProviderConfig.findUnique({
    where: { spaceId_provider: { spaceId: actor.spaceId, provider: TWILIO_PROVIDER } },
    select: { id: true, secretId: true },
  });
  if (existing) {
    await deps.prisma.$transaction([
      deps.prisma.messagingProviderConfig.delete({ where: { id: existing.id } }),
      deps.prisma.secret.deleteMany({ where: { id: existing.secretId } }),
    ]);
  }
  return { ok: true as const };
}
