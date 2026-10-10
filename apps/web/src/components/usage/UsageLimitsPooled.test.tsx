import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ consume: vi.fn(), canManage: true }));

vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => state.canManage,
  readEnvironmentScope: () => state.canManage,
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { consumeResetCredit: "consume" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.consume }));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: (select: (settings: { timestampFormat: string }) => unknown) =>
    select({ timestampFormat: "24h" }),
}));
vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../settings/RedactedSensitiveText", () => ({ RedactedSensitiveText: () => null }));
vi.mock("../settings/providerDriverMeta", () => ({
  providerClients: { get: () => ({ label: "Codex" }) },
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/alert", () => ({ Alert: "div", AlertTitle: "div" }));
vi.mock("../ui/tooltip", () => ({ Tooltip: "div", TooltipPopup: "div", TooltipTrigger: "div" }));
vi.mock("../ui/popover", async () => {
  const React = await import("react");
  const Context = React.createContext<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
  } | null>(null);
  return {
    Popover: ({
      open,
      onOpenChange,
      children,
    }: React.PropsWithChildren<{
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }>) => {
      const value = React.useMemo(() => ({ open, onOpenChange }), [open, onOpenChange]);
      return <Context.Provider value={value}>{children}</Context.Provider>;
    },
    PopoverTrigger: ({
      render,
      children,
    }: React.PropsWithChildren<{
      render: React.ReactElement;
    }>) => {
      const context = React.useContext(Context)!;
      return React.cloneElement(
        render as React.ReactElement<{ onClick?: () => void; children?: React.ReactNode }>,
        {
          onClick: () => context.onOpenChange(!context.open),
          children,
        },
      );
    },
    PopoverPopup: ({ children }: React.PropsWithChildren) =>
      React.useContext(Context)?.open ? <div>{children}</div> : null,
  };
});
vi.mock("../ui/alert-dialog", async () => {
  const React = await import("react");
  const Context = React.createContext<((open: boolean) => void) | null>(null);
  return {
    AlertDialog: ({
      open,
      onOpenChange,
      children,
    }: React.PropsWithChildren<{
      open: boolean;
      onOpenChange: (open: boolean) => void;
    }>) =>
      open ? (
        <Context.Provider value={onOpenChange}>
          <div role="dialog">{children}</div>
        </Context.Provider>
      ) : null,
    AlertDialogPopup: "div",
    AlertDialogHeader: "div",
    AlertDialogTitle: "div",
    AlertDialogDescription: "div",
    AlertDialogFooter: "div",
    AlertDialogClose: ({
      render,
      children,
    }: React.PropsWithChildren<{
      render: React.ReactElement;
    }>) => {
      const onOpenChange = React.useContext(Context)!;
      return React.cloneElement(
        render as React.ReactElement<{ onClick?: () => void; children?: React.ReactNode }>,
        {
          onClick: () => onOpenChange(false),
          children,
        },
      );
    },
  };
});

import { UsageLimitsPooled } from "./UsageLimitsPooled";

const now = Date.parse("2026-09-03T12:00:00Z");
const environmentId = EnvironmentId.make("env-a");
const window = {
  id: "five_hour",
  kind: "session" as const,
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00Z",
};

function native(name: string, email = `${name.toLowerCase()}@example.com`, workspaceId = "ws-1") {
  return {
    instanceId: ProviderInstanceId.make(name.toLowerCase()),
    driver: ProviderDriverKind.make("codex"),
    displayName: name,
    enabled: true,
    installed: true,
    version: null,
    status: "ready" as const,
    auth: { status: "authenticated" as const, email, workspaceId },
    checkedAt: "2026-09-03T11:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-09-03T11:00:00Z",
      windows: [window],
      resetCredits: { availableCount: 1 },
    },
  } satisfies ServerProvider;
}

function presentation(
  providers: readonly ServerProvider[],
  sourceAccounts: ReadonlyArray<{
    id: string;
    driver: ReturnType<typeof ProviderDriverKind.make>;
    usageLimits: {
      checkedAt: string;
      windows: (typeof window)[];
      resetCredits?: {
        availableCount: number;
        nextCreditId?: string;
      };
    };
  }> = [],
) {
  return new Map([
    [
      environmentId,
      {
        entry: { target: { label: "Test" } },
        serverConfig: {
          providers,
          usageLimitSources: sourceAccounts.length
            ? [
                {
                  id: UsageLimitSourceId.make("hub"),
                  kind: "cliproxy" as const,
                  label: "Hub",
                  checkedAt: "2026-09-03T11:00:00Z",
                  accounts: sourceAccounts,
                },
              ]
            : [],
        },
      },
    ],
  ]);
}

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let renderer: ReactTestRenderer;

function segment(name: string) {
  return renderer.root.findAll(
    (node) => node.type === "button" && node.props["aria-label"]?.startsWith(`${name}:`),
  )[0]!;
}

function button(label: string) {
  return renderer.root.findAll(
    (node) => node.type === "button" && node.children.includes(label),
  )[0]!;
}

function statusText() {
  const text = (children: ReactTestRenderer["root"]["children"]): string =>
    children.map((child) => (typeof child === "string" ? child : text(child.children))).join("");
  return renderer.root
    .findAll((node) => node.type === "span" && node.props.role === "status")
    .map((node) => text(node.children))
    .join(" ");
}

async function openAndConfirm(name: string) {
  await act(() => segment(name).props.onClick());
  await act(() => button("Use reset").props.onClick());
  await act(() => button("Use credit").props.onClick());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.consume.mockReset();
  state.canManage = true;
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("requires confirmation and leaves cancellation without a redemption", async () => {
  await act(() => {
    renderer = create(
      <UsageLimitsPooled presentations={presentation([native("Alpha")])} now={now} />,
    );
  });
  await act(() => segment("Alpha").props.onClick());
  await act(() => button("Use reset").props.onClick());
  expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
  expect(state.consume).not.toHaveBeenCalled();
  await act(() => button("Cancel").props.onClick());
  expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  expect(state.consume).not.toHaveBeenCalled();
});

it("shows pending outside the closed popover, blocks a second request, and shows success", async () => {
  const command = deferred();
  state.consume.mockReturnValue(command.promise);
  await act(() => {
    renderer = create(
      <UsageLimitsPooled presentations={presentation([native("Alpha")])} now={now} />,
    );
  });
  await openAndConfirm("Alpha");
  expect(state.consume).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { instanceId: ProviderInstanceId.make("alpha") },
  });
  expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  expect(statusText()).toMatch(/Alpha.*Using/);
  await act(() => segment("Alpha").props.onClick());
  expect(button("Using…").props.disabled).toBe(true);
  await act(() => segment("Alpha").props.onClick());
  await act(() => segment("Alpha").props.onClick());
  expect(button("Using…").props.disabled).toBe(true);
  expect(state.consume).toHaveBeenCalledTimes(1);
  await act(async () => command.resolve({ _tag: "Success", value: { outcome: "reset" } }));
  expect(statusText()).toMatch(/Alpha.*Reset applied/);
  expect(statusText()).not.toContain("Using");
});

