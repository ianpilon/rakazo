/**
 * Bots grouped under a sidebar section share the section's goal. The goal is
 * user-authored context, so it joins the system prompt as data about the
 * bot's place in the user's setup, not as higher-priority instructions.
 */
export function sectionContext(
  section: { name: string; goal: string | null } | null | undefined,
): string | undefined {
  const goal = section?.goal?.trim();
  if (!section || !goal) return undefined;
  return `This bot belongs to the "${section.name}" section of the user's bots. That section's goal: ${goal}`;
}
