import type {
  AdapterContext,
  ComputerRef,
  ProcessEvent,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { countWords, extractDocumentText } from "./document-text.js";
import { currentTurnFilesInstruction } from "./thread-artifacts.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
} satisfies AdapterContext;
const computer = { id: "computer-1", kind: "container" } as unknown as ComputerRef;

function sandboxPrinting(stdout: string, code = 0) {
  const calls: string[][] = [];
  const sandbox = {
    async *execute(_computer: ComputerRef, request: { argv: string[] }) {
      calls.push(request.argv);
      yield { type: "stdout", data: stdout } satisfies ProcessEvent;
      yield { type: "exit", code } satisfies ProcessEvent;
    },
  } as unknown as SandboxProvider;
  return { sandbox, calls };
}

describe("document text for the turn", () => {
  it("reads a PDF with pdftotext on the bot's computer, pages as breaks", async () => {
    const { sandbox, calls } = sandboxPrinting("Page one.\fPage two.");
    const text = await extractDocumentText(
      { sandbox },
      computer,
      { path: "/w/a.pdf", mimeType: "application/pdf", bytes: new Uint8Array() },
      context,
    );
    expect(calls[0]).toEqual(["pdftotext", "/w/a.pdf", "-"]);
    expect(text).toBe("--- page 1 ---\nPage one.\n\n--- page 2 ---\nPage two.");
  });

  it("decodes plain text without the computer and gives up quietly on a failed tool", async () => {
    const { sandbox } = sandboxPrinting("", 1);
    const plain = await extractDocumentText(
      { sandbox },
      computer,
      { path: "/w/a.md", mimeType: "text/markdown", bytes: new TextEncoder().encode("# Hi") },
      context,
    );
    const failed = await extractDocumentText(
      { sandbox },
      computer,
      { path: "/w/a.pdf", mimeType: "application/pdf", bytes: new Uint8Array() },
      context,
    );
    expect(plain).toBe("# Hi");
    expect(failed).toBeNull();
  });

  it("puts a short document in the turn and sends a long one to digest", () => {
    const short = currentTurnFilesInstruction([
      {
        name: "a.pdf",
        mimeType: "application/pdf",
        size: 10,
        path: "attachments/a.pdf",
        words: 2,
        text: "Two words",
      },
    ]);
    const long = currentTurnFilesInstruction([
      {
        name: "b.pdf",
        mimeType: "application/pdf",
        size: 10,
        path: "attachments/b.pdf",
        words: 90_000,
      },
    ]);
    expect(short).toContain("<<<DOCUMENT\nTwo words\nDOCUMENT>>>");
    expect(long).toContain('digest "attachments/b.pdf"');
    expect(long).not.toContain("<<<DOCUMENT");
    expect(countWords("  one two\nthree ")).toBe(3);
  });
});
