import {
  AuthTerminalOperateScope,
  ProjectId,
  ThreadId,
  type TerminalSummary,
} from "@t3tools/contracts";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import { createTerminalApiProvider } from "./terminalApi.ts";
import { extensionWorkspaceRevision } from "@t3tools/contracts";

const context = {
  resource: {
    namespace: "test.extension",
    id: "surface",
    environmentId: "env",
    projectId: "project",
    threadId: "thread",
  },
  client: "test",
  workspaceRevision: extensionWorkspaceRevision("/workspace", null),
} as const;
const makeDeps = (
  inspect: (input: {
    threadId: string;
    terminalId: string;
  }) => Effect.Effect<TerminalSummary | null, never>,
) => ({
  environmentId: "env",
  projects: {
    getById: (input: { projectId: ProjectId }) =>
      Effect.succeed(
        Option.some({ projectId: input.projectId, workspaceRoot: "/workspace", deletedAt: null }),
      ),
  },
  threads: {
    getById: (_input: { threadId: ThreadId }) =>
      Effect.succeed(
        Option.some({ projectId: ProjectId.make("project"), worktreePath: null, deletedAt: null }),
      ),
  },
  terminal: {
    inspect,
    subscribeMetadata: () => Effect.die("unused metadata stream"),
  },
});
const deps = makeDeps(() => Effect.die("native inspect must not run"));
const authority = {
  kind: "environment-session" as const,
  id: "session",
  environmentId: "env",
  scopes: [AuthTerminalOperateScope],
};
const signal = new AbortController().signal;

it("requires terminal authority before native inspection", async () => {
  const provider = createTerminalApiProvider(deps);
  await expect(
    provider.invoke("inspect", { terminalId: "term-1" }, context, signal, {
      callId: "call",
      rootCallerId: "root",
      callerId: "caller",
      providerId: provider.providerId,
      providerGeneration: 1,
      callerGenerations: [],
    }),
  ).rejects.toThrow("Terminal authority");
});

it("rejects unknown inspection input fields", async () => {
  const provider = createTerminalApiProvider(deps);
  await expect(
    provider.invoke("inspect", { terminalId: "term-1", cwd: "/secret" }, context, signal, {
      callId: "call",
      rootCallerId: "root",
      callerId: "caller",
      providerId: provider.providerId,
      providerGeneration: 1,
      callerGenerations: [],
      principal: authority,
    }),
  ).rejects.toThrow("Invalid terminal inspection request");
});

it("returns null only for a genuinely missing session", async () => {
  const provider = createTerminalApiProvider(makeDeps(() => Effect.succeed(null)));
  await expect(
    provider.invoke("inspect", { terminalId: "term-1" }, context, signal, {
      callId: "call",
      rootCallerId: "root",
      callerId: "caller",
      providerId: provider.providerId,
      providerGeneration: 1,
      callerGenerations: [],
      principal: authority,
    }),
  ).resolves.toBeNull();
});

it("rejects native identity and workspace mismatches", async () => {
  const provider = createTerminalApiProvider(
    makeDeps(() =>
      Effect.succeed({
        threadId: "other",
        terminalId: "term-1",
        cwd: "/wrong",
        worktreePath: "/wrong",
        status: "running",
        pid: 1,
        hasRunningSubprocess: false,
        label: "x",
        exitCode: null,
        exitSignal: null,
        updatedAt: "2026-01-01",
      }),
    ),
  );
  await expect(
    provider.invoke("inspect", { terminalId: "term-1" }, context, signal, {
      callId: "call",
      rootCallerId: "root",
      callerId: "caller",
      providerId: provider.providerId,
      providerGeneration: 1,
      callerGenerations: [],
      principal: authority,
    }),
  ).rejects.toThrow("unavailable");
});

it("rejects oversized native metadata and bounds native failures", async () => {
  const oversized = createTerminalApiProvider(
    makeDeps(() =>
      Effect.succeed({
        threadId: "thread",
        terminalId: "term-1",
        cwd: "/workspace",
        worktreePath: null,
        status: "running",
        pid: 1,
        hasRunningSubprocess: false,
        label: "x".repeat(129),
        exitCode: null,
        exitSignal: null,
        updatedAt: "ok",
      }),
    ),
  );
  const root = {
    callId: "call",
    rootCallerId: "root",
    callerId: "caller",
    providerId: oversized.providerId,
    providerGeneration: 1,
    callerGenerations: [],
    principal: authority,
  };
  await expect(
    oversized.invoke("inspect", { terminalId: "term-1" }, context, signal, root),
  ).rejects.toThrow("bounds");
  const failed = createTerminalApiProvider(makeDeps(() => Effect.die("/secret/cwd/pty")));
  await expect(
    failed.invoke("inspect", { terminalId: "term-1" }, context, signal, {
      ...root,
      providerId: failed.providerId,
    }),
  ).rejects.toThrow("cannot be inspected");
});

