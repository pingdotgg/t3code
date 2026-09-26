import * as React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, it, expect, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, type ExtensionInstallation } from "@t3tools/contracts";
import type { ApiStreamFrame } from "@t3tools/extension-sdk/capabilities";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { Extension } from "@t3tools/extension-sdk/host";
import type { SurfaceRenderer } from "@t3tools/extension-sdk/react";
import type { ViewRecord } from "@t3tools/extension-sdk/contracts";
import { createCatalogueRefreshQueue } from "./catalogueRefresh";
import { createInstalledExtensionController, type InstalledSnapshot } from "./installedController";
import { registerWorkspaceExtension, WorkspaceExtensionSurface } from "./workspaceRegistry";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manifest = { id: "test.installed", version: "1.0.0", apiVersion: 1 as const, surfaces: [] };
const installation: ExtensionInstallation = {
  id: manifest.id,
  contentHash: "a".repeat(64),
  enabled: true,
  grants: { capabilities: ["t3.workspace/read-text"], projectIds: [ProjectId.make("project-a")] },
  package: {
    format: 1,
    manifest,
    clientEntry: "client.mjs",
    serverEntry: "server.mjs",
    tools: [
      {
        id: "test.installed/read",
        title: "Read",
        description: "Read file",
        readOnly: true,
        inputSchema: { type: "object" },
        capabilities: ["t3.workspace/read-text"],
      },
    ],
  },
};
const context = {
  client: "web",
  resource: {
    namespace: "test.installed",
    id: "view",
    environmentId: EnvironmentId.make("env-a"),
    projectId: "project-a",
    threadId: "thread-a",
  },
};
function harness(environmentId = "env-a") {
  let catalog: readonly ExtensionInstallation[] = [installation];
  let host!: ClientHost;
  const stop = vi.fn();
  const register = vi.fn((_extension: Extension<SurfaceRenderer>) => stop);
  const snapshots: InstalledSnapshot[] = [];
  const options = {
    environmentId,
    React,
    list: vi.fn(async (_signal: AbortSignal) => ({ installations: catalog })),
    client: vi.fn(async (_id: string, hash: string, _signal: AbortSignal) => ({
      code: "fixture module",
      contentHash: hash,
    })),
    load: vi.fn<(code: string) => Promise<unknown>>(
      async (_code: string) => (bindings: ClientHost) => {
        host = bindings;
        return { manifest, surfaces: [] };
      },
    ),
    invoke: vi.fn(async () => ({ contents: "actual-shaped result" })),
    invokeApi: vi.fn(async () => ({ contents: "public API result" })),
    subscribeApi: vi.fn(
      (
        _id: string,
        _hash: string,
        _request: unknown,
        _signal: AbortSignal,
      ): AsyncIterable<ApiStreamFrame> => ({ async *[Symbol.asyncIterator]() {} }),
    ),
    discoverApis: vi.fn(async () => []),
    register,
    changed: (snapshot: InstalledSnapshot) => snapshots.push(snapshot),
  };
  const controller = createInstalledExtensionController(options);
  return {
    controller,
    options,
    stop,
    register,
    snapshots,
    setCatalog: (value: readonly ExtensionInstallation[]) => {
      catalog = value;
    },
    getHost: () => host,
  };
}
describe("installed environment controller", () => {
  it("retains unchanged factories and unloads disabled/replaced/removed generations", async () => {
    const h = harness();
    await h.controller.refresh();
    await h.controller.refresh();
    expect(h.register).toHaveBeenCalledTimes(1);
    expect(h.options.client).toHaveBeenCalledTimes(1);
    const old = h.getHost();
    h.setCatalog([{ ...installation, contentHash: "b".repeat(64) }]);
    await h.controller.refresh();
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.register).toHaveBeenCalledTimes(2);
    await expect(
      old.invokeTool("test.installed/read", {}, context, new AbortController().signal),
    ).rejects.toThrow("unavailable");
    h.setCatalog([{ ...installation, enabled: false }]);
    await h.controller.refresh();
    expect(h.stop).toHaveBeenCalledTimes(2);
    h.setCatalog([]);
    await h.controller.refresh();
    expect(h.snapshots.at(-1)?.installations).toHaveLength(0);
    h.controller.dispose();
  });
  it("binds tool calls to exact environment/project/hash and refuses post-removal result", async () => {
    const h = harness();
    await h.controller.refresh();
    const host = h.getHost();
    for (const resource of [
      { ...context.resource, environmentId: "env-b" },
      { ...context.resource, projectId: "project-b" },
    ])
      await expect(
        host.invokeTool(
          "test.installed/read",
          {},
          { ...context, resource },
          new AbortController().signal,
        ),
      ).rejects.toThrow("scope");
    await expect(
      host.invokeTool("other.installed/read", {}, context, new AbortController().signal),
    ).rejects.toThrow("scope");
    expect(h.options.invoke).not.toHaveBeenCalled();
    let finish!: (value: { contents: string }) => void;
    h.options.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = host.invokeTool(
      "test.installed/read",
      { relativePath: "README.md" },
      context,
      new AbortController().signal,
    );
    h.setCatalog([]);
    await h.controller.refresh();
    finish({ contents: "late" });
    await expect(pending).rejects.toThrow("expired");
    h.controller.dispose();
  });
  it("ignores late catalogs and module imports after a newer refresh or disposal", async () => {
    const h = harness();
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const loading = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.options.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          started();
        }),
    );
    const first = h.controller.refresh();
    await loading;
    h.setCatalog([]);
    await h.controller.refresh();
    finish(() => ({ manifest, surfaces: [] }));
    await first;
    expect(h.register).not.toHaveBeenCalled();
    h.setCatalog([installation]);
    h.options.client.mockImplementationOnce(async () => ({
      code: "x",
      contentHash: "c".repeat(64),
    }));
    await h.controller.refresh();
    expect(h.register).not.toHaveBeenCalled();
    expect(h.snapshots.at(-1)?.error).toContain("changed");
    h.controller.dispose();
  });
  it("does not unload an unrelated installed package when another client fails", async () => {
    const h = harness();
    await h.controller.refresh();
    const other = {
      ...installation,
      id: "test.other",
      package: { ...installation.package, manifest: { ...manifest, id: "test.other" }, tools: [] },
    };
    h.setCatalog([installation, other]);
    h.options.load.mockRejectedValueOnce(new Error("Broken module"));
    await h.controller.refresh();
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.snapshots.at(-1)?.error).toContain("Broken module");
    h.controller.dispose();
    expect(h.stop).toHaveBeenCalledTimes(1);
  });
});

