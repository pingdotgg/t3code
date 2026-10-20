import { act, render } from "../../../test/render";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// Real pointer clicks need the dialog's stacking styles to land above Base UI's modal overlay.
import "~/index.css";

const consume = vi.hoisted(() => vi.fn());
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { consumeResetCredit: null } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => consume }));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => "24h" }));
vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../settings/RedactedSensitiveText", () => ({ RedactedSensitiveText: () => null }));

import { UsageLimitsPooled } from "./UsageLimitsPooled";

const presentations = (resetsAt: string | undefined, availableCount: number): LimitPresentations =>
  new Map([
    [
      EnvironmentId.make("env-a"),
      {
        entry: { target: { label: "Test" } },
        serverConfig: {
          usageLimitSources: [],
          providers: [
            {
              instanceId: ProviderInstanceId.make("alpha"),
              driver: ProviderDriverKind.make("codex"),
              displayName: "Alpha",
              enabled: true,
              installed: true,
              version: null,
              status: "ready",
              auth: { status: "authenticated", email: "alpha@example.com" },
              checkedAt: "2026-09-03T11:00:00Z",
              models: [],
              slashCommands: [],
              skills: [],
              usageLimits: {
                checkedAt: "2026-09-03T11:00:00Z",
                resetCredits: { availableCount },
                windows: [
                  {
                    id: "five_hour",
                    kind: "session",
                    label: "Session",
                    usedPercent: resetsAt ? 40 : 0,
                    windowDurationMins: 300,
                    ...(resetsAt ? { resetsAt } : {}),
                  },
                ],
              },
            } satisfies ServerProvider,
          ],
        },
      },
    ],
  ]);

function setup() {
  consume.mockReset();
}
const initial = () => (
  <UsageLimitsPooled presentations={presentations("2026-09-03T14:00:00Z", 1)} now={0} />
);

async function click(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (node) => node.textContent === label || node.getAttribute("aria-label")?.startsWith(label),
  );
  expect(button).toBeDefined();
  await userEvent.click(button!);
}

/**
 * Runs `change`, which takes the open popup's trigger out of the page, then watches the popup
 * leave. A detached trigger has no rect, so a popup that keeps positioning against it slides
 * to the viewport origin on its way out.
 */
async function expectDismissedInPlace(change: () => Promise<void> | void) {
  const positioner = () => document.querySelector('[data-slot="popover-positioner"]');
  const place = (node: Element) => {
    const rect = node.getBoundingClientRect();
    return [rect.left, rect.top];
  };
  const before = place(positioner()!);
  await change();
  const seen: number[][] = [];
  for (let frame = 0; frame < 60 && positioner(); frame += 1) {
    seen.push(place(positioner()!));
    await new Promise(requestAnimationFrame);
  }
  expect(positioner()).toBeNull();
  expect(seen).toEqual(seen.map(() => before));
}

it.each([
  {
    label: "success",
    result: { _tag: "Success", value: { outcome: "reset" } },
    text: "Reset applied. Your windows have cleared.",
  },
  {
    label: "failure",
    result: { _tag: "Failure", cause: { error: new Error("Codex rejected the credit.") } },
    text: "Codex rejected the credit.",
  },
])("keeps pending feedback outside the closed popup until $label", async ({ result, text }) => {
  setup();
  await using _screen = await render(initial());
  let answer!: (result: unknown) => void;
  consume.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  await click("Alpha:");
  await click("Use reset");
  expect(consume).not.toHaveBeenCalled();
  await click("Cancel");
  expect(consume).not.toHaveBeenCalled();
  await click("Alpha:");
  await click("Use reset");
  await click("Use credit");
  expect(consume).toHaveBeenCalledOnce();
  // Both popups unmount once their exit animations finish.
  await expect.poll(() => document.querySelector('[role="alertdialog"]')).toBeNull();
  await expect.poll(() => document.querySelector('[data-slot="popover-popup"]')).toBeNull();
  const status = document.querySelector('[role="status"]');
  expect(status?.textContent).toBe("Alpha Using reset credit…");
  await click("Alpha:");
  const using = Array.from(document.querySelectorAll("button")).find(
    (node) => node.textContent === "Using…",
  );
  expect(using?.disabled).toBe(true);
  await act(async () => answer(result));
  expect(status?.textContent).toBe(`Alpha ${text}`);
});

