/**
 * A team line is one messaging address (an SMS number) shared by every bot the owner allows.
 * Outbound texts carry the sending bot's name, and an inbound text can name the bot it is for.
 */
export const TEAM_LINE_PROVIDERS: ReadonlySet<string> = new Set(["twilio"]);

export function isTeamLineProvider(provider: string): boolean {
  return TEAM_LINE_PROVIDERS.has(provider);
}

export const TEAM_LINE_HEADLINE = "Open Bot";

/** The text a bot sends on the team line: who is speaking first, then the message. */
export function stampTeamLineBody(botName: string, text: string): string {
  return `${TEAM_LINE_HEADLINE}\nfrom ${botName}\n\n${text}`;
}

const SEPARATORS = /^[\s:,-]+/;

/**
 * "Skill Builder: turn this into a skill" or "@Skill Builder turn this..." addresses a bot by
 * name. Longest name wins so "Weekly Review bot" is not taken as "Weekly Review". Returns the
 * bot and the rest of the text, or null when no name leads the text.
 */
export function parseBotAddress<T extends { id: string; name: string }>(
  text: string,
  bots: readonly T[],
): { bot: T; rest: string } | null {
  const trimmed = text.trim().replace(/^@/, "");
  const lower = trimmed.toLowerCase();
  const candidates = [...bots]
    .filter((bot) => bot.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  for (const bot of candidates) {
    const name = bot.name.trim().toLowerCase();
    if (!lower.startsWith(name)) continue;
    const after = trimmed.slice(name.length);
    // The name must end at a word boundary: "Chief:" or "Chief hi", not "Chiefs".
    if (after.length > 0 && !SEPARATORS.test(after)) continue;
    return { bot, rest: after.replace(SEPARATORS, "").trim() };
  }
  return null;
}
