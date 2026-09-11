import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("a section's Graph tab draws the vault as a graph", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `section-graph-${stamp}@rakazo.test`, "password12", "Test User");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const sidebar = page.locator("aside").first();
  const bot = sidebar.getByRole("button", { name: /^Chief/ });
  await bot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page.getByRole("menu", { name: "Move to", exact: true }).getByText("New section").click();
  const dialog = page.getByRole("dialog", { name: "New section" });
  await dialog.getByLabel("Name").fill("Ops");
  await dialog.getByRole("button", { name: "Create" }).click();

  await sidebar
    .locator('[data-sidebar-group^="section:"]')
    .getByRole("button", { name: "Open Ops", exact: true })
    .click();
  await page.waitForURL(/\/app\/s\/[^/]+$/);
  await page.getByRole("tab", { name: "Graph" }).click();
  await page.waitForURL(/\/app\/s\/[^/]+\/graph$/);

  const graph = page.getByTestId("section-graph");
  await expect(graph).toBeVisible();
  await expect(graph.getByLabel("Vault graph")).toBeVisible();
  await expect(graph.getByText(/Nothing shared yet/)).toBeVisible({ timeout: 20_000 });
  await captureScreenshot(page, testInfo, "section-graph");
});