it("omits an empty reset plate but keeps countdowns and banked credits visible", async () => {
  setup();
  await using screen = await render(initial());

  await page.viewport(1440, 900);
  const now = Date.parse("2026-09-03T11:00:00Z");
  const segment = page.getByRole("button", { name: /^Alpha:/ });
  // The empty plate has no accessible text; select its painted background inside the real bar.
  const plate = () =>
    segment.element().querySelector<HTMLSpanElement>('[class~="bg-background/85"]');

  await act(() =>
    screen.rerender(<UsageLimitsPooled presentations={presentations(undefined, 0)} now={now} />),
  );
  await expect.element(segment.getByText("100%", { exact: true })).toBeVisible();
  expect(plate()).toBeNull();

  await act(() =>
    screen.rerender(
      <UsageLimitsPooled presentations={presentations("2026-09-03T14:00:00Z", 0)} now={now} />,
    ),
  );
  await expect.element(plate()).toBeVisible();
  expect(plate()?.textContent).toBe("↻ 3h 0m");

  await act(() =>
    screen.rerender(<UsageLimitsPooled presentations={presentations(undefined, 1)} now={now} />),
  );
  await expect.element(plate()).toBeVisible();
  expect(plate()?.textContent).toBe("1");
});

it("cuts the pace gap through the segment track and keeps the tick inside it", async () => {
  setup();
  // Five hours before the reset is the start of the window, the right-hand end of the bar.
  await using _screen = await render(
    <UsageLimitsPooled
      presentations={presentations("2026-09-03T14:00:00Z", 0)}
      now={Date.parse("2026-09-03T09:00:00Z")}
    />,
  );
  const segment = page.getByRole("button", { name: /^Alpha:/ }).element();
  const tick = segment.querySelector(':scope > span[style*="left"]')!.getBoundingClientRect();
  const rect = segment.getBoundingClientRect();
  expect(getComputedStyle(segment).backgroundImage).toMatch(/^linear-gradient/);
  expect(tick.left).toBeGreaterThanOrEqual(rect.left);
  expect(tick.right).toBeLessThanOrEqual(rect.right);
});

it("drops the pace gap and tick when a segment is narrower than 6px", async () => {
  setup();
  await using _screen = await render(
    <UsageLimitsPooled
      presentations={presentations("2026-09-03T14:00:00Z", 0)}
      now={Date.parse("2026-09-03T11:30:00Z")}
    />,
  );
  const segment = page.getByRole("button", { name: /^Alpha:/ }).element();
  const tick = () => segment.querySelector(':scope > span[style*="left"]');
  expect(tick()).not.toBeNull();
  // Pooled grid columns have no minimum width; squeeze the segment the way a crowded pool does.
  await act(() => {
    segment.style.width = "4.5px";
  });
  await expect.poll(tick).toBeNull();
  expect(getComputedStyle(segment).backgroundImage).toBe("none");
  expect(getComputedStyle(segment.querySelector(":scope > div > div")!).clipPath).toBe("none");
});

