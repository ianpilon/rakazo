import { describe, expect, it } from "vitest";
import { sectionContext } from "./section-context.js";

describe("sectionContext", () => {
  it("is absent for bots outside a section or in a section without a goal", () => {
    expect(sectionContext(null)).toBeUndefined();
    expect(sectionContext(undefined)).toBeUndefined();
    expect(sectionContext({ name: "Ops", goal: null })).toBeUndefined();
    expect(sectionContext({ name: "Ops", goal: "   " })).toBeUndefined();
  });

  it("names the section and its goal", () => {
    expect(
      sectionContext({
        name: "Ian's Operating system",
        goal: "Run my week without me chasing it.",
      }),
    ).toBe(
      "This bot belongs to the \"Ian's Operating system\" section of the user's bots. That section's goal: Run my week without me chasing it.",
    );
  });
});
