import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Bot,
  ExternalConversation,
  MessagingAgentConnection,
  MessagingChannelMembership,
  MessagingStatus,
  SmsLineStatus,
} from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { providerLabel } from "../lib/messaging";
import { rpc } from "../lib/rpc";
import { ExternalConversationSettings } from "./ExternalConversationSettings";

export function MessagingSettingsOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const [status, setStatus] = useState<MessagingStatus | null>(null);
  const [channels, setChannels] = useState<MessagingChannelMembership[]>([]);
  const [connections, setConnections] = useState<MessagingAgentConnection[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [externalConversations, setExternalConversations] = useState<ExternalConversation[]>([]);
  const [settingsConversationId, setSettingsConversationId] = useState<string | null>(null);
  const [linkBotId, setLinkBotId] = useState("");
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [smsLine, setSmsLine] = useState<SmsLineStatus | null>(null);

  async function refresh() {
    const [nextStatus, nextChannels, nextConnections, nextBots, navigation, nextSmsLine] =
      await Promise.all([
        rpc.messaging.status(),
        rpc.messaging.channels.list(),
        rpc.messaging.connections.list(),
        rpc.bots.list(),
        rpc.spaces.list(),
        rpc.messaging.sms.status().catch(() => null),
      ]);
    setStatus(nextStatus);
    setSmsLine(nextSmsLine);
    setChannels(nextChannels);
    setConnections(nextConnections);
    setBots(nextBots);
    setExternalConversations(navigation.current.externalConversations);
  }

  useEffect(() => {
    void refresh().catch(() => setError(t`Couldn't load messaging settings`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function act(action: () => Promise<unknown>) {
    setError(null);
    // A displayed code must always match the current selection and link
    // state; the link action re-sets it after issuing.
    setLinkCode(null);
    try {
      await action();
      await refresh();
    } catch {
      setError(t`Couldn't update messaging settings`);
    }
  }

  const agentByIdentity = new Map(status?.identities.map((i) => [i.id, i.botName]) ?? []);
  function channelMeta(channel: MessagingChannelMembership): string {
    return [
      providerLabel(channel.provider),
      // Only meaningful once a second chat app is linked: the same group can
      // then hold two of the caller's memberships, one per agent.
      agentByIdentity.size > 1 ? agentByIdentity.get(channel.identityId) : undefined,
      channel.status,
      String(channel.memberCount),
    ]
      .filter(Boolean)
      .join(" · ");
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="messaging-settings"
        showCloseButton={false}
        className="rk-scroll block max-h-[calc(100%-2rem)] w-[640px] overflow-y-auto rounded-2xl p-6 sm:max-h-[calc(100%-5rem)] sm:max-w-[calc(100%-5rem)] sm:p-8"
      >
        <div className="flex items-start justify-between gap-6">
          <DialogTitle className="text-2xl font-medium text-foreground">
            <Trans>Messaging</Trans>
          </DialogTitle>
          <DialogClose
            aria-label={t`Close messaging settings`}
            render={<Button variant="ghost" size="icon-sm" />}
          >
            <XIcon />
          </DialogClose>
        </div>

        {error ? <p className="mt-4 text-[13px] text-destructive">{error}</p> : null}

        {status?.providers.includes("twilio") ? <SmsLineSection line={smsLine} act={act} /> : null}

        <section className="mt-8 rounded-xl border border-border px-4 py-4">
          <h3 className="text-[15px] font-medium text-foreground">
            <Trans>Chat apps</Trans>
          </h3>
          {status ? (
            <p className="mt-3 text-[13px] text-muted-foreground/70">
              {status.providers.map(providerLabel).join(" · ")}
            </p>
          ) : null}
          {status?.identities.length ? (
            <ul className="mt-3 space-y-3">
              {status.identities.map((identity) => (
                <li
                  key={identity.id}
                  className="flex items-center justify-between gap-3 text-[14px] text-foreground/75"
                >
                  <span>
                    {providerLabel(identity.provider)} · {identity.address}{" "}
                    <span className="text-[12px] text-muted-foreground/70">
                      → {identity.botName}
                    </span>
                  </span>
                  <Button
                    variant="secondary"
                    className="rounded-full"
                    onClick={() =>
                      void act(() => rpc.messaging.identities.unlink({ identityId: identity.id }))
                    }
                  >
                    <Trans>Unlink</Trans>
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[14px] text-foreground/75">
              <Trans>No chat apps linked yet.</Trans>
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <NativeSelect
              aria-label={t`Bot to link`}
              value={linkBotId}
              onChange={(event) => {
                setLinkBotId(event.target.value);
                setLinkCode(null);
              }}
            >
              <NativeSelectOption value="">{t`Choose a bot…`}</NativeSelectOption>
              {bots.map((bot) => (
                <NativeSelectOption key={bot.id} value={bot.id}>
                  {bot.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button
              className="rounded-full"
              disabled={!linkBotId}
              onClick={() =>
                void act(async () => {
                  const issued = await rpc.messaging.link.start({ botId: linkBotId });
                  setLinkCode(issued.code);
                })
              }
            >
              <Trans>Link a chat app</Trans>
            </Button>
          </div>
          {linkCode ? (
            <p className="mt-3 text-[14px] text-foreground/75" data-testid="messaging-link-code">
              <Trans>
                Send <span className="font-mono text-foreground">{linkCode}</span> to the line from
                your chat app within 10 minutes. You'll get a confirmation reply once linked.
              </Trans>
            </p>
          ) : null}
        </section>

        <section className="mt-5 rounded-xl border border-border px-4 py-4">
          <h3 className="text-[15px] font-medium text-foreground">
            <Trans>Channels</Trans>
          </h3>
          {channels.length === 0 ? (
            <p className="mt-3 text-[13px] text-muted-foreground/70">
              <Trans>No group chats yet.</Trans>
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {channels.map((channel) => (
                <li
                  key={channel.id}
                  className="flex items-center justify-between gap-3 text-[14px] text-foreground/75"
                >
                  <span>
                    {channel.name ?? t`Group`}{" "}
                    <span className="text-[12px] text-muted-foreground/70">
                      {channelMeta(channel)}
                    </span>
                  </span>
                  <span className="flex gap-2">
                    {channel.status === "invited" ? (
                      <>
                        <Button
                          className="rounded-full"
                          onClick={() =>
                            void act(() =>
                              rpc.messaging.channels.respond({
                                membershipId: channel.id,
                                accept: true,
                              }),
                            )
                          }
                        >
                          <Trans>Approve</Trans>
                        </Button>
                        <Button
                          variant="secondary"
                          className="rounded-full"
                          onClick={() =>
                            void act(() =>
                              rpc.messaging.channels.respond({
                                membershipId: channel.id,
                                accept: false,
                              }),
                            )
                          }
                        >
                          <Trans>Decline</Trans>
                        </Button>
                      </>
                    ) : null}
                    {channel.status === "approved" ? (
                      <Button
                        variant="secondary"
                        className="rounded-full"
                        onClick={() =>
                          void act(() => rpc.messaging.channels.leave({ membershipId: channel.id }))
                        }
                      >
                        <Trans>Leave</Trans>
                      </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-5 rounded-xl border border-border px-4 py-4">
          <h3 className="text-[15px] font-medium text-foreground">
            <Trans>Agent connections</Trans>
          </h3>
          {connections.length === 0 ? (
            <p className="mt-3 text-[13px] text-muted-foreground/70">
              <Trans>No agent connections yet.</Trans>
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {connections.map((connection) => (
                <li
                  key={connection.id}
                  className="flex items-center justify-between gap-3 text-[14px] text-foreground/75"
                >
                  <span>
                    {connection.peerOwnerLabel}
                    {"'s "}
                    {connection.peerBotName}{" "}
                    <span className="text-[12px] text-muted-foreground/70">
                      {connection.status}
                    </span>
                  </span>
                  <span className="flex gap-2">
                    {connection.status === "pending" && connection.incoming ? (
                      <>
                        <Button
                          className="rounded-full"
                          onClick={() =>
                            void act(() =>
                              rpc.messaging.connections.respond({
                                connectionId: connection.id,
                                accept: true,
                              }),
                            )
                          }
                        >
                          <Trans>Approve</Trans>
                        </Button>
                        <Button
                          variant="secondary"
                          className="rounded-full"
                          onClick={() =>
                            void act(() =>
                              rpc.messaging.connections.respond({
                                connectionId: connection.id,
                                accept: false,
                              }),
                            )
                          }
                        >
                          <Trans>Decline</Trans>
                        </Button>
                      </>
                    ) : null}
                    {connection.status === "approved" ? (
                      <Button
                        variant="secondary"
                        className="rounded-full"
                        onClick={() =>
                          void act(() =>
                            rpc.messaging.connections.revoke({ connectionId: connection.id }),
                          )
                        }
                      >
                        <Trans>Revoke</Trans>
                      </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-5 rounded-xl border border-border px-4 py-4">
          <h3 className="text-[15px] font-medium text-foreground">
            <Trans>Team conversations</Trans>
          </h3>
          {externalConversations.length === 0 ? (
            <p className="mt-3 text-[13px] text-muted-foreground/70">
              <Trans>No team conversations yet.</Trans>
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {externalConversations.map((conversation) => {
                const bot = bots.find((candidate) => candidate.id === conversation.botId);
                const open = settingsConversationId === conversation.id;
                return (
                  <li key={conversation.id} className="text-[14px] text-foreground/75">
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate">
                        {conversation.displayName || t`External conversation`}
                        <span className="ml-2 text-[12px] text-muted-foreground/70">
                          {providerLabel(conversation.provider)}
                        </span>
                      </span>
                      <Button
                        variant="secondary"
                        className="rounded-full"
                        onClick={() => setSettingsConversationId(open ? null : conversation.id)}
                      >
                        {open ? <Trans>Close</Trans> : <Trans>Settings</Trans>}
                      </Button>
                    </div>
                    {open && bot ? (
                      <div className="mt-4 rounded-lg border border-border px-3 py-3">
                        <ExternalConversationSettings
                          conversation={conversation}
                          bot={bot}
                          onSave={async (policy) => {
                            await rpc.externalConversations.updatePolicy({
                              externalConversationId: conversation.id,
                              ...policy,
                            });
                            await refresh();
                          }}
                        />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The space's SMS line: one Twilio number every allowed bot texts from. Credentials go
 * straight to the server and are stored encrypted; the token is never shown back.
 */
function SmsLineSection({
  line,
  act,
}: {
  line: SmsLineStatus | null;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useLingui();
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [fromNumber, setFromNumber] = useState("");
  const [editing, setEditing] = useState(false);
  const configured = Boolean(line?.configured) && !editing;

  return (
    <section
      className="mt-8 rounded-xl border border-border px-4 py-4"
      data-testid="sms-line-settings"
    >
      <h3 className="text-[15px] font-medium text-foreground">
        <Trans>Text messages</Trans>
      </h3>
      {configured ? (
        <>
          <p className="mt-3 text-[14px] text-foreground/75">{line?.fromNumber}</p>
          <p className="mt-2 text-[13px] text-muted-foreground/70">
            <Trans>
              In Twilio, set the number's messaging webhook to{" "}
              <span className="font-mono text-foreground">{line?.webhookUrl}</span>
            </Trans>
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" className="rounded-full" onClick={() => setEditing(true)}>
              <Trans>Change</Trans>
            </Button>
            <Button
              variant="secondary"
              className="rounded-full"
              onClick={() => void act(() => rpc.messaging.sms.disconnect())}
            >
              <Trans>Disconnect</Trans>
            </Button>
          </div>
        </>
      ) : (
        <form
          className="mt-3 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await rpc.messaging.sms.configure({ accountSid, authToken, fromNumber });
              setAuthToken("");
              setEditing(false);
            });
          }}
        >
          <Input
            aria-label={t`Twilio account SID`}
            placeholder={t`Account SID`}
            value={accountSid}
            onChange={(event) => setAccountSid(event.target.value)}
            autoComplete="off"
          />
          <Input
            aria-label={t`Twilio auth token`}
            placeholder={t`Auth token`}
            type="password"
            value={authToken}
            onChange={(event) => setAuthToken(event.target.value)}
            autoComplete="off"
          />
          <Input
            aria-label={t`Sending number`}
            placeholder="+12495550123"
            value={fromNumber}
            onChange={(event) => setFromNumber(event.target.value)}
            autoComplete="off"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              className="rounded-full"
              disabled={!accountSid || !authToken || !fromNumber}
            >
              <Trans>Save</Trans>
            </Button>
            {editing ? (
              <Button
                type="button"
                variant="secondary"
                className="rounded-full"
                onClick={() => setEditing(false)}
              >
                <Trans>Cancel</Trans>
              </Button>
            ) : null}
          </div>
        </form>
      )}
    </section>
  );
}