it("accepts the confirmation only once before React updates", async () => {
  const command = deferred();
  state.consume.mockReturnValue(command.promise);
  await act(() => {
    renderer = create(
      <UsageLimitsPooled presentations={presentation([native("Alpha")])} now={now} />,
    );
  });
  await act(() => segment("Alpha").props.onClick());
  await act(() => button("Use reset").props.onClick());
  const confirm = button("Use credit").props.onClick;
  await act(() => {
    confirm();
    confirm();
  });
  expect(state.consume).toHaveBeenCalledTimes(1);
  await act(async () => command.resolve({ _tag: "Success", value: { outcome: "reset" } }));
});

it("does not reuse a pending request after the workspace changes for the same email", async () => {
  const command = deferred();
  state.consume.mockReturnValue(command.promise);
  await act(() => {
    renderer = create(
      <UsageLimitsPooled presentations={presentation([native("Alpha")])} now={now} />,
    );
  });
  await openAndConfirm("Alpha");
  await act(() => {
    renderer.update(
      <UsageLimitsPooled
        presentations={presentation([native("Alpha", "alpha@example.com", "ws-2")])}
        now={now}
      />,
    );
  });
  expect(statusText()).toBe("");
  await act(() => segment("Alpha").props.onClick());
  const action = renderer.root.findAll(
    (node) =>
      node.type === "button" &&
      (node.children.includes("Use reset") || node.children.includes("Using…")),
  )[0]!;
  expect(action.props.disabled).toBe(true);
  await act(async () => command.resolve({ _tag: "Success", value: { outcome: "reset" } }));
  expect(statusText()).toBe("");
  await act(() => button("Use reset").props.onClick());
  const next = deferred();
  state.consume.mockReturnValue(next.promise);
  await act(() => button("Use credit").props.onClick());
  expect(state.consume).toHaveBeenCalledTimes(2);
  expect(statusText()).toContain("Using");
  await act(async () =>
    next.resolve({ _tag: "Failure", cause: { error: new Error("New workspace failed") } }),
  );
  expect(statusText()).toContain("New workspace failed");
  expect(statusText()).not.toContain("Reset applied");
});

it("closes confirmation when its account changes without redeeming", async () => {
  await act(() => {
    renderer = create(
      <UsageLimitsPooled presentations={presentation([native("Alpha")])} now={now} />,
    );
  });
  await act(() => segment("Alpha").props.onClick());
  await act(() => button("Use reset").props.onClick());
  await act(() => {
    renderer.update(
      <UsageLimitsPooled
        presentations={presentation([native("Alpha", "beta@example.com")])}
        now={now}
      />,
    );
  });
  expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  expect(state.consume).not.toHaveBeenCalled();
});

