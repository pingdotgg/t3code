import { render } from "../../../test/render";
import { ProviderDriverKind, type ServerProviderUsageWindow } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { consumeResetCredit: null } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => "24h" }));

import { LimitWindows } from "./UsageLimits";

const codex = ProviderDriverKind.make("codex");
const now = Date.parse("2026-09-03T12:00:00Z");

const sessionWindow = (minutesUntilReset: number | null): ServerProviderUsageWindow => ({
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  ...(minutesUntilReset === null
    ? {}
    : {
        windowDurationMins: 300,
        resetsAt: new Date(now + minutesUntilReset * 60_000).toISOString(),
      }),
});

const sized = (width: string) => {
  const container = document.createElement("div");
  container.style.width = width;
  return container;
};

const bar = () => {
  const element = page.getByRole("img", { name: /^Session:/ }).element();
  const mark = element.querySelector(":scope > span[aria-hidden]");
  return {
    rect: element.getBoundingClientRect(),
    mark: mark?.getBoundingClientRect(),
    clip: getComputedStyle(element.querySelector(":scope > div")!).clipPath,
  };
};

it("places the even-pace tick in a gap at the share of the window left", async () => {
  await using _screen = await render(
    <LimitWindows driver={codex} windows={[sessionWindow(90)]} now={now} />,
    { container: sized("640px") },
  );
  const { rect, mark, clip } = bar();
  expect(mark!.left + mark!.width / 2 - rect.left).toBeCloseTo(rect.width * 0.3, 0);
  expect(clip).toMatch(/^polygon/);
});

it("keeps the tick inside the bar at both ends of the window", async () => {
  for (const minutesUntilReset of [0, 300]) {
    await using _screen = await render(
      <LimitWindows driver={codex} windows={[sessionWindow(minutesUntilReset)]} now={now} />,
      { container: sized("640px") },
    );
    const { rect, mark } = bar();
    expect(mark!.left).toBeGreaterThanOrEqual(rect.left);
    expect(mark!.right).toBeLessThanOrEqual(rect.right);
  }
});

it("draws a continuous bar when the window timing is unknown", async () => {
  await using _screen = await render(
    <LimitWindows driver={codex} windows={[sessionWindow(null)]} now={now} />,
    { container: sized("640px") },
  );
  expect(bar()).toMatchObject({ mark: undefined, clip: "none" });
});

it("draws neither gap nor tick on a bar narrower than 6px", async () => {
  // 11rem + 1rem + 3.5px + 1rem + 7rem: the bar column gets 3.5px.
  await using _screen = await render(
    <LimitWindows driver={codex} windows={[sessionWindow(300)]} now={now} />,
    { container: sized("323.5px") },
  );
  const { rect, mark, clip } = bar();
  expect(rect.width).toBeCloseTo(3.5, 1);
  expect({ mark, clip }).toEqual({ mark: undefined, clip: "none" });
});