it("moves the one limit popover between windows on hover", async () => {
  setup();
  await using screen = await render(initial());
  const { container } = screen;
  const [environmentId, presentation] = [...presentations("2026-09-03T14:00:00Z", 1)][0]!;
  const serverConfig = presentation.serverConfig!;
  const provider = serverConfig.providers[0]!;
  const twoWindows: LimitPresentations = new Map([
    [
      environmentId,
      {
        ...presentation,
        serverConfig: {
          ...serverConfig,
          providers: [
            {
              ...provider,
              usageLimits: {
                ...provider.usageLimits!,
                windows: [
                  ...provider.usageLimits!.windows,
                  { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 32 },
                ],
              },
            },
          ],
        },
      },
    ],
  ]);
  // Room above the bars so the popover opens there instead of flipping over the next card.
  container.style.paddingTop = "20rem";
  await act(() => screen.rerender(<UsageLimitsPooled presentations={twoWindows} now={0} />));
  const segment = (label: string) =>
    Array.from(document.querySelectorAll("button")).find((node) =>
      node.getAttribute("aria-label")?.startsWith(label),
    )!;
  // Popup contents, once the previous segment's details have animated away.
  const popups = () =>
    document.querySelector("[data-previous]")
      ? null
      : Array.from(
          document.querySelectorAll('[data-slot="popover-popup"]'),
          (node) => node.textContent,
        );
  const session = segment("Alpha: 60%");
  const weekly = segment("Alpha: 68%");

  await userEvent.click(session);
  await expect.poll(popups).toEqual([expect.stringContaining("Left60%")]);

  await userEvent.hover(weekly);
  await expect.poll(popups).toEqual([expect.stringContaining("Left68%")]);

  // Weekly's popover now sits over the middle of the Session bar; come back in at its edge.
  await userEvent.hover(session, { position: { x: 4, y: 4 } });
  await expect.poll(popups).toEqual([expect.stringContaining("Left60%")]);

  await expectDismissedInPlace(() =>
    act(() => screen.rerender(<UsageLimitsPooled presentations={new Map()} now={0} />)),
  );
  await userEvent.hover(container, { position: { x: 4, y: 4 } });

  await act(() => screen.rerender(<UsageLimitsPooled presentations={twoWindows} now={0} />));
  await expect.poll(popups).toEqual([]);
  await userEvent.click(segment("Alpha: 60%"));
  await expect.poll(popups).toEqual([expect.stringContaining("Left60%")]);
});

it("closes an open source-account popover when reset availability replaces its trigger", async () => {
  setup();
  await using screen = await render(initial());

  const [environmentId, presentation] = [...presentations("2026-09-03T14:00:00Z", 1)][0]!;
  const provider = presentation.serverConfig!.providers[0]!;
  const source = (nextCreditId?: string): LimitPresentations =>
    new Map([
      [
        environmentId,
        {
          ...presentation,
          serverConfig: {
            providers: [],
            usageLimitSources: [
              {
                id: UsageLimitSourceId.make("hub"),
                kind: "cliproxy",
                label: "Hub",
                checkedAt: "2026-09-03T11:00:00Z",
                accounts: [
                  {
                    id: "Alpha",
                    driver: provider.driver,
                    usageLimits: {
                      ...provider.usageLimits!,
                      resetCredits: {
                        availableCount: 1,
                        ...(nextCreditId ? { nextCreditId } : {}),
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
  const popup = () => document.querySelector('[data-slot="popover-popup"]');
  await act(() =>
    screen.rerender(<UsageLimitsPooled presentations={source("credit-1")} now={0} />),
  );
  await click("Alpha: 60%");
  await expect.poll(() => popup()?.textContent).toContain("Use reset");

  await expectDismissedInPlace(() =>
    act(() => screen.rerender(<UsageLimitsPooled presentations={source()} now={0} />)),
  );
  await click("Alpha: 60%");
  await expect.poll(() => popup()?.textContent).toContain("Left60%");

  await expectDismissedInPlace(() =>
    act(() => screen.rerender(<UsageLimitsPooled presentations={source("credit-2")} now={0} />)),
  );
  await click("Alpha: 60%");
  await expect.poll(() => popup()?.textContent).toContain("Use reset");
  await click("Use reset");
  await expect.poll(() => document.querySelector('[role="alertdialog"]')).not.toBeNull();
});
