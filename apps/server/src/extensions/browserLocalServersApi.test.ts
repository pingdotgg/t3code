import * as ProcessRunner from "../processRunner.ts";
import { expect, it } from "@effect/vitest";
import { ProjectId, type DiscoveredLocalServer } from "@t3tools/contracts";
import type { HostApiInvocationMetadata, HostApiRootAuthority } from "@t3tools/extension-runtime";
import { createExtensionRuntime } from "@t3tools/extension-runtime";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  createBrowserLocalServersApiProvider,
  projectBrowserLocalServers,
} from "./browserLocalServersApi.ts";

const candidate = (url = "http://localhost:5173/"): DiscoveredLocalServer => ({
  url,
  port: Number(new URL(url).port || 80),
  host: "localhost",
  pid: 9876,
  processName: "private-process",
  terminal: null,
});
function fixture() {
  const projectId = ProjectId.make("project-a");
  let cwd = "/workspace";
  let allowed = true;
  let retained = 0;
  let reads = 0;
  let listener: ((servers: readonly DiscoveredLocalServer[]) => Effect.Effect<void>) | undefined;
  let releaseNotice: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    releaseNotice = resolve;
  });
  const provider = createBrowserLocalServersApiProvider({
    environmentId: "env-a",
    projects: {
      getById: () =>
        Effect.sync(() => Option.some({ projectId, workspaceRoot: cwd, deletedAt: null })),
    },
    threads: { getById: () => Effect.succeedNone },
    discovery: {
      retain: Effect.acquireRelease(
        Effect.sync(() => {
          retained++;
        }),
        () =>
          Effect.sync(() => {
            retained--;
            releaseNotice?.();
          }),
      ),
      scan: (urls) =>
        Effect.sync(() => {
          expect(urls).toEqual([]);
          reads++;
          return [candidate()];
        }),
      subscribe: (input, next) =>
        Effect.gen(function* () {
          expect(input.configuredUrls).toEqual([]);
          listener = next;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              listener = undefined;
            }),
          );
        }),
    },
  });
  const context: ViewContext = {
    client: "web",
    workspaceRevision: JSON.stringify(["/workspace", null]),
    resource: {
      namespace: "example.browser-local-servers",
      id: "view",
      environmentId: "env-a",
      projectId,
    },
  };
  const metadata: HostApiInvocationMetadata = {
    callId: "call",
    callerId: "consumer",
    rootCallerId: "consumer",
    providerId: provider.providerId,
    providerGeneration: 1,
    callerGenerations: [],
    principal: {
      kind: "environment-session",
      id: "session",
      environmentId: "env-a",
      scopes: ["orchestration:read"],
    },
    assertAuthority: async () => {
      if (!allowed) throw new Error("revoked");
    },
  };
  const controller = new AbortController();
  return {
    provider,
    context,
    metadata,
    controller,
    released,
    stream: () =>
      provider.subscribe!("subscribe", {}, context, controller.signal, metadata)[
        Symbol.asyncIterator
      ](),
    emit: (servers: readonly DiscoveredLocalServer[]) => {
      if (!listener) throw new Error("not subscribed");
      return listener(servers);
    },
    reads: () => reads,
    retained: () => retained,
    revoke: () => {
      allowed = false;
    },
    move: () => {
      cwd = "/other";
    },
  };
}
it("filters private/credential/path/non-loopback values, deduplicates, orders and bounds output", () => {
  const entries = [
    candidate("http://localhost:6000/"),
    candidate(),
    candidate(),
    candidate("http://user:secret@localhost:5174/"),
    candidate("http://localhost:5175/private?token=secret"),
    candidate("https://example.com:5176/"),
    ...Array.from({ length: 70 }, (_, i) => candidate("http://127.0.0.1:" + (7000 + i) + "/")),
  ];
  const result = projectBrowserLocalServers(entries);
  expect(result.servers).toHaveLength(64);
  expect(result.servers[0]).toEqual({ url: "http://localhost:5173/", port: 5173 });
  expect(result.truncated).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/private|secret|pid|processName|terminal/);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64 * 1024);
  expect(projectBrowserLocalServers([])).toEqual({
    kind: "snapshot",
    scope: "environment",
    servers: [],
    truncated: false,
  });
});