it.effect("cancels a pending native inspection and runs cleanup", () =>
  Effect.gen(function* () {
    const cleaned = yield* Deferred.make<"cleaned">();
    const acquired = yield* Deferred.make<"acquired">();
    const provider = createTerminalApiProvider(
      makeDeps(() =>
        Effect.acquireUseRelease(
          Effect.succeed(undefined).pipe(Effect.tap(() => Deferred.succeed(acquired, "acquired"))),
          () => Effect.never,
          () => Deferred.succeed(cleaned, "cleaned"),
        ),
      ),
    );
    const controller = new AbortController();
    const pending = provider.invoke(
      "inspect",
      { terminalId: "term-1" },
      context,
      controller.signal,
      {
        callId: "call",
        rootCallerId: "root",
        callerId: "caller",
        providerId: provider.providerId,
        providerGeneration: 1,
        callerGenerations: [],
        principal: authority,
      },
    );
    yield* Deferred.await(acquired);
    controller.abort();
    yield* Effect.promise(() => expect(pending).rejects.toBeDefined());
    expect(yield* Deferred.await(cleaned)).toBe("cleaned");
  }),
);

it("rejects wrong environment and missing thread before native access", async () => {
  let reads = 0;
  const provider = createTerminalApiProvider(
    makeDeps(() => {
      reads++;
      return Effect.succeed(null);
    }),
  );
  const root = {
    callId: "call",
    rootCallerId: "root",
    callerId: "caller",
    providerId: provider.providerId,
    providerGeneration: 1,
    callerGenerations: [],
    principal: authority,
  };
  await expect(
    provider.invoke("inspect", { terminalId: "term-1" }, context, signal, {
      ...root,
      principal: { ...authority, environmentId: "other" },
    }),
  ).rejects.toThrow("authority");
  await expect(
    provider.invoke(
      "inspect",
      { terminalId: "term-1" },
      {
        ...context,
        resource: {
          namespace: "test.extension",
          id: "surface",
          environmentId: "env",
          projectId: "project",
        },
      },
      signal,
      root,
    ),
  ).rejects.toThrow("thread");
  expect(reads).toBe(0);
});

it("rejects a thread/project mismatch before native access", async () => {
  let reads = 0;
  const provider = createTerminalApiProvider(
    makeDeps(() => {
      reads++;
      return Effect.succeed(null);
    }),
  );
  await expect(
    provider.invoke(
      "inspect",
      { terminalId: "term-1" },
      {
        ...context,
        resource: { ...context.resource, projectId: "other" },
      },
      signal,
      {
        callId: "call",
        rootCallerId: "root",
        callerId: "caller",
        providerId: provider.providerId,
        providerGeneration: 1,
        callerGenerations: [],
        principal: authority,
      },
    ),
  ).rejects.toBeDefined();
  expect(reads).toBe(0);
});

it("rejects each native identity field mismatch independently", async () => {
  const base = {
    threadId: "thread",
    terminalId: "term-1",
    cwd: "/workspace",
    worktreePath: null,
    status: "running" as const,
    pid: 1,
    hasRunningSubprocess: false,
    label: "x",
    exitCode: null,
    exitSignal: null,
    updatedAt: "ok",
  };
  for (const [field, value] of [
    ["threadId", "other"],
    ["terminalId", "other"],
    ["cwd", "/other"],
    ["worktreePath", "/other"],
  ] as const) {
    const provider = createTerminalApiProvider(
      makeDeps(() => Effect.succeed({ ...base, [field]: value } as TerminalSummary)),
    );
    await expect(
      provider.invoke("inspect", { terminalId: "term-1" }, context, signal, {
        callId: "call",
        rootCallerId: "root",
        callerId: "caller",
        providerId: provider.providerId,
        providerGeneration: 1,
        callerGenerations: [],
        principal: authority,
      }),
    ).rejects.toThrow("unavailable");
  }
});

