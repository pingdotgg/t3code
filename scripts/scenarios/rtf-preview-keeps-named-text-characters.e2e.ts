import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

// Java's RTFEditorKit writing "Account<em space>Name<en space>Jean<nonbreaking hyphen>Luc".
const JDK_RTF = String.raw`{\rtf1\ansi
{\fonttbl\f0\fnil Monospaced;}

Account\emspace Name\enspace Jean\_ Luc\par
}
`;

test(
  "An RTF preview keeps the spaces and hyphens written as named control words",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo", { "contacts.rtf": JDK_RTF });
    const thread = await t3.thread({ project, title: "Review contacts", messages: ["Start"] });
    await t3.open(thread);
    await expect(screen.getByText("fixture turn complete", { exact: false })).toBeVisible();

    await browser.keyboard.press("Control+p");
    await screen.getByPlaceholder("Search files…").fill("contacts.rtf");
    await screen.getByRole("option", "contacts.rtf", { exact: false }).tap();

    // The first document preview loads its worker, which a cold Vite cache optimizes on demand.
    await expect(screen.getByText("1 page", { exact: false })).toBeVisible({ timeout: 120_000 });
    const document = browser.frameLocator('iframe[title^="contacts.rtf"]');
    const body = document.locator("body");
    await expect(body).toContainText("Account");
    await app.screenshot("text");
    await expect(body).toHaveText("Account Name Jean‑ Luc");
  },
);
