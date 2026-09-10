import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Tool results newer than this many stay complete (subject to the kept cap). */
export const RECENT_TOOL_RESULTS_TO_KEEP = 6;
/** An older result longer than this is cut to a short head plus a note. */
export const STALE_TOOL_RESULT_MAX_CHARS = 1_500;
/** How much of a stale result survives, so the model still knows what it saw. */
export const STALE_TOOL_RESULT_HEAD_CHARS = 600;
/** Even a recent result is capped so one huge file read cannot fill the window. */
export const KEPT_TOOL_RESULT_MAX_CHARS = 24_000;

type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;

/**
 * Keeps a run's model context bounded as tool calls accumulate. Every model call in a run
 * resends every prior tool result, so a long run climbs from a few thousand tokens to the
 * whole window. Older results are working material the model already acted on: they are
 * shortened to a head plus a note that says how to get the full output back. The newest
 * results stay intact (capped) because the model is still reasoning over them. Returns the
 * same array when nothing needs trimming.
 */
export function pruneStaleToolResults(
  messages: AgentMessage[],
  options: {
    keepRecent?: number;
    staleMaxChars?: number;
    staleHeadChars?: number;
    keptMaxChars?: number;
  } = {},
): AgentMessage[] {
  const keepRecent = options.keepRecent ?? RECENT_TOOL_RESULTS_TO_KEEP;
  const staleMaxChars = options.staleMaxChars ?? STALE_TOOL_RESULT_MAX_CHARS;
  const staleHeadChars = options.staleHeadChars ?? STALE_TOOL_RESULT_HEAD_CHARS;
  const keptMaxChars = options.keptMaxChars ?? KEPT_TOOL_RESULT_MAX_CHARS;
  let recentSeen = 0;
  let transformed: AgentMessage[] | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "toolResult") continue;
    const text = message.content
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    recentSeen += 1;
    const isRecent = recentSeen <= keepRecent;
    const limit = isRecent ? keptMaxChars : staleMaxChars;
    if (text.length <= limit) continue;
    const head = isRecent ? keptMaxChars : staleHeadChars;
    const trimmed = `${text.slice(0, head)}\n…[${text.length - head} more characters of this earlier ${message.toolName} result were trimmed from context; call the tool again if you need the full output]`;
    transformed ??= [...messages];
    transformed[index] = {
      ...message,
      content: [
        { type: "text", text: trimmed },
        ...message.content.filter((part) => part.type !== "text"),
      ],
    } satisfies ToolResult;
  }
  return transformed ?? messages;
}
