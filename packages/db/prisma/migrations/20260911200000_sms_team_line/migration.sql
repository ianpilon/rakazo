-- One SMS line for the whole team: a bot no longer owns its messaging identity exclusively.
DROP INDEX "messaging_identities_botId_key";
CREATE INDEX "messaging_identities_botId_idx" ON "messaging_identities"("botId");

ALTER TABLE "bots" ADD COLUMN "smsSendAllowed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bots" ADD COLUMN "smsGrantAllowed" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "messaging_provider_configs" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "secretId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "messaging_provider_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "messaging_provider_configs_secretId_key" ON "messaging_provider_configs"("secretId");
CREATE UNIQUE INDEX "messaging_provider_configs_spaceId_provider_key" ON "messaging_provider_configs"("spaceId", "provider");
ALTER TABLE "messaging_provider_configs" ADD CONSTRAINT "messaging_provider_configs_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messaging_provider_configs" ADD CONSTRAINT "messaging_provider_configs_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
