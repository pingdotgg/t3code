import {
  AuthTerminalOperateScope,
  ProjectId,
  ThreadId,
  extensionWorkspaceRevision,
} from "@t3tools/contracts";
import type { HostApiInvocationMetadata } from "@t3tools/extension-runtime";
import type { TerminalOutputSnapshot } from "../terminal/Manager.ts";
import { it, expect } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { createTerminalOutputApiProvider } from "./terminalOutputApi.ts";

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
const authority = {
  kind: "environment-session" as const,
  id: "session",
  environmentId: "env",
  scopes: [AuthTerminalOperateScope],
};
const metadata: HostApiInvocationMetadata = {
  callId: "call",
  rootCallerId: "root",
  callerId: "caller",
  providerId: "t3.host-terminal-output",
  providerGeneration: 1,
  callerGenerations: [],
  principal: authority,
};
const base: TerminalOutputSnapshot = {
  threadId: "thread",
  terminalId: "term-1",
  cwd: "/workspace",
  worktreePath: null,
  status: "running",
  contents: "hello",
  retainedByteLength: 5,
  truncated: false,
};
const input = { terminalId: "term-1" };
const signal = new AbortController().signal;
function fixture(read: () => Effect.Effect<TerminalOutputSnapshot | null, never>) {
  let workspaceRoot = "/workspace";
  let reads = 0;
  const provider = createTerminalOutputApiProvider({
    environmentId: "env",
    projects: {
      getById: (input: { projectId: ProjectId }) =>
        Effect.sync(() =>
          Option.some({ projectId: input.projectId, workspaceRoot, deletedAt: null }),
        ),
    },
    threads: {
      getById: (_input: { threadId: ThreadId }) =>
        Effect.succeed(
          Option.some({
            projectId: ProjectId.make("project"),
            worktreePath: null,
            deletedAt: null,
          }),
        ),
    },
    terminal: {
      readOutput: (value) => {
        expect(value).toEqual({ threadId: "thread", terminalId: "term-1" });
        reads++;
        return read();
      },
    },
  });
  return {
    provider,
    reads: () => reads,
    moveWorkspace: () => {
      workspaceRoot = "/moved";
    },
  };
}

it("projects only public output fields, distinguishing empty retained history and absent session", async () => {
  for (const output of [base, { ...base, contents: "", retainedByteLength: 0 }, null]) {
    const f = fixture(() => Effect.succeed(output));
    expect(f.provider.requiresRootAuthority).toBe(true);
    const value = await f.provider.invoke("readSnapshot", input, context, signal, metadata);
    expect(value).toEqual(
      output === null
        ? null
        : {
            terminalId: output.terminalId,
            contents: output.contents,
            retainedByteLength: output.retainedByteLength,
            truncated: output.truncated,
          },
    );
    expect(f.reads()).toBe(1);
  }
});

it("requires authenticated terminal domain authority before any native read", async () => {
  const f = fixture(() => Effect.succeed(base));
  for (const principal of [
    undefined,
    { ...authority, scopes: [] },
    { ...authority, environmentId: "other" },
  ]) {
    const { principal: _principal, ...withoutPrincipal } = metadata;
    await expect(
      f.provider.invoke("readSnapshot", input, context, signal, {
        ...withoutPrincipal,
        ...(principal ? { principal } : {}),
      }),
    ).rejects.toThrow("Terminal authority");
  }
  expect(f.reads()).toBe(0);
});

