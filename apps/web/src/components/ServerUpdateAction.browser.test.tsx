import { RegistryContext } from "@effect/atom-react";
import { AuthSessionState, type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../test/render";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
const testState = vi.hoisted(() => ({
  updateServer: vi.fn(),
  toast: vi.fn(),
  clipboard: vi.fn(),
  sessionAtom: null as unknown,
  sessionAtoms: new Map<EnvironmentId, unknown>(),
  serverVersions: new Map<string, string>(),
}));

vi.mock(import("~/hooks/useCopyToClipboard"), async (original) => ({
  ...(await original()),
  useCopyToClipboard: ((options: { onCopy: (context: { command: string }) => void }) => ({
    copyToClipboard: (command: string, context: { command: string }) => {
      testState.clipboard(command);
      options.onCopy(context);
    },
    isCopied: false,
  })) as never,
}));
vi.mock(import("~/state/session"), async (original) => {
  const actual = await original();
  const { environmentAtomList } = await import("~/state/environmentAtomList");
  const sessionStateAtom = ((environmentId: EnvironmentId) =>
    testState.sessionAtoms.get(environmentId) ?? testState.sessionAtom) as never;
  return {
    ...actual,
    environmentSession: { ...actual.environmentSession, sessionStateAtom },
    environmentSessionStatesAtom: environmentAtomList("test-session-states", sessionStateAtom),
  };
});
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: (() =>
    new Map(
      [...testState.serverVersions].map(([id, serverVersion]) => [
        id,
        { environment: { serverVersion } },
      ]),
    )) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => testState.updateServer) as never,
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: testState.toast } };
});

import { resetConfirmDialogForTests } from "~/confirmDialog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  ServerUpdateAction,
  ServerUpdatesAction,
  type ServerUpdateTarget,
} from "./ServerUpdateAction";

const decodeSessionState = Schema.decodeUnknownSync(AuthSessionState);

const legacyAuth = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "t3_session",
} as const;

const currentSession = {
  authenticated: true,
  scopes: ["environment:maintain"],
  auth: {
    ...legacyAuth,
    serverUpdateScope: "environment:maintain",
  },
} as const satisfies AuthSessionState;

// Paired before environment:maintain was split out; the server reports the stored grant.
const legacyGrant = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "relay:read",
] as const;
const legacyPairedSession = decodeSessionState({
  ...currentSession,
  scopes: legacyGrant,
  permissions: legacyGrant,
});

const success = (method: "boot-service" | "desktop-app" = "boot-service", version = "0.0.31") =>
  AsyncResult.success({ targetVersion: version, method });

let sessionAtom: Atom.Writable<SessionResult>;

function setSession(session: SessionResult) {
  appAtomRegistry.set(sessionAtom, session);
}

function setup(): Disposable {
  testState.updateServer.mockReset();
  testState.toast.mockReset();
  testState.clipboard.mockReset();
  testState.serverVersions.clear();
  sessionAtom = Atom.make<SessionResult>(AsyncResult.success(currentSession));
  testState.sessionAtom = sessionAtom;
  testState.sessionAtoms.clear();
  resetConfirmDialogForTests();
  return { [Symbol.dispose]: resetConfirmDialogForTests };
}

function renderUpdate(element: ReactNode) {
  return render(
    <RegistryContext.Provider value={appAtomRegistry}>{element}</RegistryContext.Provider>,
  );
}

function button(screen: Screen, name?: string) {
  const buttons = [...screen.container.querySelectorAll("button")];
  return name === undefined
    ? buttons[0]
    : buttons.find((element) => element.textContent?.trim() === name);
}

function description(screen: Screen, name?: string) {
  const id = button(screen, name)?.getAttribute("aria-describedby");
  return id ? (document.getElementById(id)?.textContent ?? "") : "";
}

async function click(screen: Screen, name?: string) {
  await act(async () => button(screen, name)!.click());
}

function renderAction(props: Partial<Parameters<typeof ServerUpdateAction>[0]> = {}) {
  return renderUpdate(
    <ServerUpdateAction
      environmentId={"env-test" as EnvironmentId}
      serverLabel="Test server"
      selfUpdate="boot-service"
      targetVersion="0.0.31"
      {...props}
    />,
  );
}

