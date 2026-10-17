import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { act, type PropsWithChildren, type ReactElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

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
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/tooltip", () => ({ Tooltip: "div", TooltipPopup: "div", TooltipTrigger: "div" }));
// Popovers and dialogs portal and animate; these keep only the open state the segment owns.
vi.mock("../ui/popover", async () => {
  const React = await import("react");
  const Open = React.createContext({ open: false, toggle: () => {} });
  return {
    Popover: ({
      open,
      onOpenChange,
      children,
    }: PropsWithChildren<{ open: boolean; onOpenChange: (open: boolean) => void }>) => {
      const value = React.useMemo(
        () => ({ open, toggle: () => onOpenChange(!open) }),
        [open, onOpenChange],
      );
      return <Open.Provider value={value}>{children}</Open.Provider>;
    },
    PopoverTrigger: ({
      render,
      children,
    }: PropsWithChildren<{ render: ReactElement<{ onClick?: () => void }> }>) =>
      React.cloneElement(render, { onClick: React.useContext(Open).toggle }, children),
    PopoverPopup: ({ children }: PropsWithChildren) =>
      React.useContext(Open).open ? <div>{children}</div> : null,
  };
});
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: PropsWithChildren<{ open: boolean }>) =>
    open ? <div role="dialog">{children}</div> : null,
  AlertDialogPopup: "div",
  AlertDialogHeader: "div",
  AlertDialogTitle: "div",
  AlertDialogDescription: "div",
  AlertDialogFooter: "div",
  AlertDialogClose: "div",
}));

import { UsageLimitsPooled } from "./UsageLimitsPooled";

const presentations: LimitPresentations = new Map([
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
              resetCredits: { availableCount: 1 },
              windows: [
                {
                  id: "five_hour",
                  kind: "session",
                  label: "Session",
                  usedPercent: 40,
                  windowDurationMins: 300,
                  resetsAt: "2026-09-03T14:00:00Z",
                },
              ],
            },
          } satisfies ServerProvider,
        ],
      },
    },
  ],
]);

let renderer: ReactTestRenderer;

const button = (label: string) =>
  renderer.root.find((node) => node.type === "button" && node.children.includes(label));
const segment = () =>
  renderer.root.find(
    (node) => node.type === "button" && node.props["aria-label"]?.startsWith("Alpha:"),
  );
const text = (node: ReactTestRenderer["root"] | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const status = () =>
  renderer.root
    .findAll((node) => node.props.role === "status")
    .map(text)
    .join(" ");

/** Confirms a reset whose answer the test releases, closing the popover the way a click does. */
async function confirmHeldReset() {
  let answer!: (result: unknown) => void;
  consume.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  await act(() => {
    renderer = create(<UsageLimitsPooled presentations={presentations} now={0} />);
  });
  await act(() => segment().props.onClick());
  await act(() => button("Use reset").props.onClick());
  await act(() => button("Use credit").props.onClick());
  return answer;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  consume.mockReset();
});

afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

it("shows the pending reset after its popover closes, then the outcome", async () => {
  const answer = await confirmHeldReset();
  expect(consume).toHaveBeenCalledOnce();
  expect(status()).toBe("Alpha Using reset credit…");

  await act(() => segment().props.onClick());
  expect(button("Using…").props.disabled).toBe(true);

  await act(async () => answer({ _tag: "Success", value: { outcome: "reset" } }));
  expect(status()).toBe("Alpha Reset applied. Your windows have cleared.");
});

it("replaces the pending reset with the failure", async () => {
  const answer = await confirmHeldReset();
  await act(async () =>
    answer({ _tag: "Failure", cause: { error: new Error("Codex rejected the credit.") } }),
  );
  expect(status()).toBe("Alpha Codex rejected the credit.");
});
