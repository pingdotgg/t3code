import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { childInputNowItem } from "./ThreadActivityBanners";
import { ThreadNow } from "./ThreadNow";
import { useOpenRelatedThread } from "./useOpenRelatedThread";

const state = vi.hoisted(() => ({
  shells: new Map<string, EnvironmentThreadShell>(),
  configs: new Map<string, { shellThreadFamilies: boolean }>(),
  wait: vi.fn(async () => undefined),
}));

// The banner under test shows no background work, and the real details pull in theme state.
vi.mock("./BackgroundWorkDetails", () => ({ BackgroundWorkDetails: () => null }));
vi.mock("../../hooks/useSettings", async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  return { getClientSettings: () => DEFAULT_CLIENT_SETTINGS };
});
vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: { kind: string; environmentId: string }) =>
      atom.kind === "config" ? state.configs.get(atom.environmentId) : { status: "live" },
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    configValueAtom: (environmentId: string) => ({ kind: "config", environmentId }),
  },
}));
vi.mock("../../state/shell", () => ({
  environmentShell: {
    stateValueAtom: (environmentId: string) => ({ kind: "shell", environmentId }),
  },
}));
vi.mock("../../state/entities", () => ({
  readThreadShell: (ref: ScopedThreadRef) =>
    state.shells.get(`${ref.environmentId}:${ref.threadId}`) ?? null,
  waitForThreadShell: state.wait,
}));

function Banner({ child }: { child: EnvironmentThreadShell }) {
  const environmentId = EnvironmentId.make("parent-machine");
  const routeThreadKey = "parent-machine:parent";
  const currentRouteThreadKeyRef = useRef(routeThreadKey);
  const onOpenThread = useOpenRelatedThread({
    environmentId,
    routeThreadKey,
    currentRouteThreadKeyRef,
  });
  return (
    <ThreadNow
      attention={childInputNowItem({
        childThreadInputs: [child],
        parentAwaitingUser: false,
        onOpenThread,
      })}
      work={null}
      syncPhase={null}
      goal={null}
    />
  );
}

function setup(environmentId: string, approval = true) {
  state.shells.clear();
  state.configs.clear();
  state.wait.mockClear();
  const child = makeThreadFixture({
    id: ThreadId.make("child"),
    environmentId: EnvironmentId.make(environmentId),
    title: "Validate on MINI",
    hasPendingApprovals: approval,
    hasPendingUserInput: !approval,
  });
  state.shells.set(`${environmentId}:child`, child);
  state.configs.set(environmentId, { shellThreadFamilies: false });
  state.configs.set("parent-machine", { shellThreadFamilies: true });
  return child;
}

it.each(["Open approval", "Validate on MINI", "Open question"])(
  "%s opens the child on its own machine",
  async (label) => {
    const child = setup("mini", label !== "Open question");
    await using screen = await render(<Banner child={child} />, {
      router: "/parent-machine/parent",
    });
    await userEvent.click(screen.getByRole("button", { name: label, exact: true }));
    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/mini/child"));
  },
);

it("keeps local child approvals on their machine", async () => {
  const child = setup("parent-machine");
  await using screen = await render(<Banner child={child} />, {
    router: "/parent-machine/parent",
  });
  await userEvent.click(screen.getByRole("button", { name: "Open approval" }));
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/parent-machine/child"),
  );
});
