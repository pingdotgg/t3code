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

const OPENER_KEY = "t3code:prompt-link-opener";

function setup(opener: "app" | null) {
  const previous = localStorage.getItem(OPENER_KEY);
  if (opener === null) localStorage.removeItem(OPENER_KEY);
  else localStorage.setItem(OPENER_KEY, JSON.stringify(opener));
  const handoffs: string[] = [];
  const onNavigate = (event: NavigateEvent) => {
    if (!new URL(event.destination.url).pathname.startsWith("/__deep-link")) return;
    handoffs.push(event.destination.url);
    event.preventDefault();
  };
  navigation.addEventListener("navigate", onNavigate);
  return {
    handoffs,
    [Symbol.dispose]: () => {
      navigation.removeEventListener("navigate", onNavigate);
      if (previous === null) localStorage.removeItem(OPENER_KEY);
      else localStorage.setItem(OPENER_KEY, previous);
    },
  };
}

it("opens the app once and offers recovery when remembering a manual choice", async () => {
  using env = setup(null);
  await using screen = await render(<Landing />, { router: "/new?prompt=Handoff%20test" });

  await screen.getByText("Remember my choice", { exact: true }).click();
  await screen.getByRole("link", { name: "Open in desktop app" }).click();

  await vi.waitFor(() => expect(localStorage.getItem(OPENER_KEY)).toBe(JSON.stringify("app")));
  await expect.element(screen.getByText("Sent to T3 Code")).toBeVisible();
  await expect.element(screen.getByRole("link", { name: "Try again" })).toBeVisible();
  await expect.element(screen.getByText("Handoff test")).toBeVisible();
  expect(env.handoffs).toHaveLength(1);
});

it("offers recovery after a remembered handoff", async () => {
  using env = setup("app");
  await using screen = await render(<Landing />, { router: "/new?prompt=Handoff%20test" });

  await expect.element(screen.getByText("Sent to T3 Code")).toBeVisible();
  await expect.element(screen.getByRole("link", { name: "Try again" })).toBeVisible();
  expect(env.handoffs).toHaveLength(1);
});
