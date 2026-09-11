import { describe, expect, it } from "vitest";
import { buildVaultGraph, extractWikilinks } from "./vault-graph.js";

describe("vault graph", () => {
  it("extracts wikilink targets without aliases or headings, once each", () => {
    expect(
      extractWikilinks("[[Home]] and [[sources|the list]] then [[Home#Open]] and [[HappyRobot]]"),
    ).toEqual(["Home", "sources", "HappyRobot"]);
  });

  it("links notes by name, counts inbound links, and shows missing notes hollow", () => {
    const graph = buildVaultGraph(
      [
        {
          path: "shared/K/00-Home/Home.md",
          content: "[[sources]] [[Competitors/HappyRobot]] [[Nowhere]]",
        },
        { path: "shared/K/03-Wiki/sources.md", content: "back to [[Home]] and [[home]]" },
        { path: "shared/K/03-Wiki/Competitors/HappyRobot.md", content: "no links" },
      ],
      { root: "shared/K" },
    );
    expect(graph.edges).toEqual([
      { source: "shared/K/00-Home/Home.md", target: "shared/K/03-Wiki/sources.md" },
      { source: "shared/K/00-Home/Home.md", target: "shared/K/03-Wiki/Competitors/HappyRobot.md" },
      { source: "shared/K/00-Home/Home.md", target: "missing:nowhere" },
      { source: "shared/K/03-Wiki/sources.md", target: "shared/K/00-Home/Home.md" },
    ]);
    expect(graph.nodes).toEqual([
      {
        id: "shared/K/00-Home/Home.md",
        title: "Home",
        folder: "00-Home",
        inbound: 1,
        exists: true,
      },
      {
        id: "shared/K/03-Wiki/sources.md",
        title: "sources",
        folder: "03-Wiki",
        inbound: 1,
        exists: true,
      },
      {
        id: "shared/K/03-Wiki/Competitors/HappyRobot.md",
        title: "HappyRobot",
        folder: "03-Wiki/Competitors",
        inbound: 1,
        exists: true,
      },
      { id: "missing:nowhere", title: "Nowhere", folder: "", inbound: 1, exists: false },
    ]);
    expect(graph.truncated).toBe(false);
  });
});
