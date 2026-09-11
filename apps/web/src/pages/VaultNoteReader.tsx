import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { useCallback, useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import {
  resolveWikilink,
  stripFrontMatter,
  wikilinksToMarkdownLinks,
  wikilinkTarget,
} from "../lib/wikilinks";

const POLL_MS = 15_000;

/**
 * One vault note, rendered. Markdown gets wikilinks resolved against `filePaths`; a wikilink
 * click hands the target path to `onNavigate` so the host decides where it opens. Re-reads the
 * note every 15 seconds so a bot's edit shows up while the note is open.
 */
export function VaultNoteReader({
  botId,
  path,
  filePaths,
  onNavigate,
}: {
  botId: string;
  path: string;
  filePaths: readonly string[];
  onNavigate: (path: string) => void;
}) {
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    const load = async () => {
      try {
        const file = await rpc.computer.readFile({ botId, path });
        if (!cancelled) setContent(file.content);
      } catch (err: unknown) {
        if (!cancelled) setContent(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [botId, path]);

  const onLinkClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const anchor = (event.target as HTMLElement).closest("a");
      const target = wikilinkTarget(anchor?.getAttribute("href"));
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      const resolved = resolveWikilink(target, filePaths);
      if (resolved) onNavigate(resolved);
    },
    [filePaths, onNavigate],
  );

  if (content === null) return null;
  if (!path.toLowerCase().endsWith(".md")) {
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap text-[13px] text-foreground/85">
        {content}
      </pre>
    );
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click delegation for wikilinks rendered by the shared markdown component
    // biome-ignore lint/a11y/useSemanticElements: the links inside are real anchors; this wrapper only intercepts them
    <div onClickCapture={onLinkClick}>
      <ChatMarkdown>{wikilinksToMarkdownLinks(stripFrontMatter(content))}</ChatMarkdown>
    </div>
  );
}