it("rejects input/control requests and invalid thread/project/environment scope before native reads", async () => {
  const f = fixture(() => Effect.succeed(base));
  await expect(f.provider.invoke("restart", input, context, signal, metadata)).rejects.toThrow(
    "unavailable",
  );
  for (const request of [
    { ...input, cwd: "/secret" },
    { terminalId: "" },
    { terminalId: "x".repeat(129) },
  ]) {
    await expect(
      f.provider.invoke("readSnapshot", request, context, signal, metadata),
    ).rejects.toThrow("Invalid");
  }
  const { threadId: _thread, ...noThread } = context.resource;
  for (const resource of [
    noThread,
    { ...context.resource, projectId: "other" },
    { ...context.resource, environmentId: "other" },
  ]) {
    await expect(
      f.provider.invoke("readSnapshot", input, { ...context, resource }, signal, metadata),
    ).rejects.toBeDefined();
  }
  expect(f.reads()).toBe(0);
});

it("rejects each native thread, terminal and workspace mapping mismatch", async () => {
  for (const mismatch of [
    { threadId: "other" },
    { terminalId: "other" },
    { cwd: "/other" },
    { worktreePath: "/other" },
  ]) {
    const f = fixture(() => Effect.succeed({ ...base, ...mismatch }));
    await expect(
      f.provider.invoke("readSnapshot", input, context, signal, metadata),
    ).rejects.toThrow("unavailable");
  }
});

it("rejects oversized or inconsistent native byte accounting without truncating errors into success", async () => {
  for (const invalid of [
    { contents: "x".repeat(8193), retainedByteLength: 8193 },
    { contents: "雪".repeat(3000), retainedByteLength: 9000 },
    { retainedByteLength: -1 },
    { retainedByteLength: Number.MAX_SAFE_INTEGER + 1 },
    { retainedByteLength: 4 },
    { retainedByteLength: 6 },
    { truncated: true },
  ]) {
    const f = fixture(() => Effect.succeed({ ...base, ...invalid }));
    await expect(
      f.provider.invoke("readSnapshot", input, context, signal, metadata),
    ).rejects.toThrow("bounds");
  }
});

it("keeps worst-case JSON escaping bounded and preserves valid tail accounting", async () => {
  const contents = String.fromCharCode(1).repeat(8192);
  const f = fixture(() =>
    Effect.succeed({ ...base, contents, retainedByteLength: 9000, truncated: true }),
  );
  const result = await f.provider.invoke("readSnapshot", input, context, signal, metadata);
  expect(result).toEqual({
    terminalId: "term-1",
    contents,
    retainedByteLength: 9000,
    truncated: true,
  });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(65536);
});

it("sanitizes native failures", async () => {
  const f = fixture(() => Effect.die("/secret/cwd/private-pty"));
  await expect(f.provider.invoke("readSnapshot", input, context, signal, metadata)).rejects.toThrow(
    "Terminal output cannot be inspected.",
  );
});

it("rejects a workspace moved by the native read before admitting its result", async () => {
  const f = fixture(() =>
    Effect.sync(() => {
      f.moveWorkspace();
      return base;
    }),
  );
  await expect(f.provider.invoke("readSnapshot", input, context, signal, metadata)).rejects.toThrow(
    "stale",
  );
  expect(f.reads()).toBe(1);
});

it("does not read after caller cancellation", async () => {
  const f = fixture(() => Effect.succeed(base));
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.provider.invoke("readSnapshot", input, context, controller.signal, metadata),
  ).rejects.toBeDefined();
  expect(f.reads()).toBe(0);
});

it.effect("cancels an acquired native read and waits for actual cleanup", () =>
  Effect.gen(function* () {
    const acquired = yield* Deferred.make<void>();
    const cleaned = yield* Deferred.make<void>();
    const f = fixture(() =>
      Effect.acquireUseRelease(
        Deferred.succeed(acquired, undefined),
        () => Effect.never,
        () => Deferred.succeed(cleaned, undefined),
      ),
    );
    const controller = new AbortController();
    const pending = f.provider.invoke("readSnapshot", input, context, controller.signal, metadata);
    yield* Deferred.await(acquired);
    controller.abort();
    yield* Effect.promise(() => expect(pending).rejects.toBeDefined());
    yield* Deferred.await(cleaned);
    expect(f.reads()).toBe(1);
  }),
);
