import { EnvironmentId, type DesktopRemotePreviewProxyStatus } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
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
vi.mock("~/state/session", () => ({ readPreparedConnection: mocks.connection }));

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
    configure: vi.fn(async () => {
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
