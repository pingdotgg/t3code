import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  acquirePreviewForward,
  navigateTabThroughForward,
  releaseTabForward,
  resetSshPreviewForwardsForTests,
  settleOpenedForward,
} from "./sshPreviewForwards";

const SSH_ENV = EnvironmentId.make("environment-ssh");
const LAN_ENV = EnvironmentId.make("environment-lan");
const THREAD = { environmentId: SSH_ENV, threadId: ThreadId.make("thread-1") };
const SSH_TARGET = { alias: "devbox", hostname: "devbox", username: null, port: null };

const catalogEntries = new Map<EnvironmentId, unknown>([
  [
    SSH_ENV,
    {
      target: { _tag: "SshConnectionTarget" },
      profile: Option.some({ _tag: "SshConnectionProfile", target: SSH_TARGET }),
    },
  ],
  [LAN_ENV, { target: { _tag: "BearerConnectionTarget" }, profile: Option.none() }],
]);

vi.mock("~/connection/catalog", () => ({ environmentCatalog: { catalogValueAtom: "catalog" } }));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => ({ entries: catalogEntries }) },
}));
vi.mock("~/state/session", () => ({
  readPreparedConnection: () => ({ httpBaseUrl: "http://127.0.0.1:41000" }),
}));

interface PendingAcquire {
  readonly remotePort: number;
  readonly resolve: (localPort: number) => void;
}

let pending: PendingAcquire[];
let released: string[];
let nextLease: number;

beforeEach(() => {
  pending = [];
  released = [];
  nextLease = 0;
  vi.stubGlobal("window", {
    desktopBridge: {
      acquireSshPortForward: (_target: unknown, remotePort: number) =>
        new Promise((resolve) => {
          pending.push({
            remotePort,
            resolve: (localPort) => resolve({ leaseId: `lease-${++nextLease}`, localPort }),
          });
        }),
      releaseSshPortForward: async (leaseId: string) => {
        released.push(leaseId);
      },
    },
  });
});

afterEach(() => {
  resetSshPreviewForwardsForTests();
  vi.unstubAllGlobals();
});

describe("acquirePreviewForward", () => {
  it("rewrites a remote loopback URL onto the forwarded local port", async () => {
    const forward = acquirePreviewForward(SSH_ENV, "http://127.0.0.1:5173/app?x=1#top");
    expect(pending.map((entry) => entry.remotePort)).toEqual([5173]);
    pending[0]!.resolve(53001);
    expect(await forward).toEqual({
      url: "http://localhost:53001/app?x=1#top",
      leaseId: "lease-1",
    });
  });

  it("leaves non-SSH environments, public hosts, and the environment server alone", async () => {
    for (const [environmentId, url] of [
      [LAN_ENV, "http://localhost:5173/"],
      [SSH_ENV, "https://example.com/"],
      [SSH_ENV, "http://127.0.0.1:41000/assets/file.html"],
    ] as const) {
      expect(await acquirePreviewForward(environmentId, url)).toEqual({ url, leaseId: null });
    }
    expect(pending).toEqual([]);
  });

  it("maps a URL on an already forwarded local port back to its remote port", async () => {
    const first = acquirePreviewForward(SSH_ENV, "http://localhost:5173/");
    pending[0]!.resolve(53001);
    await first;
    void acquirePreviewForward(SSH_ENV, "http://localhost:53001/next");
    expect(pending[1]!.remotePort).toBe(5173);
  });
});

describe("navigateTabThroughForward", () => {
  const navigate = (tabId: string, url: string, loaded: string[]): Promise<string | null> =>
    navigateTabThroughForward({
      threadRef: THREAD,
      tabId,
      url,
      navigate: async (resolved) => {
        loaded.push(resolved);
      },
    });

  it("lets only the newest overlapping navigation load and keep its lease", async () => {
    const loaded: string[] = [];
    const older = navigate("tab-1", "http://localhost:3000/", loaded);
    const newer = navigate("tab-1", "http://localhost:4000/", loaded);
    pending[1]!.resolve(54000);
    expect(await newer).toBe("http://localhost:54000/");
    pending[0]!.resolve(53000);
    expect(await older).toBeNull();
    expect(loaded).toEqual(["http://localhost:54000/"]);
    // The superseded lease is dropped; the tab keeps the newer one.
    expect(released).toEqual(["lease-2"]);
  });

  it("releases the previous lease after the swap and the last one on tab close", async () => {
    const loaded: string[] = [];
    const first = navigate("tab-1", "http://localhost:3000/", loaded);
    pending[0]!.resolve(53000);
    await first;
    const second = navigate("tab-1", "http://localhost:4000/", loaded);
    pending[1]!.resolve(54000);
    await second;
    expect(released).toEqual(["lease-1"]);
    releaseTabForward(THREAD, "tab-1");
    expect(released).toEqual(["lease-1", "lease-2"]);
  });

  it("drops the lease when the tab closes during acquisition", async () => {
    const loaded: string[] = [];
    const navigation = navigate("tab-1", "http://localhost:3000/", loaded);
    releaseTabForward(THREAD, "tab-1");
    pending[0]!.resolve(53000);
    expect(await navigation).toBeNull();
    expect(loaded).toEqual([]);
    expect(released).toEqual(["lease-1"]);
  });
});

describe("settleOpenedForward", () => {
  it("gives the lease to the opened tab, or releases it when the open failed", async () => {
    settleOpenedForward(THREAD, { url: "http://localhost:53000/", leaseId: "a" }, null);
    expect(released).toEqual(["a"]);
    settleOpenedForward(THREAD, { url: "http://localhost:53000/", leaseId: "b" }, "tab-7");
    expect(released).toEqual(["a"]);
    releaseTabForward(THREAD, "tab-7");
    expect(released).toEqual(["a", "b"]);
  });
});
