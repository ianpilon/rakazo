import type { Actor, SectionBoard, SectionBoardToolCall } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { IsolationError, type PrismaClient } from "@rakazo/db";
import { activityPromptSnippet } from "./runs.js";

const DONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_LIMIT = 100;
const TOOL_EVENT_LIMIT = 4000;

type ToolEventPayload = {
  name: string;
  executionId?: string;
  outcome?: string;
  durationMs?: number;
};

function parseToolEventPayload(payload: unknown): ToolEventPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name) return null;
  return {
    name: record.name,
    executionId: typeof record.executionId === "string" ? record.executionId : undefined,
    outcome: typeof record.outcome === "string" ? record.outcome : undefined,
    durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
  };
}

/**
 * Folds `agent.tool.called` / `agent.tool.completed` events (already ordered by seq) into one
 * entry per tool execution, in call order, keyed by executionId so a completion lands on its call.
 */
export function mergeToolEvents(
  events: Array<{ runId: string | null; type: string; payload: unknown }>,
): Map<string, SectionBoardToolCall[]> {
  const byRun = new Map<string, SectionBoardToolCall[]>();
  const byExecution = new Map<string, SectionBoardToolCall>();
  for (const event of events) {
    if (!event.runId) continue;
    const parsed = parseToolEventPayload(event.payload);
    if (!parsed) continue;
    const { name, executionId, outcome, durationMs } = parsed;
    const key = executionId ? `${event.runId}:${executionId}` : null;
    if (event.type === "agent.tool.called") {
      const call: SectionBoardToolCall = { name, outcome: null, durationMs: null };
      byRun.set(event.runId, [...(byRun.get(event.runId) ?? []), call]);
      if (key) byExecution.set(key, call);
      continue;
    }
    if (event.type !== "agent.tool.completed") continue;
    const existing = key ? byExecution.get(key) : undefined;
    if (existing) {
      existing.outcome = outcome ?? null;
      existing.durationMs = durationMs ?? null;
    } else {
      byRun.set(event.runId, [
        ...(byRun.get(event.runId) ?? []),
        { name, outcome: outcome ?? null, durationMs: durationMs ?? null },
      ]);
    }
  }
  return byRun;
}

export async function loadSectionBoard(
  prisma: PrismaClient,
  actor: Actor,
  sectionId: string,
  now = new Date(),
): Promise<SectionBoard> {
  const section = await prisma.botSection.findFirst({
    where: { id: sectionId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true },
  });
  if (!section) throw new IsolationError();
  const [bots, groups] = await Promise.all([
    prisma.bot.findMany({
      where: { sectionId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      select: { id: true, name: true },
    }),
    prisma.chatGroup.findMany({
      where: { sectionId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      select: { id: true },
    }),
  ]);
  const botIds = bots.map((bot) => bot.id);
  const groupIds = groups.map((group) => group.id);
  const botName = new Map(bots.map((bot) => [bot.id, bot.name]));
  if (botIds.length === 0 && groupIds.length === 0) {
    return { runs: [], scratchpad: [], routines: [] };
  }
  const since = new Date(now.getTime() - DONE_WINDOW_MS);
  const [runs, scratchpad, routines] = await Promise.all([
    prisma.run.findMany({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        bot: { archivedAt: null },
        OR: [{ botId: { in: botIds } }, { thread: { groupId: { in: groupIds } } }],
        AND: [
          {
            OR: [
              { status: { in: [...ACTIVE_RUN_STATUSES] } },
              { completedAt: { gte: since } },
              { completedAt: null, updatedAt: { gte: since } },
            ],
          },
        ],
      },
      include: {
        bot: { select: { name: true } },
        task: { select: { prompt: true } },
        sourceMessage: { select: { blocks: true } },
        routine: { select: { name: true } },
        thread: { select: { groupId: true, group: { select: { name: true } } } },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: RUN_LIMIT,
    }),
    botIds.length > 0
      ? prisma.scratchpadItem.findMany({
          where: { botId: { in: botIds }, spaceId: actor.spaceId, status: "open" },
          select: { id: true, botId: true, title: true, updatedAt: true },
          orderBy: { updatedAt: "desc" },
        })
      : [],
    botIds.length > 0
      ? prisma.routine.findMany({
          where: {
            botId: { in: botIds },
            spaceId: actor.spaceId,
            active: true,
            nextRunAt: { not: null },
          },
          select: { id: true, botId: true, name: true, nextRunAt: true },
          orderBy: { nextRunAt: "asc" },
        })
      : [],
  ]);
  const events =
    runs.length > 0
      ? await prisma.event.findMany({
          where: {
            runId: { in: runs.map((run) => run.id) },
            type: { in: ["agent.tool.called", "agent.tool.completed"] },
          },
          select: { runId: true, type: true, payload: true },
          orderBy: [{ threadId: "asc" }, { seq: "asc" }],
          take: TOOL_EVENT_LIMIT,
        })
      : [];
  const toolCalls = mergeToolEvents(events);
  return {
    runs: runs.map((row) => ({
      runId: row.id,
      botId: row.botId,
      botName: row.bot.name,
      groupId: row.thread.groupId,
      groupName: row.thread.group?.name ?? null,
      threadId: row.threadId,
      status: row.status as SectionBoard["runs"][number]["status"],
      trigger: row.trigger as SectionBoard["runs"][number]["trigger"],
      promptSnippet: activityPromptSnippet({
        trigger: row.trigger,
        prompt: row.task.prompt,
        sourceBlocks: row.sourceMessage?.blocks,
      }),
      routineName: row.routine?.name ?? null,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      toolCalls: toolCalls.get(row.id) ?? [],
    })),
    scratchpad: scratchpad.map((item) => ({
      id: item.id,
      botId: item.botId,
      botName: botName.get(item.botId) ?? "",
      title: item.title,
      updatedAt: item.updatedAt.toISOString(),
    })),
    routines: routines.flatMap((routine) =>
      routine.nextRunAt
        ? [
            {
              id: routine.id,
              botId: routine.botId,
              botName: botName.get(routine.botId) ?? "",
              name: routine.name,
              nextRunAt: routine.nextRunAt.toISOString(),
            },
          ]
        : [],
    ),
  };
}
