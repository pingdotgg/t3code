import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { T3_HOME } from "../e2e.config.ts";
import { SECOND_HOME, startSecondServer } from "./second-server.ts";
import { rpcClient, runPromise, test, WEB } from "./t3.ts";

const ROOT = "/home/developer/projects/client-work/acme-corporation/monorepo-worktrees";
const ALPHA = `${ROOT}/environment-alpha`;
const BRAVO = `${ROOT}/environment-bravo`;

const setWorktreesDirectory = (home: string, origin: string, worktreesDirectory: string) =>
  runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* rpcClient(home, origin);
        yield* client["server.updateSettings"]({ patch: { worktreesDirectory } });
      }),
    ),
  );

// Readable means settled and on top: a tooltip mid-fade or under the popover is in the DOM but unseen.
const tooltipOnTop = () =>
  document.querySelectorAll('[data-slot="tooltip-popup"]').length > 0 &&
  [...document.querySelectorAll('[data-slot="tooltip-popup"]')].some((popup) => {
    const box = popup.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return getComputedStyle(popup).opacity === "1" && popup.contains(hit);
  });

test(
  "A mixed worktree location's popover shows each environment's full path",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await t3.project("demo");
    const server = startSecondServer(app.baseUrl ?? "");
    try {
      const { host, token } = await server.ready;
      await t3.open("/settings/connections");
      await screen.getByRole("button", "Add environment").tap();
      const dialog = screen.getByRole("dialog");
      await dialog.getByPlaceholder("backend.example.com").fill(host);
      await dialog.getByPlaceholder("PAIRCODE").fill(token);
      await dialog.getByRole("button", "Add environment").tap();
      await expect(screen.getByText("Reconnecting…")).toBeHidden({ timeout: 60_000 });
      await setWorktreesDirectory(T3_HOME, app.baseUrl ?? "", ALPHA);
      await setWorktreesDirectory(SECOND_HOME, host, BRAVO);

      await app.open("/settings/worktrees");
      await expect(screen.getByRole("textbox", "Worktree location")).toHaveAttribute(
        "placeholder",
        "Mixed",
        { timeout: 60_000 },
      );
      await screen.getByRole("button", /^Mixed across selected environments/).tap();

      const tooltip = browser.locator('[data-slot="tooltip-viewport"]');
      const shows = async (label: string) => {
        try {
          await expect(tooltip).toHaveText(BRAVO);
          await expect.poll(() => browser.evaluate(tooltipOnTop)).toBe(true);
        } finally {
          await app.screenshot(label);
        }
      };
      const heading = screen.getByRole("button", new RegExp(`^${BRAVO}`));
      await browser.keyboard.press("Tab");
      await expect(heading).toBeFocused();
      await shows("heading-focus");
      await browser.keyboard.press("Enter");
      const value = browser.locator(`li span[tabindex="0"]:text-is("${BRAVO}")`);
      await value.hover();
      await shows("layer-value-hover");
      await browser.mouse.move(5, 5);
      await browser.keyboard.press("Tab");
      await expect(value).toBeFocused();
      await shows("layer-value-focus");
      // A value that fits gets neither a tooltip nor a tab stop.
      await expect(browser.locator('li span:text-is("Empty")')).not.toHaveAttribute("tabindex");
    } finally {
      await server.stop();
    }
  },
);