it("keeps the same package ID independent across environment hashes and tool contexts", async () => {
  const a = harness("env-a");
  const b = harness("env-b");
  b.setCatalog([{ ...installation, contentHash: "b".repeat(64) }]);
  try {
    await Promise.all([a.controller.refresh(), b.controller.refresh()]);
    const signal = new AbortController().signal;
    await a.getHost().invokeTool("test.installed/read", {}, context, signal);
    const other = { ...context, resource: { ...context.resource, environmentId: "env-b" } };
    await b.getHost().invokeTool("test.installed/read", {}, other, signal);
    expect(a.options.invoke).toHaveBeenCalledWith(
      "test.installed/read",
      {},
      context,
      "a".repeat(64),
      expect.any(AbortSignal),
    );
    expect(b.options.invoke).toHaveBeenCalledWith(
      "test.installed/read",
      {},
      other,
      "b".repeat(64),
      expect.any(AbortSignal),
    );
    a.controller.dispose();
    await b.getHost().invokeTool("test.installed/read", {}, other, signal);
    expect(b.stop).not.toHaveBeenCalled();
  } finally {
    a.controller.dispose();
    b.controller.dispose();
  }
});

it("does not register a module that finishes importing after connection disposal", async () => {
  const h = harness();
  let finish!: (value: unknown) => void;
  let started!: () => void;
  const loading = new Promise<void>((resolve) => {
    started = resolve;
  });
  h.options.load.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
        started();
      }),
  );
  const refresh = h.controller.refresh();
  await loading;
  h.controller.dispose();
  finish(() => ({ manifest, surfaces: [] }));
  await refresh;
  expect(h.register).not.toHaveBeenCalled();
});

