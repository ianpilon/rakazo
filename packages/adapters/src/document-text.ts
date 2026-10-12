import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";

/**
 * Text of an attached document, extracted on the bot's computer so the model reads it in the
 * turn instead of being trusted to open the file. Small models often skip that step and then
 * claim the file is too large.
 */

/** Documents up to this many words go straight into the turn (about 8k tokens). */
export const INLINE_DOCUMENT_MAX_WORDS = 6_000;

const MAX_EXTRACT_CHARS = 2_000_000;
const EXTRACT_TIMEOUT_MS = 60_000;

const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Word files are zipped XML: paragraphs end at </w:p>, tabs are <w:tab/>.
const DOCX_TO_TEXT = [
  "import html, re, sys, zipfile",
  "x = zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode('utf-8', 'replace')",
  "x = x.replace('</w:p>', '\\n').replace('<w:tab/>', '\\t')",
  "print(html.unescape(re.sub(r'<[^>]+>', '', x)))",
].join("\n");

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function isReadableDocument(mimeType: string): boolean {
  return TEXT_TYPES.has(mimeType) || mimeType === "application/pdf" || mimeType === DOCX_TYPE;
}

export async function extractDocumentText(
  deps: { sandbox: SandboxProvider },
  computer: ComputerRef,
  file: { path: string; mimeType: string; bytes: Uint8Array },
  context: AdapterContext,
): Promise<string | null> {
  try {
    if (TEXT_TYPES.has(file.mimeType)) {
      return new TextDecoder().decode(file.bytes).slice(0, MAX_EXTRACT_CHARS);
    }
    const argv =
      file.mimeType === "application/pdf"
        ? ["pdftotext", file.path, "-"]
        : file.mimeType === DOCX_TYPE
          ? ["python3", "-c", DOCX_TO_TEXT, file.path]
          : null;
    if (!argv) return null;
    let out = "";
    let err = "";
    let code = -1;
    for await (const event of deps.sandbox.execute(
      computer,
      { argv, timeoutMs: EXTRACT_TIMEOUT_MS },
      context,
    )) {
      if (event.type === "stdout" && out.length < MAX_EXTRACT_CHARS) out += event.data;
      if (event.type === "stderr" && err.length < 2000) err += event.data;
      if (event.type === "exit") code = event.code;
    }
    if (code !== 0) {
      getLogger().warn("document text extraction failed", { argv0: argv[0], code, stderr: err });
      return null;
    }
    // pdftotext separates pages with form feeds: mark each page so page questions can be answered.
    const pages = out.split("\f");
    const text =
      pages.length > 1
        ? pages
            .map((page, i) => (page.trim() ? `--- page ${i + 1} ---\n${page.trim()}` : ""))
            .filter(Boolean)
            .join("\n\n")
        : out.trim();
    if (text) getLogger().info("document text extracted", { argv0: argv[0], chars: text.length });
    return text || null;
  } catch (error) {
    getLogger().warn("document text extraction failed", { error: String(error) });
    return null;
  }
}
