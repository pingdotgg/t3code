import {
  EnvironmentId,
  type DesktopRemotePreviewProxyStatus,
  type DesktopRemotePreviewProxyConfigureInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ command: vi.fn(), connection: vi.fn(), subscribe: vi.fn() }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: mocks.command,
  squashAtomCommandFailure: () => new Error("offline"),
}));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => null, subscribe: mocks.subscribe },
}));
vi.mock("~/state/presentation", () => ({
  environmentPresentations: { presentationAtom: () => "presentation" },
}));
vi.mock("~/state/preview", () => ({ previewEnvironment: { issueProxyGrant: "issue" } }));
vi.mock("~/state/session", () => ({
  readPreparedConnection: mocks.connection,
  environmentSession: { preparedConnectionValueAtom: () => "prepared" },
}));

const ENV = EnvironmentId.make("remote");
const expired: DesktopRemotePreviewProxyStatus = {
  environmentId: ENV,
  state: "expired",
  ports: [3000],
  deniedPorts: [],
  expiresAt: 0,
  externalAccess: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function setup() {
  vi.resetModules();
  mocks.command.mockReset();
  mocks.connection
    .mockReset()
    .mockReturnValue({ httpBaseUrl: "http://remote.test", label: "remote" });
  mocks.subscribe.mockReset().mockReturnValue(() => {});
  let state = expired;
  const configured = deferred<void>();
  const bridge = {
    getStatus: vi.fn(async () => state),
    getStatuses: vi.fn(async () => [state]),
    configure: vi.fn(async (_input: DesktopRemotePreviewProxyConfigureInput) => {
      state = { ...state, state: "ready" };
      configured.resolve();
      return state;
    }),
    revoke: vi.fn(async () => {
      state = { ...state, state: "revoked" };
    }),
    onStatus: vi.fn(() => () => {}),
  };
  vi.stubGlobal("window", { desktopBridge: { preview: { remoteProxy: bridge } } });
  const module = await import("./remotePreviewProxy");
  return {
    module,
    bridge,
    configured: configured.promise,
    state: () => state,
    [Symbol.dispose]() {
      vi.unstubAllGlobals();
    },
  };
}

it("turning off access invalidates an approval already awaiting its grant", async () => {
  using h = await setup();
  const requested = deferred<void>();
  const granted = deferred<unknown>();
  mocks.command.mockImplementation(() => {
    requested.resolve();
    return granted.promise;
  });
  const pending = h.module.approveRemotePreviewPorts(ENV, [3000]);
  await requested.promise;
  await h.module.revokeRemotePreview(ENV);
  granted.resolve({
    _tag: "Success",
    value: { grant: "late", ports: [3000], expiresAt: DateTime.makeUnsafe(600_000) },
  });
  await pending;
  expect(h.bridge.configure).not.toHaveBeenCalled();
  expect(h.state().state).toBe("revoked");
  expect(mocks.subscribe).not.toHaveBeenCalled();
});

it("reconciles an already expired desktop proxy on renderer startup without a mounted preview", async () => {
  using h = await setup();
  mocks.command.mockResolvedValue({
    _tag: "Success",
    value: { grant: "fresh", ports: [3000], expiresAt: DateTime.makeUnsafe(600_000) },
  });
  const stop = h.module.startRemotePreviewProxyMaintenance();
  expect(h.bridge.getStatuses).toHaveBeenCalled();
  await h.configured;
  expect(h.state().state).toBe("ready");
  stop();
});

it("moves a running proxy to the newly selected route without waiting for grant expiry", async () => {
  using h = await setup();
  mocks.command.mockResolvedValue({
    _tag: "Success",
    value: { grant: "fresh", ports: [3000], expiresAt: DateTime.makeUnsafe(600_000) },
  });
  const stop = h.module.startRemotePreviewProxyMaintenance();
  await h.configured;
  const subscription = mocks.subscribe.mock.calls.find(([atom]) => atom === "prepared");
  expect(subscription).toBeDefined();
  const next = { httpBaseUrl: "https://connect.test", label: "remote" };
  mocks.connection.mockReturnValue(next);
  const moved = deferred<void>();
  h.bridge.configure.mockImplementationOnce(async (input) => {
    expect(input.httpBaseUrl).toBe(next.httpBaseUrl);
    moved.resolve();
    return h.state();
  });
  subscription![1](Option.some(next));
  await moved.promise;
  await h.module.revokeRemotePreview(ENV);
  const count = mocks.command.mock.calls.length;
  mocks.connection.mockReturnValue({ ...next, httpBaseUrl: "https://another.test" });
  subscription![1](Option.some(mocks.connection()));
  await Promise.resolve();
  expect(mocks.command).toHaveBeenCalledTimes(count);
  stop();
});

it("refuses a port beyond the grant limit and keeps the ports already approved", async () => {
  using h = await setup();
  mocks.command.mockImplementation(
    async (_registry, _command, args: { input: { ports: number[] } }) => ({
      _tag: "Success",
      value: { grant: "g", ports: args.input.ports, expiresAt: DateTime.makeUnsafe(600_000) },
    }),
  );
  const ports = Array.from({ length: 16 }, (_, index) => 3000 + index);
  await h.module.approveRemotePreviewPorts(ENV, ports);
  const issued = mocks.command.mock.calls.length;

  await expect(h.module.approveRemotePreviewPorts(ENV, [4000])).rejects.toThrow(/at most 16/);
  expect(mocks.command).toHaveBeenCalledTimes(issued);

  await h.module.approveRemotePreviewPorts(ENV, [], { refresh: true });
  expect(mocks.command.mock.lastCall?.[2].input.ports.toSorted()).toEqual(ports);

  // Concurrent requests are judged in the order they were made.
  await h.module.revokeRemotePreview(ENV);
  await h.module.approveRemotePreviewPorts(ENV, ports.slice(0, 15));
  const first = h.module.approveRemotePreviewPorts(ENV, [5000]);
  const second = h.module.approveRemotePreviewPorts(ENV, [5001]);
  await expect(first).resolves.not.toBeNull();
  await expect(second).rejects.toThrow(/at most 16/);
  expect(mocks.command.mock.lastCall?.[2].input.ports).toContain(5000);
  expect(mocks.command.mock.lastCall?.[2].input.ports).not.toContain(5001);
});

it("keeps a requested port when reading the desktop proxy status fails", async () => {
  using h = await setup();
  mocks.command.mockImplementation(
    async (_registry, _command, args: { input: { ports: number[] } }) => ({
      _tag: "Success",
      value: { grant: "g", ports: args.input.ports, expiresAt: DateTime.makeUnsafe(600_000) },
    }),
  );
  h.bridge.getStatus.mockRejectedValueOnce(new Error("status unavailable"));
  await expect(h.module.approveRemotePreviewPorts(ENV, [4000])).rejects.toThrow(
    "status unavailable",
  );

  await h.module.approveRemotePreviewPorts(ENV, [], { refresh: true });
  expect(mocks.command.mock.lastCall?.[2].input.ports).toContain(4000);
});
