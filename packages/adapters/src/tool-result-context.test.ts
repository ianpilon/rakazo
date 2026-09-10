import { describe, expect, it } from "vitest";
import { pruneStaleToolResults } from "./tool-result-context.js";

function toolResult(id: string, text: string) {
  return {
    role: "toolResult" as const,
    toolCallId: id,
    toolName: "shell",
    content: [{ type: "text" as const, text }],
    isError: false,
    timestamp: 1,
  };
}

function textOf(message: ReturnType<typeof toolResult>) {
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("pruneStaleToolResults", () => {
  it("trims long results older than the recent window and keeps the newest intact", () => {
    const big = "x".repeat(5_000);
    const messages = ["a", "b", "c", "d"].map((id) => toolResult(id, big));
    const pruned = pruneStaleToolResults(messages, { keepRecent: 2, staleHeadChars: 100 });
    const texts = pruned.map((message) => textOf(message as ReturnType<typeof toolResult>));
    expect(texts[0]).toMatch(/^x{100}\n…\[4900 more characters of this earlier shell result/);
    expect(texts[1]).toMatch(/trimmed from context/);
    expect(texts[2]).toBe(big);
    expect(texts[3]).toBe(big);
  });

  it("leaves short stale results alone and reuses the array when nothing changes", () => {
    const messages = ["a", "b", "c"].map((id) => toolResult(id, "ok"));
    expect(pruneStaleToolResults(messages, { keepRecent: 1 })).toBe(messages);
  });

  it("caps even a recent result that alone could fill the window", () => {
    const messages = [toolResult("a", "y".repeat(30_000))];
    const pruned = pruneStaleToolResults(messages, { keptMaxChars: 1_000 });
    expect(textOf(pruned[0] as ReturnType<typeof toolResult>)).toMatch(/^y{1000}\n…\[29000 more/);
  });

  it("keeps non-text parts such as screenshots on trimmed results", () => {
    const messages = [
      {
        ...toolResult("a", "z".repeat(3_000)),
        content: [
          { type: "text" as const, text: "z".repeat(3_000) },
          { type: "image" as const, data: "img", mimeType: "image/png" as const },
        ],
      },
      toolResult("b", "recent"),
    ];
    const pruned = pruneStaleToolResults(messages, { keepRecent: 1 });
    expect((pruned[0] as { content: Array<{ type: string }> }).content.map((p) => p.type)).toEqual([
      "text",
      "image",
    ]);
  });
});
