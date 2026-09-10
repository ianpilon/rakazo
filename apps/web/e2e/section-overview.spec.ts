import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("a section opens to its goal and the bots that serve it", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `section-goal-${stamp}@rakazo.test`, "password12", "Test User");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const sidebar = page.locator("aside").first();
  const bot = sidebar.getByRole("button", { name: /^Chief/ });
  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page.getByRole("menu", { name: "Move to", exact: true }).getByText("New section").click();
  const dialog = page.getByRole("dialog", { name: "New section" });
  await dialog.getByLabel("Name").fill("Operating system");
  await dialog.getByRole("button", { name: "Create" }).click();

  const section = sidebar.locator('[data-sidebar-group^="section:"]');
  await section.getByRole("button", { name: "Open Operating system", exact: true }).click();
  await page.waitForURL(/\/app\/s\/[^/]+$/);

  const overview = page.getByTestId("section-overview");
  await expect(overview.getByRole("heading", { name: "Operating system" })).toBeVisible();
  await expect(overview.getByRole("button", { name: /^Chief/ })).toBeVisible();
  await expect(page.getByPlaceholder(/Message/)).toHaveCount(0);
  await expect(overview.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);

  const goal = overview.getByLabel("Goal");
  await goal.fill("Run my week without me chasing every bot.");
  await overview.getByRole("button", { name: "Save", exact: true }).click();
  await expect(overview.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "section-overview");

  await page.reload();
  await expect(page.getByTestId("section-overview").getByLabel("Goal")).toHaveValue(
    "Run my week without me chasing every bot.",
  );

  // The section stays collapsible from its own chevron.
  const toggle = section.getByRole("button", { name: /Collapse|Expand/ });
  await toggle.click();
  await expect(section.getByRole("button", { name: /^Chief/ })).toHaveCount(0);

  await page
    .getByTestId("section-overview")
    .getByRole("button", { name: /^Chief/ })
    .click();
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
});
