import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import {
  type ButtonHTMLAttributes,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  type Ref,
  act,
} from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type TestPopoverContext = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
};

vi.mock("../ui/popover", async () => {
  const React = await import("react");
  const PopoverContext = React.createContext<TestPopoverContext>({
    open: false,
    onOpenChange: () => {},
  });

  return {
    Popover: ({
      onOpenChange,
      actionsRef,
      children,
    }: {
      readonly onOpenChange: (open: boolean) => void;
      readonly actionsRef: Ref<{ close: () => void; unmount: () => void }>;
      readonly children: ReactNode;
    }) => {
      const [open, setOpen] = React.useState(false);
      const changeOpen = React.useCallback(
        (nextOpen: boolean) => {
          onOpenChange(nextOpen);
          setOpen(nextOpen);
        },
        [onOpenChange],
      );
      React.useImperativeHandle(
        actionsRef,
        () => ({ close: () => changeOpen(false), unmount: () => {} }),
        [changeOpen],
      );
      const value = React.useMemo(() => ({ open, onOpenChange: changeOpen }), [changeOpen, open]);
      return <PopoverContext.Provider value={value}>{children}</PopoverContext.Provider>;
    },
    PopoverTrigger: ({
      render,
      children,
      openOnHover: _openOnHover,
      ...props
    }: ButtonHTMLAttributes<HTMLButtonElement> & {
      readonly render?: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
      readonly children?: ReactNode;
      readonly openOnHover?: boolean;
    }) => {
      const popover = React.useContext(PopoverContext);
      const triggerProps = {
        ...props,
        onClick: () => popover.onOpenChange(!popover.open),
        onMouseEnter: () => popover.onOpenChange(true),
        onMouseLeave: () => popover.onOpenChange(false),
      };
      return render ? (
        React.cloneElement(render, triggerProps, children)
      ) : (
        <button type="button" {...triggerProps}>
          {children}
        </button>
      );
    },
    PopoverPopup: ({ children }: { readonly children: ReactNode }) => {
      const popover = React.useContext(PopoverContext);
      return popover.open ? <div data-account-popover>{children}</div> : null;
    },
  };
});
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => "24h" }));
vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../settings/RedactedSensitiveText", () => ({ RedactedSensitiveText: () => null }));
vi.mock("../settings/providerDriverMeta", () => ({
  getDriverOption: (driver: string) => ({ label: driver === "codex" ? "Codex" : "OpenCode" }),
}));
vi.mock("../ui/alert", () => ({ Alert: "div", AlertTitle: "div" }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("./UsageLimits", () => ({
  PaceIcon: () => null,
  ResetCreditDialog: () => null,
  barColor: () => "white",
  resetCreditsSummary: () => "",
  useResetCredit: () => ({
    confirming: false,
    setConfirming: () => {},
    busy: false,
    status: null,
    redeem: async () => {},
  }),
}));

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

let renderer: ReactTestRenderer;

function textContent(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textContent(child)))
    .join("");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("reopens a clicked limit after hovering to another window", async () => {
  await act(() => {
    renderer = create(<UsageLimitsPooled presentations={presentations} now={now} />);
  });

  const findTrigger = (label: string) =>
    renderer.root.find(
      (node) =>
        node.type === "button" &&
        typeof node.props["aria-label"] === "string" &&
        node.props["aria-label"].startsWith(label),
    );
  const sessionTrigger = findTrigger("Codex: 76%");

  await act(() => sessionTrigger.props.onClick());
  expect(renderer.root.findAllByProps({ "data-account-popover": true })).toHaveLength(1);

  const staleSessionClose = sessionTrigger.props.onMouseLeave;
  await act(() => findTrigger("Codex: 68%").props.onMouseEnter());
  expect(renderer.root.findAllByProps({ "data-account-popover": true })).toHaveLength(1);

  await act(() => staleSessionClose());
  await act(() => findTrigger("Codex: 76%").props.onMouseEnter());
  const reopened = renderer.root.findAllByProps({ "data-account-popover": true });
  expect(reopened).toHaveLength(1);
  expect(textContent(reopened[0]!)).toContain("76%");
  expect(textContent(reopened[0]!)).not.toContain("68%");
});