it("revokes a factory's captured tool binding when registration validation fails", async () => {
  const h = harness();
  let captured!: ClientHost;
  h.options.load.mockResolvedValueOnce((bindings: ClientHost) => {
    captured = bindings;
    return { manifest: { ...manifest, version: "2.0.0" }, surfaces: [] };
  });
  try {
    await h.controller.refresh();
    expect(h.register).not.toHaveBeenCalled();
    await expect(
      captured.invokeTool("test.installed/read", {}, context, new AbortController().signal),
    ).rejects.toThrow("unavailable");
    expect(h.options.invoke).not.toHaveBeenCalled();
  } finally {
    h.controller.dispose();
  }
});

it("owns pending HTTP cancellation on dispose and update even if the caller never aborts", async () => {
  for (const action of ["dispose", "update"]) {
    const h = harness();
    let delivered!: AbortSignal;
    const invoke = vi.fn(
      (_id: string, _input: unknown, _context: unknown, _hash: string, signal: AbortSignal) => {
        delivered = signal;
        return new Promise<never>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("HTTP cancelled")), {
            once: true,
          }),
        );
      },
    );
    const controller = createInstalledExtensionController({ ...h.options, invoke });
    try {
      await controller.refresh();
      const caller = new AbortController();
      const result = h
        .getHost()
        .invokeTool("test.installed/read", {}, context, caller.signal)
        .then(
          () => null,
          (error) => error,
        );
      if (action === "dispose") controller.dispose();
      else {
        h.setCatalog([{ ...installation, contentHash: "b".repeat(64) }]);
        await controller.refresh();
      }
      expect(caller.signal.aborted).toBe(false);
      expect(delivered.aborted).toBe(true);
      expect(await result).toMatchObject({ message: "HTTP cancelled" });
    } finally {
      controller.dispose();
      h.controller.dispose();
    }
  }
});

it("times out an async module and activates the next package without retaining a timer", async () => {
  vi.useFakeTimers();
  const h = harness();
  let started!: () => void;
  const loading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const other = {
    ...installation,
    id: "test.next",
    package: { ...installation.package, manifest: { ...manifest, id: "test.next" }, tools: [] },
  };
  h.setCatalog([installation, other]);
  h.options.load.mockImplementationOnce(() => {
    started();
    return new Promise(() => {});
  });
  h.options.load.mockResolvedValueOnce(() => ({
    manifest: { ...manifest, id: "test.next" },
    surfaces: [],
  }));
  const refresh = h.controller.refresh();
  try {
    await loading;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.snapshots.at(-1)?.loading).toBe(false);
    expect(h.snapshots.at(-1)?.error).toContain("timed out");
    expect(h.register).toHaveBeenCalledTimes(1);
    await refresh;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    h.controller.dispose();
    vi.useRealTimers();
  }
});