describe("ServerUpdateAction", () => {
  it.each([
    { serverUpdateScope: undefined, scopes: ["orchestration:operate"], allowed: true },
    { serverUpdateScope: undefined, scopes: ["orchestration:read"], allowed: false },
    {
      serverUpdateScope: "environment:maintain",
      scopes: ["orchestration:operate"],
      allowed: false,
    },
    {
      serverUpdateScope: "environment:maintain",
      scopes: ["environment:maintain"],
      allowed: true,
    },
  ] as const)(
    "uses the advertised update scope $serverUpdateScope with grant $scopes",
    async ({ serverUpdateScope, scopes, allowed }) => {
      using _state = setup();
      setSession(
        AsyncResult.success(
          decodeSessionState({
            ...currentSession,
            scopes,
            auth: {
              ...legacyAuth,
              ...(serverUpdateScope === undefined ? {} : { serverUpdateScope }),
            },
          }),
        ),
      );
      testState.updateServer.mockResolvedValue(success());

      await using screen = await renderAction();
      expect(button(screen, "Update")!.disabled).toBe(!allowed);
      await click(screen, "Update");

      expect(testState.updateServer).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );

  it("disables the action once maintenance access is removed", async () => {
    using _state = setup();
    await using screen = await renderAction();
    await act(() => setSession(AsyncResult.success({ ...currentSession, scopes: [] })));
    expect(button(screen, "Update")!.disabled).toBe(true);
    await click(screen, "Update");
    expect(testState.updateServer).not.toHaveBeenCalled();
  });

  it("explains that a connection paired before environment:maintain must re-pair", async () => {
    using _state = setup();
    setSession(AsyncResult.success(legacyPairedSession));
    await using screen = await renderAction();

    expect(button(screen, "Update")!.disabled).toBe(true);
    expect(description(screen, "Update")).toBe(
      "Test server can't be updated from this connection. Pair again with a link that permits server updates.",
    );
  });
});

describe("ServerUpdatesAction", () => {
  const targets: ReadonlyArray<ServerUpdateTarget> = [
    {
      environmentId: "batch-a" as EnvironmentId,
      serverLabel: "Laptop",
      selfUpdate: "boot-service",
      targetVersion: "0.0.31",
    },
    {
      environmentId: "batch-b" as EnvironmentId,
      serverLabel: "Office",
      selfUpdate: "respawn",
      targetVersion: "0.0.31",
    },
    {
      environmentId: "batch-c" as EnvironmentId,
      serverLabel: "Manual",
      selfUpdate: null,
      targetVersion: "0.0.31",
    },
  ];

  const mount = (batch = targets) => renderUpdate(<ServerUpdatesAction targets={batch} />);

  it("names a failed machine while letting the other machine complete", async () => {
    using _state = setup();
    testState.updateServer
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Download failed"))))
      .mockResolvedValueOnce(success());
    await using screen = await mount();
    await click(screen, "Update all");

    expect(testState.updateServer).toHaveBeenCalledTimes(2);
    expect(testState.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Laptop update failed",
      description: "Download failed",
    });
    expect(testState.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Office updated" }),
    );
    expect(button(screen, "Update all")!.disabled).toBe(false);
  });

  it("does not offer Update all when no target grants environment:maintain", async () => {
    using _state = setup();
    setSession(AsyncResult.success(legacyPairedSession));
    await using screen = await mount(targets.slice(0, 2));

    expect(button(screen, "Update all")!.disabled).toBe(true);
    expect(description(screen, "Update all")).toContain("Pair again");
  });

  it("does not ask to pair again when a mixed batch is pending", async () => {
    using _state = setup();
    const denied = Atom.make<SessionResult>(AsyncResult.success(legacyPairedSession));
    testState.sessionAtoms.set("batch-b" as EnvironmentId, denied);
    let resolveUpdate!: (result: ReturnType<typeof success>) => void;
    const update = new Promise<ReturnType<typeof success>>((resolve) => {
      resolveUpdate = resolve;
    });
    testState.updateServer.mockReturnValue(update);
    await using screen = await mount(targets.slice(0, 2));

    try {
      await click(screen, "Update all");
      expect(button(screen, "Update all")!.disabled).toBe(true);
      expect(testState.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Office skipped" }),
      );

      await act(() => button(screen, "Update all")!.parentElement!.click());

      expect(testState.toast).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: "Pair again to update" }),
      );
    } finally {
      await act(async () => {
        resolveUpdate(success());
        await update;
      });
    }
    expect(button(screen, "Update all")!.disabled).toBe(false);
  });

  it("names a target it skips for missing environment:maintain", async () => {
    using _state = setup();
    const denied = Atom.make<SessionResult>(AsyncResult.success(legacyPairedSession));
    testState.sessionAtoms.set("batch-b" as EnvironmentId, denied);
    testState.updateServer.mockResolvedValue(success());
    await using screen = await mount(targets.slice(0, 2));
    await click(screen, "Update all");

    expect(testState.updateServer).toHaveBeenCalledTimes(1);
    expect(testState.updateServer).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: "batch-a" }),
    );
    expect(testState.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Office skipped",
        description: expect.stringContaining("Pair again"),
      }),
    );
  });

  it("skips a machine whose update would cross Stable and Nightly", async () => {
    using _state = setup();
    testState.serverVersions.set("batch-a", "0.0.30-nightly.20261001.1");
    testState.updateServer.mockResolvedValue(success());
    await using screen = await mount();
    await click(screen, "Update all");

    expect(testState.updateServer).toHaveBeenCalledTimes(1);
    expect(testState.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Office updated" }),
    );
  });
});
