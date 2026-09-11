import { Trans } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { ChevronDown, ChevronRight, FileText, Folder } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { rpc } from "../lib/rpc";
import {
  resolveWikilink,
  stripFrontMatter,
  wikilinksToMarkdownLinks,
  wikilinkTarget,
} from "../lib/wikilinks";

const ROOT = "shared";
const POLL_MS = 15_000;
const MAX_ENTRIES = 2_000;
const MAX_DEPTH = 8;

type Entry = { path: string; kind: "file" | "dir"; size: number };

/** Every entry under the shared folder, so the tree, wikilinks, and growth stay one snapshot. */
async function walk(botId: string): Promise<Entry[]> {
  const out: Entry[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: ROOT, depth: 0 }];
  while (queue.length > 0 && out.length < MAX_ENTRIES) {
    const next = queue.shift();
    if (!next) break;
    const entries = await rpc.computer.files({ botId, path: next.path });
    for (const entry of entries) {
      if (entry.path.split("/").some((segment) => segment.startsWith("."))) continue;
      out.push(entry);
      if (entry.kind === "dir" && next.depth < MAX_DEPTH) {
        queue.push({ path: entry.path, depth: next.depth + 1 });
      }
    }
  }
  return out;
}

/** Read-only view of the bots' shared folder: a folder tree and a note reader with wikilinks. */
export function SectionVault({
  botId,
  initialPath,
}: {
  botId: string;
  initialPath: string | null;
}) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [openPath, setOpenPath] = useState<string | null>(initialPath);
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const next = await walk(botId);
        if (!cancelled) {
          setEntries(next);
          setError(null);
        }
      } catch (err: unknown) {
        if (!cancelled && entries === null) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void tick(), POLL_MS);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // The poll owns its own lifetime; `entries` is read only for the first-error decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  useEffect(() => {
    if (!openPath) return;
    let cancelled = false;
    const load = async () => {
      try {
        const file = await rpc.computer.readFile({ botId, path: openPath });
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
  }, [botId, openPath]);

  const filePaths = useMemo(
    () => (entries ?? []).filter((entry) => entry.kind === "file").map((entry) => entry.path),
    [entries],
  );
  const childrenOf = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const entry of entries ?? []) {
      const parent = entry.path.slice(0, entry.path.lastIndexOf("/")) || ROOT;
      map.set(parent, [...(map.get(parent) ?? []), entry]);
    }
    for (const list of map.values()) {
      list.sort((a, b) =>
        a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "dir" ? -1 : 1,
      );
    }
    return map;
  }, [entries]);

  const onLinkClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const anchor = (event.target as HTMLElement).closest("a");
      const target = wikilinkTarget(anchor?.getAttribute("href"));
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      const resolved = resolveWikilink(target, filePaths);
      if (resolved) setOpenPath(resolved);
    },
    [filePaths],
  );

  const renderTree = (dir: string, depth: number): React.ReactNode =>
    (childrenOf.get(dir) ?? []).map((entry) => {
      const name = entry.path.split("/").pop() ?? entry.path;
      const isDir = entry.kind === "dir";
      const isCollapsed = collapsed.has(entry.path);
      return (
        <li key={entry.path}>
          <button
            type="button"
            aria-expanded={isDir ? !isCollapsed : undefined}
            aria-current={!isDir && openPath === entry.path ? "true" : undefined}
            onClick={() => {
              if (isDir) {
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(entry.path)) next.delete(entry.path);
                  else next.add(entry.path);
                  return next;
                });
              } else {
                setOpenPath(entry.path);
              }
            }}
            className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-start text-[13px] text-foreground/85 hover:bg-accent aria-[current=true]:bg-accent aria-[current=true]:text-foreground"
            style={{ paddingInlineStart: `${8 + depth * 14}px` }}
          >
            {isDir ? (
              isCollapsed ? (
                <ChevronRight size={13} aria-hidden="true" className="shrink-0" />
              ) : (
                <ChevronDown size={13} aria-hidden="true" className="shrink-0" />
              )
            ) : (
              <FileText size={13} aria-hidden="true" className="shrink-0 text-muted-foreground" />
            )}
            {isDir ? (
              <Folder size={13} aria-hidden="true" className="shrink-0 text-muted-foreground" />
            ) : null}
            <span className="truncate" dir="auto">
              {isDir ? name : name.replace(/\.md$/i, "")}
            </span>
          </button>
          {isDir && !isCollapsed ? <ul>{renderTree(entry.path, depth + 1)}</ul> : null}
        </li>
      );
    });

  const isMarkdown = openPath?.toLowerCase().endsWith(".md") ?? false;

  return (
    <div className="grid gap-6 md:grid-cols-[260px_minmax(0,1fr)]" data-testid="section-vault">
      <nav aria-label="Vault" className="min-w-0">
        {error ? (
          <p className="text-[13px] text-destructive">{error}</p>
        ) : entries && entries.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            <Trans>Nothing shared yet</Trans>
          </p>
        ) : (
          <ul>{renderTree(ROOT, 0)}</ul>
        )}
      </nav>
      <article className="min-w-0">
        {openPath ? (
          <>
            <div className="mb-3 truncate text-[12.5px] text-muted-foreground" dir="auto">
              {openPath.slice(ROOT.length + 1)}
            </div>
            {content === null ? null : isMarkdown ? (
              // biome-ignore lint/a11y/noStaticElementInteractions: click delegation for wikilinks rendered by the shared markdown component
              // biome-ignore lint/a11y/useSemanticElements: the links inside are real anchors; this wrapper only intercepts them
              <div onClickCapture={onLinkClick}>
                <ChatMarkdown>{wikilinksToMarkdownLinks(stripFrontMatter(content))}</ChatMarkdown>
              </div>
            ) : (
              <pre className="overflow-x-auto whitespace-pre-wrap text-[13px] text-foreground/85">
                {content}
              </pre>
            )}
          </>
        ) : null}
      </article>
    </div>
  );
}
