import { describe, expect, it } from "vitest";
import { mergeToolEvents } from "./section-board.js";

describe("mergeToolEvents", () => {
  it("pairs completions with their calls in call order, per run", () => {
    const merged = mergeToolEvents([
      { runId: "r1", type: "agent.tool.called", payload: { name: "shell", executionId: "a" } },
      { runId: "r1", type: "agent.tool.called", payload: { name: "web_fetch", executionId: "b" } },
      {
        runId: "r1",
        type: "agent.tool.completed",
        payload: { name: "web_fetch", executionId: "b", outcome: "succeeded", durationMs: 40 },
      },
      {
        runId: "r1",
        type: "agent.tool.completed",
        payload: { name: "shell", executionId: "a", outcome: "failed", durationMs: 900 },
      },
      { runId: "r2", type: "agent.tool.called", payload: { name: "remember", executionId: "c" } },
      { runId: null, type: "agent.tool.called", payload: { name: "ignored" } },
      { runId: "r2", type: "run.started", payload: {} },
    ]);
    expect(merged.get("r1")).toEqual([
      { name: "shell", outcome: "failed", durationMs: 900 },
      { name: "web_fetch", outcome: "succeeded", durationMs: 40 },
    ]);
    expect(merged.get("r2")).toEqual([{ name: "remember", outcome: null, durationMs: null }]);
  });

  it("keeps a completion whose call was not logged", () => {
    const merged = mergeToolEvents([
      {
        runId: "r1",
        type: "agent.tool.completed",
        payload: { name: "shell", outcome: "succeeded" },
      },
    ]);
    expect(merged.get("r1")).toEqual([{ name: "shell", outcome: "succeeded", durationMs: null }]);
  });
});