it("binds public API identity to the installed package and rejects stale results after revocation", async () => {
  const h = harness();
  await h.controller.refresh();
  const request = {
    id: "t3.workspace/files",
    versionRange: "^1.0.0",
    method: "readText",
    input: { relativePath: "README.md" },
    context,
  };
  await h.getHost().invokeApi(request, new AbortController().signal);
  expect(h.options.invokeApi).toHaveBeenCalledWith(
    installation.id,
    installation.contentHash,
    request,
    expect.any(AbortSignal),
  );
  await expect(
    h.getHost().invokeApi(
      {
        ...request,
        context: { ...context, resource: { ...context.resource, projectId: "other" } },
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("scope");
  let finish!: (value: { contents: string }) => void;
  h.options.invokeApi.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = h.getHost().invokeApi(request, new AbortController().signal);
  h.setCatalog([{ ...installation, enabled: false }]);
  await h.controller.refresh();
  finish({ contents: "stale" });
  await expect(pending).rejects.toThrow("expired");
  h.controller.dispose();
});

it("negotiates catalogue receipts only when the connected host explicitly advertises them", async () => {
  const h = harness();
  try {
    await h.controller.refresh();
    expect(h.snapshots.at(-1)?.supportsCatalogueChanges).toBe(false);
    h.options.list.mockImplementation(async () => ({
      installations: [installation],
      supportsCatalogueChanges: true,
    }));
    await h.controller.refresh();
    expect(h.snapshots.at(-1)?.supportsCatalogueChanges).toBe(true);
  } finally {
    h.controller.dispose();
  }
});

it("retains receipt negotiation after a transient list failure so the next receipt can recover", async () => {
  const h = harness();
  const receipts = createCatalogueRefreshQueue(() => h.controller.refresh());
  h.options.list.mockImplementation(async () => ({
    installations: [installation],
    supportsCatalogueChanges: true,
  }));
  try {
    await receipts.request();
    expect(h.snapshots.at(-1)?.supportsCatalogueChanges).toBe(true);
    h.options.list.mockRejectedValueOnce(new Error("Temporary HTTP failure"));
    await receipts.request();
    expect(h.snapshots.at(-1)?.error).toBe("Temporary HTTP failure");
    expect(h.snapshots.at(-1)?.supportsCatalogueChanges).toBe(true);
    await receipts.request();
    expect(h.snapshots.at(-1)?.error).toBeNull();
    expect(h.snapshots.at(-1)?.installations).toHaveLength(1);
    expect(h.snapshots.at(-1)?.supportsCatalogueChanges).toBe(true);
    expect(h.register).toHaveBeenCalledTimes(2);
    h.options.list.mockImplementation(async () => ({ installations: [installation] }));
    await receipts.request();
    expect(h.snapshots.at(-1)?.supportsCatalogueChanges).toBe(false);
  } finally {
    receipts.dispose();
    h.controller.dispose();
  }
});

it("loads format 3 only after explicit negotiation and unloads it on downgrade", async () => {
  const h = harness();
  const streamed: ExtensionInstallation = {
    ...installation,
    package: { ...installation.package, format: 3, provides: [], requires: [], dependencies: [] },
  };
  h.setCatalog([streamed]);
  try {
    await h.controller.refresh();
    expect(h.options.client).not.toHaveBeenCalled();
    expect(h.snapshots.at(-1)?.error).toContain("does not support package format 3");
    h.options.list.mockImplementation(async () => ({
      installations: [streamed],
      supportedPackageFormats: [1, 2, 3],
      supportsApiStreams: true,
    }));
    await h.controller.refresh();
    expect(h.register).toHaveBeenCalledTimes(1);
    h.options.list.mockImplementation(async () => ({ installations: [streamed] }));
    await h.controller.refresh();
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.snapshots.at(-1)?.error).toContain("does not support package format 3");
  } finally {
    h.controller.dispose();
  }
});

it("never sends a stream RPC to an older host", async () => {
  const h = harness();
  try {
    await h.controller.refresh();
    const iteratorSource = h.getHost().subscribeApi(
      {
        id: "test.installed/events",
        versionRange: "^1.0.0",
        name: "changes",
        input: {},
        context,
      },
      new AbortController().signal,
    );
    const iterator = iteratorSource[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("unavailable");
    expect(h.options.subscribeApi).not.toHaveBeenCalled();
  } finally {
    h.controller.dispose();
  }
});

it("binds streams to installed identity and cancels a pending next on permission replacement", async () => {
  const h = harness();
  h.options.list.mockImplementation(async () => ({
    installations: [installation],
    supportsApiStreams: true,
    supportedPackageFormats: [1, 2, 3],
  }));
  let captured: AbortSignal | undefined;
  h.options.subscribeApi.mockImplementation((_id, _hash, _request, signal) => {
    captured = signal;
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<ApiStreamFrame>>((resolve) => {
              signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), {
                once: true,
              });
            }),
          return: async () => ({ done: true, value: undefined }),
        };
      },
    };
  });
  try {
    await h.controller.refresh();
    const request = {
      id: "test.installed/events",
      versionRange: "^1.0.0",
      name: "changes",
      input: {},
      context,
    };
    const iteratorSource = h.getHost().subscribeApi(request, new AbortController().signal);
    const iterator = iteratorSource[Symbol.asyncIterator]();
    const pending = iterator.next();
    const rejected = expect(pending).rejects.toThrow("expired");
    expect(h.options.subscribeApi).toHaveBeenCalledWith(
      installation.id,
      installation.contentHash,
      request,
      captured,
    );
    h.options.list.mockImplementation(async () => ({
      installations: [{ ...installation, grants: { capabilities: [], projectIds: [] } }],
      supportsApiStreams: true,
      supportedPackageFormats: [1, 2, 3],
    }));
    await h.controller.refresh();
    await rejected;
    expect(captured?.aborted).toBe(true);
  } finally {
    h.controller.dispose();
  }
});
it.each(["named", "selected API"] as const)(
  "reloads transitive %s dependents after provider replacement while retaining unrelated viewers",
  async (mode) => {
    const h = harness();
    const make = (id: string, dependencies: string[] = []): ExtensionInstallation => ({
      ...installation,
      id,
      package: {
        format: 3,
        manifest: { ...manifest, id },
        clientEntry: "client.mjs",
        serverEntry: "server.mjs",
        tools: [],
        dependencies:
          mode === "named"
            ? dependencies.map((pluginId) => ({ pluginId, versionRange: "^1.0.0", apis: [] }))
            : [],
        requires:
          mode === "selected API"
            ? dependencies.map((pluginId) => ({ id: pluginId + "/events", versionRange: "^1.0.0" }))
            : [],
        provides: [
          {
            id: id + "/events",
            version: "1.0.0",
            streams: [
              {
                name: "changes",
                inputSchema: { type: "object" },
                eventSchema: { type: "number" },
                requiredGrants: [],
              },
            ],
          },
        ],
      },
    });
    let entries = [
      make("trial.provider"),
      make("trial.bridge", ["trial.provider"]),
      make("trial.consumer", ["trial.bridge"]),
      make("trial.unrelated"),
    ];
    const hosts = new Map<string, ClientHost>();
    const stopped: string[] = [];
    const loaded: string[] = [];
    let streamAborted = false;
    const controller = createInstalledExtensionController({
      ...h.options,
      list: async () => ({
        installations: entries,
        supportedPackageFormats: [1, 2, 3],
        supportsApiStreams: true,
        apiResolution: entries.map((entry) => ({ id: entry.id + "/events", providerId: entry.id })),
      }),
      client: async (id, contentHash) => ({ code: id, contentHash }),
      load: async (id) => (host: ClientHost) => {
        hosts.set(id, host);
        return {
          manifest: entries.find((entry) => entry.id === id)!.package.manifest,
          surfaces: [],
        };
      },
      register: (extension) => {
        loaded.push(extension.manifest.id);
        return () => {
          stopped.push(extension.manifest.id);
        };
      },
      subscribeApi: (_id, _hash, _request, signal) => ({
        async *[Symbol.asyncIterator]() {
          try {
            yield { streamId: "fixture", sequence: 1, type: "snapshot", value: 1 };
            await new Promise<void>((resolve) =>
              signal.addEventListener(
                "abort",
                () => {
                  streamAborted = true;
                  resolve();
                },
                { once: true },
              ),
            );
          } finally {
            streamAborted = true;
          }
        },
      }),
    });
    try {
      await controller.refresh();
      expect(h.snapshots.at(-1)?.error).toBeNull();
      const old = hosts.get("trial.consumer")!;
      const request = {
        id: "trial.consumer/state",
        name: "changes",
        versionRange: "^1.0.0",
        input: {},
        context,
      };
      const subscription = old.subscribeApi(request, new AbortController().signal);
      const iterator = subscription[Symbol.asyncIterator]();
      expect((await iterator.next()).value?.value).toBe(1);
      const pending = iterator.next().then(
        () => "ended",
        () => "cancelled",
      );
      entries = entries.map((entry) =>
        entry.id === "trial.provider" ? { ...entry, contentHash: "b".repeat(64) } : entry,
      );
      await controller.refresh();
      await pending;
      expect(streamAborted).toBe(true);
      expect(stopped.sort()).toEqual(["trial.bridge", "trial.consumer", "trial.provider"]);
      expect(loaded.filter((id) => id === "trial.unrelated")).toHaveLength(1);
      expect(hosts.get("trial.consumer")).not.toBe(old);
      await expect(
        old.invokeApi(
          { id: request.id, method: "read", input: {}, versionRange: "^1.0.0", context },
          new AbortController().signal,
        ),
      ).rejects.toThrow("unavailable");
      await controller.refresh();
      expect(loaded).toHaveLength(7);
    } finally {
      controller.dispose();
    }
  },
);

