import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { EncryptedSecretStore } from "./secrets.js";
import { TWILIO_PROVIDER, type TwilioConfig } from "./twilio-messaging.js";

export interface SmsLineDeps {
  prisma: PrismaClient;
  secrets: EncryptedSecretStore;
  /** Public origin of this deployment; Twilio posts to it and signs against it. */
  webOrigin: string;
}

export const SMS_WEBHOOK_PATH = `/api/v1/messaging/webhook/${TWILIO_PROVIDER}`;

export interface SmsLineSettings {
  accountSid: string;
  fromNumber: string;
}

export function smsWebhookUrl(webOrigin: string): string {
  return `${webOrigin.replace(/\/+$/, "")}${SMS_WEBHOOK_PATH}`;
}

export function parseSmsLineSettings(value: unknown): SmsLineSettings | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.accountSid !== "string" || typeof record.fromNumber !== "string") return null;
  return { accountSid: record.accountSid, fromNumber: record.fromNumber };
}

/**
 * The line's live configuration for the adapter. One SMS line per deployment today: the first
 * configured space wins, which is the whole story for a self-hosted personal instance.
 */
export async function loadSmsLineConfig(deps: SmsLineDeps): Promise<TwilioConfig | null> {
  const row = await deps.prisma.messagingProviderConfig.findFirst({
    where: { provider: TWILIO_PROVIDER },
    include: { secret: { select: { id: true, ciphertext: true } } },
    orderBy: { createdAt: "asc" },
  });
  const settings = parseSmsLineSettings(row?.settings);
  if (!row || !settings) return null;
  try {
    const credentials = JSON.parse(deps.secrets.load(row.secret.ciphertext, row.secret.id)) as {
      authToken?: unknown;
    };
    if (typeof credentials.authToken !== "string" || !credentials.authToken) return null;
    return {
      accountSid: settings.accountSid,
      authToken: credentials.authToken,
      fromNumber: settings.fromNumber,
      webhookUrl: smsWebhookUrl(deps.webOrigin),
    };
  } catch (error) {
    getLogger().error("sms line credential could not be read", error);
    return null;
  }
}
