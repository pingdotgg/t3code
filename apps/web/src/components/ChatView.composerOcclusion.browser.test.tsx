import "../index.css";

import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const isOpaque = (color: string) => {
  const channels = color.match(/[\d.]+/g)?.map(Number) ?? [];
  return channels.length === 3 || channels[3] === 1;
};

function paintsOverTimeline(x: number, y: number) {
  for (const element of document.elementsFromPoint(x, y)) {
    if (element.closest(".messages-timeline-scroll")) return false;
    if (isOpaque(getComputedStyle(element).backgroundColor)) return true;
  }
  return false;
}

it.each([
  { name: "with the context row", persistComposerContextStrip: true },
  { name: "without the context row", persistComposerContextStrip: false },
])("the timeline stays hidden below the composer card $name", async (settings) => {
  const thread = threadWithHistory(`occlusion-${settings.persistComposerContextStrip}`, 4);
  using _environment = installFakeEnvironment([thread]);
  await page.viewport(1100, 620);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    persistComposerContextStrip: settings.persistComposerContextStrip,
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 620px; width: 1100px;";
  await using _app = await render(<AppRoot router={router} />, { container, router: false });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();

  const overlay = document.querySelector("[data-chat-composer-overlay]")!.getBoundingClientRect();
  const card = document.querySelector("[data-slot=composer-host]")!.getBoundingClientRect();
  const x = card.left + card.width / 2;
  for (const y of [card.bottom + 1, (card.bottom + overlay.bottom) / 2, overlay.bottom - 1]) {
    expect(paintsOverTimeline(x, y), `y ${y}`).toBe(true);
  }
});
