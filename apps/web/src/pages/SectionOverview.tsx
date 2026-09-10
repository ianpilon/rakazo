import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, BotSection, Group, SectionBoardRun } from "@rakazo/contracts";
import { BOT_SECTION_GOAL_MAX_LENGTH } from "@rakazo/contracts";
import { BotAvatar, Button, Textarea } from "@rakazo/ui-web";
import { Users } from "lucide-react";
import { useId, useState } from "react";
import { SectionBoard } from "./SectionBoard";

/** The page behind a sidebar section: its goal, then the bots and groups that serve it. */
export function SectionOverview({
  section,
  bots,
  groups,
  onOpenBot,
  onOpenGroup,
  onSaveGoal,
  view,
  onChangeView,
}: {
  section: BotSection;
  bots: Bot[];
  groups: Group[];
  onOpenBot: (botId: string) => void;
  onOpenGroup: (groupId: string) => void;
  onSaveGoal: (goal: string) => Promise<void>;
  view: "goal" | "board";
  onChangeView: (view: "goal" | "board") => void;
}) {
  const { t } = useLingui();
  const goalId = useId();
  const saved = section.goal ?? "";
  const [goal, setGoal] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = goal.trim() !== saved;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="section-overview">
      <div
        className={`mx-auto w-full px-6 py-8 ${view === "board" ? "max-w-[1100px]" : "max-w-[640px]"}`}
      >
        <h1 className="text-[22px] font-medium text-foreground" dir="auto">
          {section.name}
        </h1>
        <div role="tablist" className="mt-4 flex gap-1 border-b border-border">
          {(["goal", "board"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={view === tab}
              onClick={() => onChangeView(tab)}
              className="-mb-px border-b-2 border-transparent px-3 py-2 text-[13.5px] text-muted-foreground hover:text-foreground aria-selected:border-foreground aria-selected:text-foreground"
            >
              {tab === "goal" ? t`Goal` : t`Board`}
            </button>
          ))}
        </div>
        {view === "board" ? (
          <div className="mt-6">
            <SectionBoard
              sectionId={section.id}
              onOpenThread={(run: SectionBoardRun) =>
                run.groupId ? onOpenGroup(run.groupId) : onOpenBot(run.botId)
              }
            />
          </div>
        ) : (
          <>
            <form
              className="mt-6"
              onSubmit={(event) => {
                event.preventDefault();
                if (!dirty || saving) return;
                setSaving(true);
                setError(null);
                onSaveGoal(goal.trim())
                  .catch((err: unknown) => {
                    setError(err instanceof Error ? err.message : t`Could not save goal`);
                  })
                  .finally(() => setSaving(false));
              }}
            >
              <label htmlFor={goalId} className="block text-[13.5px] text-foreground/75">
                <Trans>Goal</Trans>
              </label>
              <Textarea
                id={goalId}
                className="mt-1.5"
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                rows={3}
                maxLength={BOT_SECTION_GOAL_MAX_LENGTH}
                disabled={saving}
                dir="auto"
              />
              {dirty ? (
                <div className="mt-2 flex gap-2">
                  <Button type="submit" size="sm" disabled={saving}>
                    <Trans>Save</Trans>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => setGoal(saved)}
                  >
                    <Trans>Cancel</Trans>
                  </Button>
                </div>
              ) : null}
              {error ? (
                <p role="alert" className="mt-2 text-[13px] text-destructive">
                  {error}
                </p>
              ) : null}
            </form>
            <ul className="mt-8 divide-y divide-border">
              {bots.map((bot) => (
                <li key={bot.id}>
                  <button
                    type="button"
                    onClick={() => onOpenBot(bot.id)}
                    className="flex w-full items-center gap-3 rounded-xl px-2 py-3 text-start hover:bg-accent"
                  >
                    <BotAvatar color={bot.color} identity={bot.id} size={38} status={bot.status} />
                    <span className="min-w-0">
                      <span className="block truncate text-[15px] text-foreground" dir="auto">
                        {bot.name}
                      </span>
                      {bot.description ? (
                        <span
                          className="block truncate text-[13px] text-muted-foreground"
                          dir="auto"
                        >
                          {bot.description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
              {groups.map((group) => (
                <li key={group.id}>
                  <button
                    type="button"
                    onClick={() => onOpenGroup(group.id)}
                    className="flex w-full items-center gap-3 rounded-xl px-2 py-3 text-start hover:bg-accent"
                  >
                    <span className="grid size-[38px] shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                      <Users size={18} strokeWidth={1.8} aria-hidden="true" />
                    </span>
                    <span className="block min-w-0 truncate text-[15px] text-foreground" dir="auto">
                      {group.name}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
