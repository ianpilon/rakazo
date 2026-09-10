import { Trans, useLingui } from "@lingui/react/macro";
import type { SectionBoard as SectionBoardData, SectionBoardRun } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { formatRelativeTime, statusLabel, statusTone } from "./ActivityList";

const POLL_MS = 5_000;

type Column = "todo" | "doing" | "waiting" | "done";

export function boardColumn(status: SectionBoardRun["status"]): Column {
  switch (status) {
    case "queued":
      return "todo";
    case "leased":
    case "running":
      return "doing";
    case "waiting_input":
    case "waiting_takeover":
      return "waiting";
    default:
      return "done";
  }
}

function durationLabel(run: SectionBoardRun): string | null {
  if (!run.startedAt) return null;
  const end = run.completedAt ? new Date(run.completedAt) : new Date();
  const seconds = Math.round((end.getTime() - new Date(run.startedAt).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Work by a section's bots, moving on its own between To do, Doing, Waiting on you, and Done. */
export function SectionBoard({
  sectionId,
  onOpenThread,
}: {
  sectionId: string;
  onOpenThread: (run: SectionBoardRun) => void;
}) {
  const { t } = useLingui();
  const [board, setBoard] = useState<SectionBoardData | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const next = await rpc.botSections.board({ sectionId });
        if (!cancelled) setBoard(next);
      } catch {
        // Keep the last good snapshot on transient RPC failures.
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void tick(), POLL_MS);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [sectionId]);

  const columns: Array<{ key: Column; label: string }> = [
    { key: "todo", label: t`To do` },
    { key: "doing", label: t`Doing` },
    { key: "waiting", label: t`Waiting on you` },
    { key: "done", label: t`Done` },
  ];
  const runsBy = (column: Column) =>
    (board?.runs ?? []).filter((run) => boardColumn(run.status) === column);

  return (
    <div className="grid gap-4 md:grid-cols-4" data-testid="section-board">
      {columns.map((column) => {
        const runs = runsBy(column.key);
        const extras =
          column.key === "todo"
            ? (board?.scratchpad.length ?? 0) + (board?.routines.length ?? 0)
            : 0;
        return (
          <section key={column.key} aria-label={column.label} className="min-w-0">
            <h2 className="mb-2 flex items-baseline gap-2 text-[13px] font-medium text-muted-foreground">
              {column.label}
              <span className="text-muted-foreground/60">{runs.length + extras}</span>
            </h2>
            <ul className="flex flex-col gap-2">
              {column.key === "todo"
                ? (board?.routines ?? []).map((routine) => (
                    <li
                      key={routine.id}
                      className="rounded-xl border border-border bg-card px-3 py-2.5 text-[13px]"
                    >
                      <div className="font-medium text-foreground" dir="auto">
                        {routine.botName}
                      </div>
                      <div className="text-muted-foreground" dir="auto">
                        {routine.name}
                      </div>
                      <div className="mt-1 text-[12px] text-muted-foreground/70">
                        {new Date(routine.nextRunAt).toLocaleString()}
                      </div>
                    </li>
                  ))
                : null}
              {column.key === "todo"
                ? (board?.scratchpad ?? []).map((item) => (
                    <li
                      key={item.id}
                      className="rounded-xl border border-border bg-card px-3 py-2.5 text-[13px]"
                    >
                      <div className="font-medium text-foreground" dir="auto">
                        {item.botName}
                      </div>
                      <div className="text-muted-foreground" dir="auto">
                        {item.title}
                      </div>
                    </li>
                  ))
                : null}
              {runs.map((run) => (
                <RunCard
                  key={run.runId}
                  run={run}
                  open={openRunId === run.runId}
                  onToggle={() => setOpenRunId(openRunId === run.runId ? null : run.runId)}
                  onOpenThread={() => onOpenThread(run)}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function RunCard({
  run,
  open,
  onToggle,
  onOpenThread,
}: {
  run: SectionBoardRun;
  open: boolean;
  onToggle: () => void;
  onOpenThread: () => void;
}) {
  const { t } = useLingui();
  const title = run.groupName ? `${run.botName} · ${run.groupName}` : run.botName;
  const duration = durationLabel(run);
  const when = formatRelativeTime(run.completedAt ?? run.updatedAt);
  return (
    <li className="rounded-xl border border-border bg-card text-[13px]">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t`${title}, ${statusLabel(run.status)}`}
        onClick={onToggle}
        className="flex w-full gap-2 rounded-xl px-3 py-2.5 text-start hover:bg-accent"
      >
        <span
          className={`mt-1.5 size-2 shrink-0 rounded-full bg-current ${statusTone(run.status)}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-foreground" dir="auto">
            {title}
          </span>
          <span className="line-clamp-2 text-muted-foreground" dir="auto">
            {run.promptSnippet}
          </span>
          <span className="mt-1 block text-[12px] text-muted-foreground/70">
            {[run.routineName ?? (run.trigger === "user" ? t`You` : null), when, duration]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
      </button>
      {open ? (
        <div className="border-t border-border px-3 py-2.5">
          {run.error ? (
            <p className="mb-2 text-destructive" dir="auto">
              {run.error}
            </p>
          ) : null}
          {run.toolCalls.length > 0 ? (
            <ol className="mb-2 flex flex-col gap-1 text-[12.5px] text-muted-foreground">
              {run.toolCalls.map((call, index) => (
                <li key={`${run.runId}:${index}`} className="flex justify-between gap-2">
                  <span className="truncate font-mono text-foreground/80">{call.name}</span>
                  <span className="shrink-0">
                    {[
                      call.outcome === "failed" ? t`failed` : null,
                      call.durationMs != null
                        ? `${Math.max(1, Math.round(call.durationMs / 100) / 10)}s`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mb-2 text-[12.5px] text-muted-foreground">
              <Trans>No tool calls</Trans>
            </p>
          )}
          <Button size="sm" variant="outline" onClick={onOpenThread}>
            <Trans>Open thread</Trans>
          </Button>
        </div>
      ) : null}
    </li>
  );
}
