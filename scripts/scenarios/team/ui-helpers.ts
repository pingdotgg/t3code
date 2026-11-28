import type { Page } from "playwright-core";

export type TeamSettingsTab = "overview" | "access" | "providers" | "skills";

export async function selectTeamSettingsTab(page: Page, tab: TeamSettingsTab): Promise<void> {
  const tabButton = page.getByTestId(`teams-tab-${tab}`);
  await tabButton.waitFor({ state: "visible", timeout: 20_000 });
  if ((await tabButton.getAttribute("aria-selected")) !== "true") {
    await tabButton.click();
  }
}

export async function openTeamInviteForm(page: Page): Promise<void> {
  await selectTeamSettingsTab(page, "overview");
  const createButton = page.getByTestId("team-invite-create");
  if (await createButton.isVisible().catch(() => false)) {
    return;
  }
  const openButton = page.getByTestId("team-invite-open-form");
  await openButton.waitFor({ state: "visible", timeout: 15_000 });
  await openButton.click();
  await createButton.waitFor({ state: "visible", timeout: 15_000 });
}

export async function confirmDestructiveActionDialog(page: Page): Promise<void> {
  const confirmButton = page.getByRole("alertdialog").getByRole("button", { name: "Confirm" });
  await confirmButton.waitFor({ state: "visible", timeout: 15_000 });
  await confirmButton.click();
}
