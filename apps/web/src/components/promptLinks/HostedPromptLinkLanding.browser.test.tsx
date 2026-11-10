import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { useHostedPromptLinkLanding } from "./HostedPromptLinkLanding";

vi.mock(import("../../hostedPairing"), () => ({ isHostedStaticApp: () => true }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [{}], isReady: true }),
}));
vi.mock(import("@t3tools/shared/promptLinks"), async (original) => ({
  ...(await original()),
  // Never launch an installed app from the browser test runner.
  promptLinkDeepLink: (path: string) => `t3code-test-unhandled://${path}`,
}));

function Landing() {
  return useHostedPromptLinkLanding(true);
}

it.each([false, true])(
  "keeps recovery available after an app handoff attempt (remembered: %s)",
  async (remembered) => {
    const key = "t3code:prompt-link-opener";
    const previous = localStorage.getItem(key);
    using _storage = {
      [Symbol.dispose]: () => {
        if (previous === null) localStorage.removeItem(key);
        else localStorage.setItem(key, previous);
      },
    };
    if (remembered) localStorage.setItem(key, JSON.stringify("app"));
    else localStorage.removeItem(key);
    await using screen = await render(<Landing />, { router: "/new?prompt=Handoff%20test" });

    if (!remembered) {
      await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
      await screen.getByText("Remember my choice", { exact: true }).click();
      await screen.getByRole("link", { name: "Open in desktop app" }).click();
    }

    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent(
        "If T3 Code opened, you can close this tab. If it didn’t, try again or get T3 Code below.",
      );
    const retry = screen.getByRole("link", { name: "Try opening again" });
    await expect
      .element(retry)
      .toHaveAttribute("href", "t3code-test-unhandled:///new?prompt=Handoff+test");
    await expect.element(screen.getByRole("link", { name: "Get T3 Code" })).toBeVisible();
    await expect.element(screen.getByText("Handoff test", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Continue here" }).click();
    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
  },
);
