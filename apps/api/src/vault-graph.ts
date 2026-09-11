import type { VaultGraph } from "@rakazo/contracts";

export const VAULT_GRAPH_MAX_NOTES = 500;
export const VAULT_GRAPH_MAX_NOTE_BYTES = 256 * 1024;

/** Link targets from Obsidian wikilinks, without alias or heading, deduplicated in order. */
export function extractWikilinks(markdown: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of markdown.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g)) {
    const target = match[1]?.trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

function noteTitle(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}

function noteFolder(path: string, root: string): string {
  const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const index = relative.lastIndexOf("/");
  return index === -1 ? "" : relative.slice(0, index);
}

/**
 * Builds the note graph the way Obsidian's graph view does: links resolve by note name
 * (case-insensitive, full path preferred), and a link to a note that does not exist yet becomes
 * a hollow node so the gap is visible.
 */
export function buildVaultGraph(
  notes: ReadonlyArray<{ path: string; content: string }>,
  options: { root: string; truncated?: boolean },
): VaultGraph {
  const byLower = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const note of notes) {
    const withoutExt = note.path.replace(/\.md$/i, "");
    byLower.set(withoutExt.toLowerCase(), note.path);
    const relative = withoutExt.startsWith(`${options.root}/`)
      ? withoutExt.slice(options.root.length + 1)
      : withoutExt;
    byLower.set(relative.toLowerCase(), note.path);
    const name = (withoutExt.split("/").pop() ?? withoutExt).toLowerCase();
    if (!byName.has(name)) byName.set(name, note.path);
  }
  const resolve = (target: string): string | null => {
    const wanted = target.replace(/\.md$/i, "").toLowerCase();
    return byLower.get(wanted) ?? byName.get(wanted.split("/").pop() ?? wanted) ?? null;
  };
  const inbound = new Map<string, number>();
  const missing = new Map<string, string>();
  const edges: VaultGraph["edges"] = [];
  const seenEdges = new Set<string>();
  for (const note of notes) {
    for (const target of extractWikilinks(note.content)) {
      const resolved = resolve(target);
      const id = resolved ?? `missing:${target.toLowerCase()}`;
      if (!resolved) missing.set(id, target);
      if (id === note.path) continue;
      const key = `${note.path} ${id}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({ source: note.path, target: id });
      inbound.set(id, (inbound.get(id) ?? 0) + 1);
    }
  }
  const nodes: VaultGraph["nodes"] = notes.map((note) => ({
    id: note.path,
    title: noteTitle(note.path),
    folder: noteFolder(note.path, options.root),
    inbound: inbound.get(note.path) ?? 0,
    exists: true,
  }));
  for (const [id, title] of missing) {
    nodes.push({ id, title, folder: "", inbound: inbound.get(id) ?? 0, exists: false });
  }
  return { nodes, edges, truncated: options.truncated ?? false };
}
