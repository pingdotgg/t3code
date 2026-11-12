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
  // A same-origin target the test can observe and cancel instead of launching an installed app.
  promptLinkDeepLink: (path: string) => `/__deep-link${path}`,
}));

function Landing() {
  return useHostedPromptLinkLanding(true);
}

it("opens the app once when remembering a manual choice", async () => {
  const key = "t3code:prompt-link-opener";
  const previous = localStorage.getItem(key);
  using _storage = {
    [Symbol.dispose]: () => {
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
    },
  };
  localStorage.removeItem(key);
  const handoffs: string[] = [];
  const onNavigate = (event: NavigateEvent) => {
    if (!new URL(event.destination.url).pathname.startsWith("/__deep-link")) return;
    handoffs.push(event.destination.url);
    event.preventDefault();
  };
  navigation.addEventListener("navigate", onNavigate);
  using _navigation = {
    [Symbol.dispose]: () => navigation.removeEventListener("navigate", onNavigate),
  };
  await using screen = await render(<Landing />, { router: "/new?prompt=Handoff%20test" });

  await screen.getByText("Remember my choice", { exact: true }).click();
  await screen.getByRole("link", { name: "Open in desktop app" }).click();

  await vi.waitFor(() => expect(localStorage.getItem(key)).toBe(JSON.stringify("app")));
  await expect.element(screen.getByRole("link", { name: "Open in desktop app" })).toBeVisible();
  expect(handoffs).toHaveLength(1);
});