it("revalidates workspace scope after native inspection", async () => {
  let projectReads = 0;
  const deps = makeDeps(() =>
    Effect.succeed({
      threadId: "thread",
      terminalId: "term-1",
      cwd: "/workspace",
      worktreePath: null,
      status: "running",
      pid: 1,
      hasRunningSubprocess: false,
      label: "x",
      exitCode: null,
      exitSignal: null,
      updatedAt: "ok",
    }),
  );
  const provider = createTerminalApiProvider({
    ...deps,
    projects: {
      getById: (input: { projectId: ProjectId }) =>
        Effect.succeed(
          Option.some({
            projectId: input.projectId,
            workspaceRoot: ++projectReads === 1 ? "/workspace" : "/moved",
            deletedAt: null,
          }),
        ),
    },
  });
  await expect(
    provider.invoke("inspect", { terminalId: "term-1" }, context, signal, {
      callId: "call",
      rootCallerId: "root",
      callerId: "caller",
      providerId: provider.providerId,
      providerGeneration: 1,
      callerGenerations: [],
      principal: authority,
    }),
  ).rejects.toThrow("stale");
});

it("projects valid native metadata to exactly the public fields", async () => {
  const provider = createTerminalApiProvider(
    makeDeps(() =>
      Effect.succeed({
        threadId: "thread",
        terminalId: "term-1",
        cwd: "/workspace",
        worktreePath: null,
        status: "exited",
        pid: 321,
        hasRunningSubprocess: false,
        label: "shell",
        exitCode: 7,
        exitSignal: null,
        updatedAt: "2026-09-10T00:00:00Z",
      }),
    ),
  );
  await expect(
    provider.invoke("inspect", { terminalId: "term-1" }, context, signal, {
      callId: "call",
      rootCallerId: "root",
      callerId: "caller",
      providerId: provider.providerId,
      providerGeneration: 1,
      callerGenerations: [],
      principal: authority,
    }),
  ).resolves.toEqual({
    terminalId: "term-1",
    status: "exited",
    label: "shell",
    hasRunningSubprocess: false,
    exitCode: 7,
    exitSignal: null,
    updatedAt: "2026-09-10T00:00:00Z",
  });
});

/* ------------------------- list stream ------------------------- */

const summary = (terminalId: string, extra: Partial<TerminalSummary> = {}): TerminalSummary => ({
  threadId: "thread",
  terminalId,
  cwd: "/workspace",
  worktreePath: null,
  status: "running",
  pid: 10,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: false,
  label: "",
  updatedAt: "2026-09-12T00:00:00Z",
  ...extra,
});

type MetadataListener = (
  event: import("@t3tools/contracts").TerminalMetadataStreamEvent,
) => Effect.Effect<void>;
const metadataDeps = (emit: { current: MetadataListener | null }) => ({
  environmentId: "env",
  projects: {
    getById: (input: { projectId: ProjectId }) =>
      Effect.succeed(
        Option.some({ projectId: input.projectId, workspaceRoot: "/workspace", deletedAt: null }),
      ),
  },
  threads: {
    getById: (_input: { threadId: ThreadId }) =>
      Effect.succeed(
        Option.some({ projectId: ProjectId.make("project"), worktreePath: null, deletedAt: null }),
      ),
  },
  terminal: {
    inspect: () => Effect.die("unused inspect"),
    subscribeMetadata: (listener: MetadataListener) => {
      emit.current = listener;
      return Effect.succeed(() => {});
    },
  },
});
const metadata = (provider: { providerId: string }, scopes = [AuthTerminalOperateScope]) => ({
  callId: "call",
  rootCallerId: "root",
  callerId: "caller",
  providerId: provider.providerId,
  providerGeneration: 1,
  callerGenerations: [],
  principal: { ...authority, scopes },
});

it("denies the list stream without terminal authority", () => {
  const provider = createTerminalApiProvider(metadataDeps({ current: null }));
  expect(() =>
    provider.subscribe!("list", {}, context, signal, {
      callId: "call",
      rootCallerId: "root",
      callerId: "caller",
      providerId: provider.providerId,
      providerGeneration: 1,
      callerGenerations: [],
    }),
  ).toThrow("authority");
});

it("rejects an unknown stream name, input fields, and resume cursors", () => {
  const provider = createTerminalApiProvider(metadataDeps({ current: null }));
  const meta = metadata(provider);
  expect(() => provider.subscribe!("peek", {}, context, signal, meta)).toThrow("unavailable");
  expect(() => provider.subscribe!("list", { terminalId: "x" }, context, signal, meta)).toThrow(
    "Invalid",
  );
  expect(() => provider.subscribe!("list", {}, context, signal, meta, "cursor")).toThrow("resume");
});

