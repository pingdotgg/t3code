// @vitest-environment jsdom

import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => "24h" }));

import { UsageLimitsPooled } from "./UsageLimitsPooled";

const now = Date.parse("2026-09-17T08:00:00.000Z");
const presentations = new Map([
  [
    EnvironmentId.make("test-environment"),
    {
      entry: { target: { label: "Test environment" } },
      serverConfig: {
        providers: [
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex",
            enabled: true,
            installed: true,
            version: null,
            status: "ready" as const,
            auth: { status: "authenticated" as const, email: "codex@example.com" },
            checkedAt: "2026-09-17T08:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
            usageLimits: {
              checkedAt: "2026-09-17T08:00:00.000Z",
              windows: [
                {
                  id: "session",
                  kind: "session" as const,
                  label: "Session",
                  usedPercent: 24,
                  resetsAt: "2026-09-17T09:00:00.000Z",
                },
                {
                  id: "weekly",
                  kind: "weekly" as const,
                  label: "Weekly",
                  usedPercent: 32,
                  resetsAt: "2026-09-20T08:00:00.000Z",
                },
              ],
            },
          },
        ],
      },
    },
  ],
]) satisfies ComponentProps<typeof UsageLimitsPooled>["presentations"];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function segment(label: string): HTMLButtonElement {
  const trigger = [...container.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.startsWith(label),
  );
  if (!trigger) throw new Error(`No segment labelled ${label}`);
  return trigger;
}

function openPopovers(): string[] {
  return [...document.querySelectorAll('[data-slot="popover-popup"]')].map(
    (popup) => popup.textContent ?? "",
  );
}

/** The events a mouse sends moving between segments; popovers open once it rests on one. */
async function hover(from: Element, to: Element) {
  await act(async () => {
    from.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: to }));
    to.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
    to.dispatchEvent(new MouseEvent("mouseenter", { relatedTarget: from }));
    to.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, movementX: 4 }));
    await vi.runAllTimersAsync();
  });
}

it("keeps one limit popover open while moving between windows", async () => {
  await act(async () => {
    root.render(<UsageLimitsPooled presentations={presentations} now={now} />);
  });
  const session = segment("Codex: 76%");
  const weekly = segment("Codex: 68%");

  await act(async () => session.click());
  expect(openPopovers()).toEqual([expect.stringContaining("76%")]);

  await hover(session, weekly);
  expect(openPopovers()).toEqual([expect.stringContaining("68%")]);

  await hover(weekly, session);
  expect(openPopovers()).toEqual([expect.stringContaining("76%")]);
});
