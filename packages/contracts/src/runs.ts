import * as z from "zod";
import { Id, RunStatus } from "./ids.js";

export const RunActivityRowSchema = z.object({
  runId: Id,
  botId: Id,
  botName: z.string(),
  groupId: Id.nullable(),
  groupName: z.string().nullable(),
  threadId: Id,
  status: RunStatus,
  trigger: z.enum([
    "user",
    "routine",
    "resume",
    "follow_up",
    "reaction",
    "spawn",
    "skill",
    "bot_message",
    "webhook",
    "messaging",
    "cloud_agent",
  ]),
  notificationsEnabled: z.boolean(),
  promptSnippet: z.string(),
  updatedAt: z.string(),
});
export type RunActivityRow = z.infer<typeof RunActivityRowSchema>;

export const RunsListOutputSchema = z.object({
  runs: z.array(RunActivityRowSchema),
});
export type RunsListOutput = z.infer<typeof RunsListOutputSchema>;

export const SectionBoardToolCallSchema = z.object({
  name: z.string(),
  outcome: z.string().nullable(),
  durationMs: z.number().nullable(),
});
export type SectionBoardToolCall = z.infer<typeof SectionBoardToolCallSchema>;

export const SectionBoardRunSchema = RunActivityRowSchema.omit({
  notificationsEnabled: true,
}).extend({
  routineName: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  toolCalls: z.array(SectionBoardToolCallSchema),
});
export type SectionBoardRun = z.infer<typeof SectionBoardRunSchema>;

/** Work a section's bots have queued, are doing, are blocked on, or finished recently. */
export const SectionBoardSchema = z.object({
  runs: z.array(SectionBoardRunSchema),
  scratchpad: z.array(
    z.object({ id: Id, botId: Id, botName: z.string(), title: z.string(), updatedAt: z.string() }),
  ),
  routines: z.array(
    z.object({ id: Id, botId: Id, botName: z.string(), name: z.string(), nextRunAt: z.string() }),
  ),
});
export type SectionBoard = z.infer<typeof SectionBoardSchema>;
