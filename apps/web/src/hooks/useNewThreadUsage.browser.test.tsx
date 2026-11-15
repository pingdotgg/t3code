import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, fakeTimers, render } from "../../test/render";
import { useNewThreadUsage } from "./useNewThreadUsage";

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("@t3tools/client-runtime/state/usage", () => ({ refreshNewThreadUsage: mocks.refresh }));
vi.mock("../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  const presentation = Atom.make({ connection: { phase: "connected" } });
  return { environmentPresentations: { presentationAtom: () => presentation } };
});

function setup() {
  mocks.refresh.mockReset();
  return mocks;
}

const primary = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const fallback = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "sonnet" };
function provider(
  selection: typeof primary,
  exhausted: boolean,
  checkedAt: string,
): ServerProvider {
  return {
    instanceId: selection.instanceId,
    driver: ProviderDriverKind.make(
      selection.instanceId === primary.instanceId ? "codex" : "claudeAgent",
    ),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "first@example.com" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [
        { id: "primary", kind: "session", label: "Session", usedPercent: exhausted ? 100 : 0 },
      ],
    },
  };
}
function Probe({ providers }: { readonly providers: readonly ServerProvider[] }) {
  const input = { defaultSelection: primary, fallbackSelection: fallback, providers, now: 0 };
  const usage = useNewThreadUsage(EnvironmentId.make("draft-quota-race"), input, "draft-one");
  const resolved = resolveNewThreadModelSelection({ ...input, providers: usage.providers });
  return (
    <>
      <button type="button" onClick={usage.prepareSend}>
        Send
      </button>
      <output>
        {usage.pending ? "waiting" : "ready"}:{resolved.selection?.instanceId}
      </output>
    </>
  );
}

it("reconciles fallback quota results across subscription updates before allowing send", async () => {
  const { refresh } = setup();
  let complete!: (providers: readonly ServerProvider[]) => void;
  refresh.mockReturnValueOnce(
    new Promise<readonly ServerProvider[]>((resolve) => {
      complete = resolve;
    }),
  );
  const initial = [
    provider(primary, false, "2026-06-10T00:00:00.000Z"),
    provider(fallback, false, "2026-06-10T00:00:00.000Z"),
  ];
  // This probe only observes quota reconciliation, without navigation.
  await using screen = await render(<Probe providers={initial} />, { router: false });
  await expect.element(screen.getByText("waiting:codex")).toBeVisible();
  const primaryUpdate = [provider(primary, true, "2026-06-10T00:01:00.000Z"), initial[1]!];
  await screen.rerender(<Probe providers={primaryUpdate} />);
  await expect.element(screen.getByText("waiting:claudeAgent")).toBeVisible();
  await act(() =>
    complete([primaryUpdate[0]!, provider(fallback, true, "2026-06-10T00:01:00.000Z")]),
  );
  await expect.element(screen.getByText("ready:codex")).toBeVisible();
  await screen.rerender(
    <Probe providers={[{ ...primaryUpdate[0]!, version: "updated" }, initial[1]!]} />,
  );
  await expect.element(screen.getByText("ready:codex")).toBeVisible();
  await screen.rerender(
    <Probe
      providers={[primaryUpdate[0]!, provider(fallback, false, "2026-06-10T00:02:00.000Z")]}
    />,
  );
  await expect.element(screen.getByText("ready:claudeAgent")).toBeVisible();
  const placeholder = {
    ...provider(primary, false, "2026-06-10T00:03:00.000Z"),
    usageLimits: {
      checkedAt: "2026-06-10T00:03:00.000Z",
      windows: [],
      unavailable: { reason: "probeFailed" as const },
    },
  };
  await screen.rerender(<Probe providers={[placeholder, initial[1]!]} />);
  await expect.element(screen.getByText("ready:codex")).toBeVisible();
  refresh.mockResolvedValue([primaryUpdate[0]!, initial[1]!]);
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await expect.element(screen.getByText("ready:claudeAgent")).toBeVisible();
  const exhausted = provider(primary, true, "2026-06-10T00:04:00.000Z");
  await screen.rerender(<Probe providers={[exhausted, initial[1]!]} />);
  await expect.element(screen.getByText("ready:claudeAgent")).toBeVisible();
  refresh.mockResolvedValue([
    {
      ...exhausted,
      usageLimits: {
        checkedAt: "2026-06-10T00:05:00.000Z",
        windows: [],
        unavailable: { reason: "unsupported" as const },
      },
    },
    initial[1]!,
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await expect.element(screen.getByText("ready:codex")).toBeVisible();
  refresh.mockReturnValue(new Promise(() => {}));
  await screen.rerender(
    <Probe
      providers={[
        primaryUpdate[0]!,
        { ...initial[1]!, auth: { status: "authenticated", email: "second@example.com" } },
      ]}
    />,
  );
  await expect.element(screen.getByText("waiting:claudeAgent")).toBeVisible();
});

it("revalidates an open draft at submission without background polling", async () => {
  const { refresh } = setup();
  const initial = [
    provider(primary, false, "2026-06-10T00:00:00.000Z"),
    provider(fallback, false, "2026-06-10T00:00:00.000Z"),
  ];
  refresh.mockResolvedValue(initial);
  using _timers = fakeTimers({ now: 0 });
  // This probe only observes draft selection, without navigation.
  await using screen = await render(<Probe providers={initial} />, { router: false });
  await expect.element(screen.getByText("ready:codex")).toBeVisible();
  await act(() => vi.advanceTimersByTime(360_000));
  expect(refresh).toHaveBeenCalledTimes(1);
  refresh.mockResolvedValue([
    provider(primary, true, "2026-06-10T00:06:00.000Z"),
    provider(fallback, false, "2026-06-10T00:06:00.000Z"),
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await expect.element(screen.getByText("ready:claudeAgent")).toBeVisible();
});

it.each(["email", "workspace", "key", "fingerprint", "status"] as const)(
  "reconciles quota ownership before freshness (%s)",
  async (identity) => {
    const { refresh } = setup();
    const previous = {
      ...provider(primary, true, "2026-06-10T00:02:00.000Z"),
      auth: {
        status: "authenticated" as const,
        email: "first@example.com",
        workspaceId: "workspace-a",
        usageRefreshKey: "owner-a",
      },
    };
    const incoming = {
      ...provider(primary, false, "2026-06-10T00:01:00.000Z"),
      auth: {
        ...previous.auth,
        status: identity === "status" ? ("unknown" as const) : ("authenticated" as const),
        ...(identity === "email" ? { email: "second@example.com" } : {}),
        ...(identity === "workspace" ? { workspaceId: "workspace-b" } : {}),
        ...(identity === "key" ? { usageRefreshKey: "owner-b" } : {}),
      },
    };
    if (identity === "fingerprint") {
      previous.usageLimits = { ...previous.usageLimits!, credentialFingerprint: "owner-a" };
      incoming.usageLimits = { ...incoming.usageLimits!, credentialFingerprint: "owner-b" };
    }
    if (identity === "status")
      incoming.usageLimits = {
        checkedAt: incoming.checkedAt,
        windows: [],
        unavailable: { reason: "probeFailed" },
      };
    const available = provider(fallback, false, previous.checkedAt);
    refresh.mockResolvedValue([incoming, available]);
    // This probe only observes draft quota reconciliation, without navigation.
    await using screen = await render(<Probe providers={[previous, available]} />, {
      router: false,
    });
    await expect
      .element(screen.getByText(identity === "status" ? "ready:claudeAgent" : "ready:codex"))
      .toBeVisible();
  },
);
