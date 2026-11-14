import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type DesktopAppActivationRequest,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render, stubGlobal } from "../../../test/render";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { DesktopAppActivationCoordinator } from "./DesktopAppActivationCoordinator";

vi.mock("../../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentPresentations: { presentationsAtom: Atom.make(new Map()).pipe(Atom.keepAlive) },
  };
});
vi.mock("../../state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make(null).pipe(Atom.keepAlive) };
});
vi.mock("../../state/shell", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentShell: { statusAtom: () => Atom.make("live") } };
});
vi.mock("../../state/entities", () => ({
  readProjects: () => [
    { id: "existing", environmentId: "wsl", workspaceRoot: "/project", archivedAt: null },
  ],
  waitForProject: async () => undefined,
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { create: {}, update: {} } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => async () => ({ _tag: "Success" }),
}));
vi.mock("../../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => async () => ({ threadId: "thread" }),
}));
vi.mock("../../hooks/useProjectGroupUpdate", () => ({ reportProjectFailure: () => undefined }));

function deferredResponse() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it("completes a queued WSL activation while the primary is disconnected", async () => {
  const primary = EnvironmentId.make("primary");
  const wsl = EnvironmentId.make("wsl");
  const request = {
    version: 1,
    requestId: "wsl-request",
    type: "open-workspace",
    platform: "linux",
    workspaceRoot: "/project",
    wslDistro: "Ubuntu",
  } as const;
  const response = deferredResponse();
  let deliver: ((input: DesktopAppActivationRequest) => void) | undefined;
  const activation = {
    onRequest: (handler: (input: DesktopAppActivationRequest) => void) => {
      deliver = handler;
      return () => {
        deliver = undefined;
      };
    },
    setReady: async (ready: boolean) => {
      if (ready) deliver?.(request);
    },
    complete: async (result: unknown) => {
      response.resolve(result);
    },
  };
  using _bridge = stubGlobal("desktopBridge", {
    appActivation: activation,
    getLocalEnvironmentBootstraps: () => [{ id: "wsl", runningDistro: "Ubuntu" }],
  });
  appAtomRegistry.set(
    primaryEnvironmentIdAtom as Atom.Writable<EnvironmentId | null, EnvironmentId | null>,
    primary,
  );
  appAtomRegistry.set(
    environmentPresentations.presentationsAtom as Atom.Writable<unknown, unknown>,
    new Map([
      [
        primary,
        {
          connection: { phase: "disconnected" },
          serverConfig: null,
          entry: { target: { _tag: "PrimaryConnectionTarget" } },
        },
      ],
      [
        wsl,
        {
          connection: { phase: "connected" },
          serverConfig: { environment: { platform: { os: "linux" } } },
          entry: { target: { _tag: "BearerConnectionTarget", connectionId: "local:wsl" } },
        },
      ],
    ]),
  );
  await using _screen = await render(<DesktopAppActivationCoordinator />);
  expect(await response.promise).toMatchObject({
    ok: true,
    projectId: ProjectId.make("existing"),
    threadId: ThreadId.make("thread"),
  });

  using _timers = fakeTimers();
  const nativeResponse = deferredResponse();
  activation.complete = async (result: unknown) => {
    nativeResponse.resolve(result);
  };
  await act(async () => {
    deliver?.({
      version: 1,
      type: "open-workspace",
      requestId: "native-request",
      platform: "win32",
      workspaceRoot: "C:\\project",
    });
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(await nativeResponse.promise).toMatchObject({
    ok: false,
    code: "environment-unavailable",
  });
});
