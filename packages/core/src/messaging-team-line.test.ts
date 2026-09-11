import { describe, expect, it } from "vitest";
import { isTeamLineProvider, parseBotAddress, stampTeamLineBody } from "./messaging-team-line.js";

const bots = [
  { id: "b1", name: "Chief" },
  { id: "b2", name: "Skill Builder bot" },
  { id: "b3", name: "The Weekly Review bot" },
  { id: "b4", name: "Weekly Review" },
];

describe("team line", () => {
  it("only SMS is a team line today", () => {
    expect(isTeamLineProvider("twilio")).toBe(true);
    expect(isTeamLineProvider("whatsapp")).toBe(false);
  });

  it("stamps the headline and the sending bot ahead of the text", () => {
    expect(stampTeamLineBody("Decision Log bot", "Logged it.")).toBe(
      "Open Bot\nfrom Decision Log bot\n\nLogged it.",
    );
  });

  it("routes a text that names a bot, case-insensitively, with or without @", () => {
    expect(parseBotAddress("skill builder bot: make a skill", bots)).toEqual({
      bot: bots[1],
      rest: "make a skill",
    });
    expect(parseBotAddress("@Chief what is on today", bots)).toEqual({
      bot: bots[0],
      rest: "what is on today",
    });
    expect(parseBotAddress("Chief", bots)).toEqual({ bot: bots[0], rest: "" });
  });

  it("prefers the longest matching name and respects word boundaries", () => {
    expect(parseBotAddress("The Weekly Review bot - status?", bots)?.bot.id).toBe("b3");
    expect(parseBotAddress("Weekly Review: status?", bots)?.bot.id).toBe("b4");
    expect(parseBotAddress("Chiefs are great", bots)).toBeNull();
    expect(parseBotAddress("hello there", bots)).toBeNull();
  });
});
