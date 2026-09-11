/** Hash prefix that marks a markdown link as a vault wikilink the viewer resolves itself. */
export const WIKILINK_HASH = "#wikilink=";

/**
 * Rewrites Obsidian `[[Page]]`, `[[Page|alias]]`, and `[[Page#Heading]]` into ordinary markdown
 * links whose href is a hash the vault viewer intercepts, so the shared renderer needs no plugin.
 */
export function wikilinksToMarkdownLinks(markdown: string): string {
  return markdown.replace(
    /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g,
    (_match, target, alias) => {
      const page = String(target).trim();
      const label = (alias ? String(alias) : page).trim();
      return `[${label}](${WIKILINK_HASH}${encodeURIComponent(page)})`;
    },
  );
}

/** The page name encoded in a wikilink href, or null for any other href. */
export function wikilinkTarget(href: string | null | undefined): string | null {
  if (!href) return null;
  const index = href.indexOf(WIKILINK_HASH);
  if (index === -1) return null;
  try {
    return decodeURIComponent(href.slice(index + WIKILINK_HASH.length));
  } catch {
    return null;
  }
}

/**
 * Finds the file a wikilink points at, the way Obsidian does: by note name without `.md`,
 * case-insensitively, preferring a match that includes the folder path when one is given.
 */
export function resolveWikilink(target: string, filePaths: readonly string[]): string | null {
  const wanted = target.replace(/\.md$/i, "").toLowerCase();
  let byName: string | null = null;
  for (const filePath of filePaths) {
    const withoutExt = filePath.replace(/\.md$/i, "").toLowerCase();
    if (withoutExt === wanted) return filePath;
    const base = withoutExt.split("/").pop();
    if (base === wanted && byName === null) byName = filePath;
  }
  return byName;
}

/** Drops a leading YAML front matter block, which Obsidian shows as properties, not prose. */
export function stripFrontMatter(markdown: string): string {
  const match = markdown.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  return match ? markdown.slice(match[0].length) : markdown;
}
