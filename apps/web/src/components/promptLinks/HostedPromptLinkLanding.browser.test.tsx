import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { useHostedPromptLinkLanding } from "./HostedPromptLinkLanding";

vi.mock(import("~/hostedPairing"), () => ({ isHostedStaticApp: () => true }));
vi.mock(import("~/state/environments"), () => ({
  useEnvironments: () => ({ environments: [{}], isReady: true }) as never,
}));
vi.mock(import("@t3tools/shared/promptLinks"), async (original) => ({
  ...(await original()),
  // Never launch an installed app from the test browser.
  promptLinkDeepLink: (path: string) => `t3code-test-unhandled://${path}`,
}));

function Landing() {
  return useHostedPromptLinkLanding(true);
}

it.each([false, true])(
  "says the tab can close after handing off (remembered: %s)",
  async (remembered) => {
    const key = "t3code:prompt-link-opener";
    using _storage = { [Symbol.dispose]: () => localStorage.removeItem(key) };
    if (remembered) localStorage.setItem(key, JSON.stringify("app"));
    else localStorage.removeItem(key);
    await using screen = await render(<Landing />, { router: "/new?prompt=Handoff%20test" });

    if (!remembered) {
      await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
      await screen.getByRole("link", { name: "Open in desktop app" }).click();
    }

    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent(
        "If T3 Code opened, you can close this tab. If it didn't, try again or get T3 Code below.",
      );
    await expect
      .element(screen.getByRole("link", { name: "Try opening again" }))
      .toHaveAttribute("href", "t3code-test-unhandled:///new?prompt=Handoff+test");
  },
);