const nextTick = (times = 50) =>
  Effect.promise(async () => {
    for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
  });

it.effect("serves an in-scope snapshot then upsert/remove rows, filtering foreign scopes", () =>
  Effect.gen(function* () {
    const emit: { current: MetadataListener | null } = { current: null };
    const provider = createTerminalApiProvider(metadataDeps(emit));
    const iterable = provider.subscribe!("list", {}, context, signal, metadata(provider));
    const iterator = iterable[Symbol.asyncIterator]();

    const first = iterator.next();
    // Emit the native snapshot once the subscription is wired.
    for (let i = 0; i < 50 && emit.current === null; i += 1) yield* nextTick(1);
    expect(emit.current).not.toBeNull();
    yield* emit.current!({
      type: "snapshot",
      terminals: [
        summary("term-1", { label: "zsh" }),
        summary("other-thread", { threadId: "other" }),
        summary("other-cwd", { cwd: "/elsewhere" }),
      ],
    });
    const snapshotFrame = yield* Effect.promise(() => first);
    expect(snapshotFrame.done).toBe(false);
    expect(snapshotFrame.value).toEqual({
      type: "snapshot",
      value: {
        kind: "snapshot",
        terminals: [
          {
            terminalId: "term-1",
            status: "running",
            label: "zsh",
            hasRunningSubprocess: false,
            exitCode: null,
            exitSignal: null,
            updatedAt: "2026-09-12T00:00:00Z",
          },
        ],
      },
    });

    const upsertFrame = iterator.next();
    yield* emit.current!({ type: "upsert", terminal: summary("other", { threadId: "other" }) });
    yield* emit.current!({ type: "upsert", terminal: summary("term-2") });
    expect((yield* Effect.promise(() => upsertFrame)).value).toEqual({
      type: "data",
      value: {
        kind: "upsert",
        terminal: {
          terminalId: "term-2",
          status: "running",
          label: "",
          hasRunningSubprocess: false,
          exitCode: null,
          exitSignal: null,
          updatedAt: "2026-09-12T00:00:00Z",
        },
      },
    });

    const removeFrame = iterator.next();
    yield* emit.current!({ type: "remove", threadId: "other", terminalId: "ignored" });
    yield* emit.current!({ type: "remove", threadId: "thread", terminalId: "term-1" });
    expect((yield* Effect.promise(() => removeFrame)).value).toEqual({
      type: "data",
      value: { kind: "remove", terminalId: "term-1" },
    });
    yield* Effect.promise(async () => {
      await iterator.return?.(undefined);
    });
  }),
);

it.effect("closes the list stream on oversized metadata and on >128 snapshots", () =>
  Effect.gen(function* () {
    const emit: { current: MetadataListener | null } = { current: null };
    const provider = createTerminalApiProvider(metadataDeps(emit));
    const iterator = provider.subscribe!("list", {}, context, signal, metadata(provider))[
      Symbol.asyncIterator
    ]();
    const first = iterator.next();
    for (let i = 0; i < 50 && emit.current === null; i += 1) yield* nextTick(1);
    yield* emit.current!({
      type: "snapshot",
      terminals: [summary("term-1", { label: "x".repeat(129) })],
    });
    expect((yield* Effect.promise(() => first)).value).toEqual({
      type: "closed",
      value: { kind: "closed", reason: "terminal-error" },
    });
    expect((yield* Effect.promise(() => iterator.next())).done).toBe(true);

    const emit2: { current: MetadataListener | null } = { current: null };
    const provider2 = createTerminalApiProvider(metadataDeps(emit2));
    const iterator2 = provider2.subscribe!("list", {}, context, signal, metadata(provider2))[
      Symbol.asyncIterator
    ]();
    const first2 = iterator2.next();
    for (let i = 0; i < 50 && emit2.current === null; i += 1) yield* nextTick(1);
    yield* emit2.current!({
      type: "snapshot",
      terminals: Array.from({ length: 129 }, (_, i) => summary(`term-${i}`)),
    });
    expect((yield* Effect.promise(() => first2)).value).toEqual({
      type: "closed",
      value: { kind: "closed", reason: "overflow" },
    });
    expect((yield* Effect.promise(() => iterator2.next())).done).toBe(true);
  }),
);
