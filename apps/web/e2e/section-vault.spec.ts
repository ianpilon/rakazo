import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("a section's Vault tab shows the bots' shared folder", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `section-vault-${stamp}@rakazo.test`, "password12", "Test User");
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
  await page.getByRole("tab", { name: "Vault" }).click();
  await page.waitForURL(/\/app\/s\/[^/]+\/vault$/);

  const vault = page.getByTestId("section-vault");
  await expect(vault).toBeVisible();
  await expect(vault.getByRole("navigation", { name: "Vault" })).toBeVisible();
  await expect(vault.getByText(/Nothing shared yet|shared/i).first()).toBeVisible({
    timeout: 20_000,
  });
  await captureScreenshot(page, testInfo, "section-vault");
});
