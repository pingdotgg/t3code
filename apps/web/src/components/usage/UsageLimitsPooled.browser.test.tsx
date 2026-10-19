import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
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

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  consume.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() =>
    root.render(
      <UsageLimitsPooled presentations={presentations("2026-09-03T14:00:00Z", 1)} now={0} />,
    ),
  );
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function click(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (node) => node.textContent === label || node.getAttribute("aria-label")?.startsWith(label),
  );
  expect(button).toBeDefined();
  await act(() => userEvent.click(button!));
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
  await page.viewport(1440, 900);
  const now = Date.parse("2026-09-03T11:00:00Z");
  const segment = page.getByRole("button", { name: /^Alpha:/ });
  // The empty plate has no accessible text; select its painted background inside the real bar.
  const plate = () =>
    segment.element().querySelector<HTMLSpanElement>('[class~="bg-background/85"]');

  await act(() =>
    root.render(<UsageLimitsPooled presentations={presentations(undefined, 0)} now={now} />),
  );
  await expect.element(segment.getByText("100%", { exact: true })).toBeVisible();
  expect(plate()).toBeNull();

  await act(() =>
    root.render(
      <UsageLimitsPooled presentations={presentations("2026-09-03T14:00:00Z", 0)} now={now} />,
    ),
  );
  await expect.element(plate()).toBeVisible();
  expect(plate()?.textContent).toBe("↻ 3h 0m");

  await act(() =>
    root.render(<UsageLimitsPooled presentations={presentations(undefined, 1)} now={now} />),
  );
  await expect.element(plate()).toBeVisible();
  expect(plate()?.textContent).toBe("1");
});

it("moves the one limit popover between windows on hover", async () => {
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
  await act(() => root.render(<UsageLimitsPooled presentations={twoWindows} now={0} />));
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

  await act(() => userEvent.click(session));
  await expect.poll(popups).toEqual([expect.stringContaining("Left60%")]);

  await act(() => userEvent.hover(weekly));
  await expect.poll(popups).toEqual([expect.stringContaining("Left68%")]);

  // Weekly's popover now sits over the middle of the Session bar; come back in at its edge.
  await act(() => userEvent.hover(session, { position: { x: 4, y: 4 } }));
  await expect.poll(popups).toEqual([expect.stringContaining("Left60%")]);

  await act(() => root.render(<UsageLimitsPooled presentations={new Map()} now={0} />));
  await expect.poll(popups).toEqual([]);
  await act(() => userEvent.hover(container, { position: { x: 4, y: 4 } }));

  await act(() => root.render(<UsageLimitsPooled presentations={twoWindows} now={0} />));
  await expect.poll(popups).toEqual([]);
  await act(() => userEvent.click(segment("Alpha: 60%")));
  await expect.poll(popups).toEqual([expect.stringContaining("Left60%")]);
});

it("closes an open source-account popover when reset availability replaces its trigger", async () => {
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
  await act(() => root.render(<UsageLimitsPooled presentations={source("credit-1")} now={0} />));
  await click("Alpha: 60%");
  await expect.poll(() => popup()?.textContent).toContain("Use reset");

  await act(() => root.render(<UsageLimitsPooled presentations={source()} now={0} />));
  await expect.poll(popup).toBeNull();
  await click("Alpha: 60%");
  await expect.poll(() => popup()?.textContent).toContain("Left60%");

  await act(() => root.render(<UsageLimitsPooled presentations={source("credit-2")} now={0} />));
  await expect.poll(popup).toBeNull();
  await click("Alpha: 60%");
  await expect.poll(() => popup()?.textContent).toContain("Use reset");
  await click("Use reset");
  await expect.poll(() => document.querySelector('[role="alertdialog"]')).not.toBeNull();
});
