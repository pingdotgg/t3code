import { expect } from "e2e";
import { test, WEB } from "./t3.ts";

test(
  "Speech preferences save to one project and survive scope changes",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("speech-a");
    await t3.project("speech-b");
    await t3.open("/settings/speech");
    await screen.getByRole("button", "Project scope: All projects").tap();
    await screen.getByRole("menuitemradio").filter({ hasText: "speech-a" }).tap();
    await app.screenshot("speech-project-scope");
    await expect(browser.locator('[inert] [aria-label="Read aloud with"]')).toHaveCount(0);
    await screen.getByRole("combobox", "Read aloud with").tap();
    await screen.getByRole("option", "System voices").tap();
    await expect(screen.getByRole("combobox", "Read aloud with")).toContainText("System voices");
    await screen.getByRole("combobox", "Playback speed").tap();
    await screen.getByRole("option", "1.5×").tap();
    await expect(screen.getByRole("combobox", "Playback speed")).toContainText("1.5×");
    await screen.getByRole("button", "Project scope: speech-a").tap();
    await screen.getByRole("menuitemradio").filter({ hasText: "speech-b" }).tap();
    await expect(screen.getByRole("combobox", "Read aloud with")).toContainText("Off");
    await expect(screen.getByRole("combobox", "Playback speed")).toContainText("1×");
    await screen.getByRole("button", "Project scope: speech-b").tap();
    await screen.getByRole("menuitemradio").filter({ hasText: "speech-a" }).tap();
    await expect(screen.getByRole("combobox", "Read aloud with")).toContainText("System voices");
    await expect(screen.getByRole("combobox", "Playback speed")).toContainText("1.5×");
    await app.screenshot("speech-project-saved");
  },
);
