import { describe, expect, it } from "vitest";
import {
  resolveWikilink,
  stripFrontMatter,
  wikilinksToMarkdownLinks,
  wikilinkTarget,
} from "./wikilinks";

describe("wikilinks", () => {
  it("rewrites plain, aliased, and heading wikilinks into hash links", () => {
    expect(wikilinksToMarkdownLinks("see [[Karpathy Vault]] and [[sources|the list]]")).toBe(
      "see [Karpathy Vault](#wikilink=Karpathy%20Vault) and [the list](#wikilink=sources)",
    );
    expect(wikilinksToMarkdownLinks("[[Home#Open threads]]")).toBe("[Home](#wikilink=Home)");
    expect(wikilinksToMarkdownLinks("no links here")).toBe("no links here");
  });

  it("reads the page back out of a link href", () => {
    expect(wikilinkTarget("https://x.test/app#wikilink=Karpathy%20Vault")).toBe("Karpathy Vault");
    expect(wikilinkTarget("https://x.test/")).toBeNull();
    expect(wikilinkTarget(undefined)).toBeNull();
  });

  it("strips a leading front matter block and nothing else", () => {
    expect(stripFrontMatter("---\ncreated: 2026-09-10\ntags: [a, b]\n---\n# Title\nbody")).toBe(
      "# Title\nbody",
    );
    expect(stripFrontMatter("# Title\n---\nnot front matter\n---\n")).toBe(
      "# Title\n---\nnot front matter\n---\n",
    );
    expect(stripFrontMatter("---\nonly: this\n---")).toBe("");
  });

  it("resolves by note name like Obsidian, preferring a full path match", () => {
    const files = [
      "shared/Karpathy/00-Home/Home.md",
      "shared/Karpathy/03-Wiki/sources.md",
      "shared/Karpathy/03-Wiki/Competitors/HappyRobot.md",
    ];
    expect(resolveWikilink("Sources", files)).toBe("shared/Karpathy/03-Wiki/sources.md");
    expect(resolveWikilink("shared/Karpathy/00-Home/Home", files)).toBe(
      "shared/Karpathy/00-Home/Home.md",
    );
    expect(resolveWikilink("Missing", files)).toBeNull();
  });
});
