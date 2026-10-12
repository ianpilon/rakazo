-- An admin bot may archive or delete the owner's other bots, each time with the owner's approval.
ALTER TABLE "bots" ADD COLUMN "manageBotsAllowed" BOOLEAN NOT NULL DEFAULT false;