it("rechecks provider permission before redeeming a confirmed request", async () => {
  const presentations = presentation([native("Alpha")]);
  await act(() => {
    renderer = create(<UsageLimitsPooled presentations={presentations} now={now} />);
  });
  await act(() => segment("Alpha").props.onClick());
  await act(() => button("Use reset").props.onClick());
  state.canManage = false;
  await act(() => renderer.update(<UsageLimitsPooled presentations={presentations} now={now} />));
  expect(button("Use credit").props.disabled).toBe(true);
  await act(() => button("Use credit").props.onClick());
  expect(state.consume).not.toHaveBeenCalled();
  expect(statusText()).toBe("");
});

it("does not attach another window of the new account to the old account request", async () => {
  const command = deferred();
  state.consume.mockReturnValue(command.promise);
  const account = (email: string) => {
    const provider = native("Alpha", email);
    return {
      ...provider,
      usageLimits: {
        ...provider.usageLimits,
        windows: [window, { ...window, id: "weekly", kind: "weekly" as const, label: "Weekly" }],
      },
    } satisfies ServerProvider;
  };
  await act(() => {
    renderer = create(
      <UsageLimitsPooled presentations={presentation([account("alpha@example.com")])} now={now} />,
    );
  });
  await openAndConfirm("Alpha");
  await act(() =>
    renderer.update(
      <UsageLimitsPooled presentations={presentation([account("beta@example.com")])} now={now} />,
    ),
  );
  const segments = renderer.root.findAll(
    (node) => node.type === "button" && node.props["aria-label"]?.startsWith("Alpha:"),
  );
  await act(() => segments[1]!.props.onClick());
  const action = renderer.root.findAll(
    (node) =>
      node.type === "button" &&
      (node.children.includes("Use reset") || node.children.includes("Using…")),
  )[0]!;
  expect(action.props.disabled).toBe(true);
  await act(async () => command.resolve({ _tag: "Success", value: { outcome: "reset" } }));
  expect(statusText()).toBe("");
  expect(state.consume).toHaveBeenCalledTimes(1);
});

it.each([
  [{ _tag: "Success", value: { outcome: "noCredit" } }, "No reset credit left."],
  [
    { _tag: "Success", value: { outcome: "reset", warning: "Refresh the provider." } },
    "Refresh the provider.",
  ],
  [{ _tag: "Failure", cause: { error: new Error("Provider offline") } }, "Provider offline"],
])("shows the account outcome after the dialog closes", async (result, expected) => {
  const command = deferred();
  state.consume.mockReturnValue(command.promise);
  await act(() => {
    renderer = create(
      <UsageLimitsPooled presentations={presentation([native("Alpha")])} now={now} />,
    );
  });
  await openAndConfirm("Alpha");
  await act(async () => command.resolve(result));
  expect(statusText()).toContain(expected);
});

it.each([
  [{ _tag: "Success", value: { outcome: "reset" } }, "Reset applied"],
  [{ _tag: "Failure", cause: { error: new Error("Old account failed") } }, "Old account failed"],
])(
  "does not show a late result on a new account with the same instance",
  async (result, oldText) => {
    const command = deferred();
    state.consume.mockReturnValue(command.promise);
    await act(() => {
      renderer = create(
        <UsageLimitsPooled presentations={presentation([native("Alpha")])} now={now} />,
      );
    });
    await openAndConfirm("Alpha");
    await act(() => {
      renderer.update(
        <UsageLimitsPooled
          presentations={presentation([native("Alpha", "beta@example.com", "ws-2")])}
          now={now}
        />,
      );
    });
    expect(statusText()).toBe("");
    await act(async () => command.resolve(result));
    expect(statusText()).not.toContain(oldText);
    expect(statusText()).toBe("");
  },
);

it("keeps the last hub credit result visible when its redeem target disappears", async () => {
  const command = deferred();
  state.consume.mockReturnValue(command.promise);
  const hub = {
    id: "hub-a.json",
    driver: ProviderDriverKind.make("codex"),
    usageLimits: {
      checkedAt: "2026-09-03T11:00:00Z",
      windows: [window],
      resetCredits: { availableCount: 1, nextCreditId: "credit-a" },
    },
  };
  await act(() => {
    renderer = create(<UsageLimitsPooled presentations={presentation([], [hub])} now={now} />);
  });
  await openAndConfirm("hub-a");
  expect(state.consume).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      sourceId: UsageLimitSourceId.make("hub"),
      accountId: "hub-a.json",
      creditId: "credit-a",
    },
  });
  await act(() => {
    renderer.update(
      <UsageLimitsPooled
        presentations={presentation(
          [],
          [
            {
              ...hub,
              usageLimits: { ...hub.usageLimits, resetCredits: { availableCount: 0 } },
            },
          ],
        )}
        now={now}
      />,
    );
  });
  expect(statusText()).toContain("Using");
  await act(async () => command.resolve({ _tag: "Success", value: { outcome: "reset" } }));
  expect(statusText()).toContain("Reset applied");
});