it("rebinds open and newly activated tabs to an updated pack without a reload", async () => {
  const surface = {
    id: "test.pack/view",
    title: "Pack",
    scope: "project" as const,
    clients: ["web"],
    placements: ["side-panel" as const],
    capabilities: [],
    stateVersion: 1,
  };
  const packManifest = {
    id: "test.pack",
    version: "1.0.0",
    apiVersion: 1 as const,
    surfaces: [surface],
  };
  const pack = (hash: string): ExtensionInstallation => ({
    id: packManifest.id,
    contentHash: hash.repeat(64),
    enabled: true,
    grants: { capabilities: [], projectIds: [ProjectId.make("project-a")] },
    package: { format: 1, manifest: packManifest, clientEntry: "client.mjs", tools: [] },
  });
  let catalog = [pack("a")];
  const controller = createInstalledExtensionController({
    environmentId: "env-rebind",
    React,
    list: async () => ({ installations: catalog }),
    // The module body is the content hash, so the rendered view names the build it came from.
    client: async (_id, hash) => ({ code: hash.slice(0, 1), contentHash: hash }),
    load: async (build) => (_host: ClientHost) => ({
      manifest: packManifest,
      surfaces: [
        {
          id: surface.id,
          validateRestore: () => true,
          createView: () => ({ renderer: () => <span>{"build " + build}</span> }),
        },
      ],
    }),
    invoke: async () => null,
    register: (extension) =>
      registerWorkspaceExtension(extension, undefined, { environmentId: "env-rebind" }),
    changed: () => {},
  });
  // The persisted tab record carries no package identity; only the registry resolves it.
  const record: ViewRecord = {
    version: 1,
    surfaceId: surface.id,
    placement: "side-panel",
    stateVersion: 1,
    restoreState: null,
    fallback: "Pack is unavailable. Check environment extensions in Settings.",
    context: {
      client: "web",
      resource: {
        namespace: packManifest.id,
        id: surface.id,
        environmentId: "env-rebind",
        projectId: "project-a",
      },
    },
  };
  const text = (root: ReactTestRenderer) => JSON.stringify(root.toJSON());
  let open!: ReactTestRenderer;
  let activatedLater!: ReactTestRenderer;
  try {
    await act(async () => {
      await controller.refresh();
      open = create(<WorkspaceExtensionSurface record={record} visible />);
    });
    expect(text(open)).toContain("build a");

    catalog = [pack("b")];
    await act(async () => {
      await controller.refresh();
    });
    expect(text(open)).toContain("build b");
    expect(text(open)).not.toContain("unavailable");

    await act(async () => {
      activatedLater = create(<WorkspaceExtensionSurface record={record} visible />);
    });
    expect(text(activatedLater)).toContain("build b");
  } finally {
    await act(async () => {
      open?.unmount();
      activatedLater?.unmount();
      controller.dispose();
    });
  }
});