it.effect("streams initial and replacement snapshots and releases native retention on return", () =>
  Effect.gen(function* () {
    const f = fixture(),
      stream = f.stream();
    expect((yield* Effect.promise(() => stream.next())).value?.value).toEqual(
      projectBrowserLocalServers([candidate()]),
    );
    yield* f.emit([]);
    expect((yield* Effect.promise(() => stream.next())).value?.value).toEqual(
      projectBrowserLocalServers([]),
    );
    yield* Effect.promise(() => stream.return!());
    yield* Effect.promise(() => f.released);
    expect(f.retained()).toBe(0);
  }),
);
for (const action of ["revoke", "move"] as const) {
  it.effect("rechecks " + action + " before delivery and releases the scanner", () =>
    Effect.gen(function* () {
      const f = fixture(),
        stream = f.stream();
      yield* Effect.promise(() => stream.next());
      f[action]();
      yield* f.emit([]);
      yield* Effect.promise(() => expect(stream.next()).rejects.toThrow());
      yield* Effect.promise(() => f.released);
      expect(f.retained()).toBe(0);
    }),
  );
}
it.effect("aborts while waiting for a native update without a timer or leaked retention", () =>
  Effect.gen(function* () {
    const f = fixture(),
      stream = f.stream();
    yield* Effect.promise(() => stream.next());
    const pending = stream.next();
    f.controller.abort();
    yield* Effect.promise(() => expect(pending).rejects.toThrow());
    yield* Effect.promise(() => f.released);
    expect(f.retained()).toBe(0);
  }),
);
it.effect(
  "rejects probing inputs, cursors, foreign principals and stale scope before scanning",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const { assertAuthority: _assertAuthority, ...withoutAuthority } = f.metadata;
      expect(() =>
        f.provider.subscribe!(
          "subscribe",
          { configuredUrls: ["http://localhost:1/"] },
          f.context,
          f.controller.signal,
          f.metadata,
        ),
      ).toThrow("Invalid");
      expect(() =>
        f.provider.subscribe!(
          "subscribe",
          {},
          f.context,
          f.controller.signal,
          f.metadata,
          "cursor",
        ),
      ).toThrow("resume");
      expect(() =>
        f.provider.subscribe!("subscribe", {}, f.context, f.controller.signal, {
          ...f.metadata,
          principal: { ...f.metadata.principal!, environmentId: "foreign" },
        }),
      ).toThrow("authority");
      expect(() =>
        f.provider.subscribe!("subscribe", {}, f.context, f.controller.signal, withoutAuthority),
      ).toThrow("authority");
      f.move();
      yield* Effect.promise(() => expect(f.stream().next()).rejects.toThrow());
      expect(f.reads()).toBe(0);
    }),
);
it.effect("revoked authority and pre-aborted streams never start discovery", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.revoke();
    yield* Effect.promise(() => expect(f.stream().next()).rejects.toThrow("revoked"));
    const aborted = fixture();
    aborted.controller.abort();
    yield* Effect.promise(() => expect(aborted.stream().next()).rejects.toThrow());
    expect(f.reads() + aborted.reads()).toBe(0);
  }),
);
it.effect(
  "installed packed consumer reaches the real adapter through public broker APIs and denies a missing grant",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.ProcessRunner;
      const built = yield* runner.run({
        command: "node",
        args: [
          path.resolve("../../packages/extension-sdk/bin/t3-extension.mjs"),
          "build",
          path.resolve("../../packages/extension-sdk/examples/browser-local-servers"),
        ],
      });
      expect(built.code, built.stderr).toBe(0);
      const temp = yield* fs.makeTempDirectoryScoped({
        prefix: "browser-local-servers-installed-",
      });
      const rootDir = yield* fs.realPath(temp);
      const runtime = yield* Effect.promise(() =>
        createExtensionRuntime({
          rootDir,
          environmentId: "env-a",
          services: [],
          apiProviders: [f.provider],
          authorize: (installation, grant, context) =>
            installation.grants.capabilities.includes(grant) &&
            installation.grants.projectIds.includes(context.resource.projectId ?? ""),
        }),
      );
      try {
        const source = path.resolve(
          "../../packages/extension-sdk/examples/browser-local-servers/.t3-extension",
        );
        const grants = {
          capabilities: ["t3.browser/read-local-servers"],
          projectIds: ["project-a"],
        };
        const installed = yield* Effect.promise(() => runtime.install(source, grants));
        const root: HostApiRootAuthority = {
          principal: f.metadata.principal!,
          allowWrite: false,
          revalidate: () => {},
        };
        const request = {
          id: "example.browser-local-servers/read",
          versionRange: "^1.0.0",
          name: "subscribe",
          input: {},
          context: f.context,
        };
        const sourceStream = runtime.subscribeApi(
          installed.id,
          installed.contentHash,
          request,
          f.controller.signal,
          root,
        );
        const stream = sourceStream[Symbol.asyncIterator]();
        expect((yield* Effect.promise(() => stream.next())).value?.value).toEqual(
          projectBrowserLocalServers([candidate()]),
        );
        yield* f.emit([]);
        expect((yield* Effect.promise(() => stream.next())).value?.value).toEqual(
          projectBrowserLocalServers([]),
        );
        yield* Effect.promise(() => stream.return!());
        yield* Effect.promise(() => f.released);
        expect(f.retained()).toBe(0);
        yield* Effect.promise(() =>
          runtime.updateGrants(installed.id, { ...grants, capabilities: [] }),
        );
        const deniedSource = runtime.subscribeApi(
          installed.id,
          installed.contentHash,
          request,
          f.controller.signal,
          root,
        );
        const denied = deniedSource[Symbol.asyncIterator]();
        yield* Effect.promise(() =>
          expect(denied.next()).rejects.toThrow(/grant|denied|authorized/i),
        );
        expect(f.reads()).toBe(1);
      } finally {
        yield* Effect.promise(() => runtime.dispose());
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
);

it.effect("coalesces undelivered native snapshots to the latest bounded result", () =>
  Effect.gen(function* () {
    const f = fixture(),
      stream = f.stream();
    yield* Effect.promise(() => stream.next());
    for (let port = 8000; port < 8100; port++) {
      yield* f.emit([candidate("http://localhost:" + port + "/")]);
    }
    expect((yield* Effect.promise(() => stream.next())).value?.value).toEqual(
      projectBrowserLocalServers([candidate("http://localhost:8099/")]),
    );
    yield* Effect.promise(() => stream.return!());
    yield* Effect.promise(() => f.released);
    expect(() => f.emit([])).toThrow("not subscribed");
  }),
);
