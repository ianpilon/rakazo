import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("a section board shows the bots' runs moving to Done", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `section-board-${stamp}@rakazo.test`, "password12", "Test User");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("say hello");
  await page.keyboard.press("Enter");
  await expect(page.locator("aside").getByRole("button", { name: /^Chief/ })).toBeVisible();

  const sidebar = page.locator("aside").first();
  const bot = sidebar.getByRole("button", { name: /^Chief/ });
  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page.getByRole("menu", { name: "Move to", exact: true }).getByText("New section").click();
  const dialog = page.getByRole("dialog", { name: "New section" });
  await dialog.getByLabel("Name").fill("Ops");
  await dialog.getByRole("button", { name: "Create" }).click();

  const section = sidebar.locator('[data-sidebar-group^="section:"]');
  await section.getByRole("button", { name: "Open Ops", exact: true }).click();
  await page.waitForURL(/\/app\/s\/[^/]+$/);
  await page.getByRole("tab", { name: "Board" }).click();
  await page.waitForURL(/\/app\/s\/[^/]+\/board$/);

  const board = page.getByTestId("section-board");
  const done = board.getByRole("region", { name: "Done" });
  const card = done.getByRole("button", { name: /^Chief, Done/ });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  await expect(done.getByRole("button", { name: "Open thread" })).toBeVisible();
  await captureScreenshot(page, testInfo, "section-board");

  await page.getByRole("tab", { name: "Goal" }).click();
  await page.waitForURL(/\/app\/s\/[^/]+$/);
  await expect(page.getByTestId("section-overview").getByLabel("Goal")).toBeVisible();
});
