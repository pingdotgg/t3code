import type { WorkspaceTreeEvent } from "@t3tools/extension-sdk/catalogue";
import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import type { HostApiInvocationMetadata } from "@t3tools/extension-runtime";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { createWorkspaceTreeApiProvider } from "./workspaceTreeApi.ts";

function fixture(count = 450) {
  const projectId = ProjectId.make("project-a");
  let cwd = "/workspace";
  let allowed = true;
  let calls = 0;
  const entries = Array.from({ length: count }, (_, i) => ({
    path: "nested/file-" + i + ".txt",
    kind: "file" as const,
  }));
  const provider = createWorkspaceTreeApiProvider({
    environmentId: "env-a",
    projects: {
      getById: () =>
        Effect.sync(() => Option.some({ projectId, workspaceRoot: cwd, deletedAt: null })),
    },
    threads: { getById: () => Effect.succeedNone },
    entries: {
      list: (input) =>
        Effect.sync(() => {
          expect(input.cwd).toBe("/workspace");
          calls++;
          return { entries, truncated: false };
        }),
    },
  });
  const context: ViewContext = {
    client: "web",
    workspaceRevision: JSON.stringify(["/workspace", null]),
    resource: { namespace: "test.tree", id: "tree", environmentId: "env-a", projectId },
  };
  const metadata: HostApiInvocationMetadata = {
    callId: "call",
    callerId: "test.tree",
    rootCallerId: "test.tree",
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
    entries,
    metadata,
    controller,
    provider,
    context,
    stream: () =>
      provider.subscribe!("snapshot", {}, context, controller.signal, metadata)[
        Symbol.asyncIterator
      ](),
    move: () => {
      cwd = "/other";
    },
    revoke: () => {
      allowed = false;
    },
    calls: () => calls,
  };
}
it("delivers the native ordered index once, in bounded chunks, then an exact completion receipt", async () => {
  const f = fixture();
  const stream = f.stream();
  const received = [];
  let complete;
  for (;;) {
    const next = await stream.next();
    if (next.done) break;
    const value = next.value.value as WorkspaceTreeEvent;
    expect(Buffer.byteLength(JSON.stringify(next.value))).toBeLessThan(64 * 1024);
    if (value.kind === "chunk") received.push(...(value.entries as unknown[]));
    else complete = value;
  }
  expect(received).toEqual(f.entries);
  expect(complete).toEqual({ kind: "complete", entryCount: 450, truncated: false });
  expect(f.calls()).toBe(1);
});
it("returns a complete empty index", async () => {
  const f = fixture(0),
    stream = f.stream();
  expect((await stream.next()).value?.value).toEqual({
    kind: "complete",
    entryCount: 0,
    truncated: false,
  });
  expect((await stream.next()).done).toBe(true);
});
it.each(["revoke", "move", "abort"] as const)(
  "never completes a stale snapshot after %s",
  async (action) => {
    const f = fixture(),
      stream = f.stream();
    expect((await stream.next()).done).toBe(false);
    if (action === "abort") f.controller.abort();
    else f[action]();
    await expect(stream.next()).rejects.toThrow();
  },
);
it("rejects caller cwd, resume and missing root permission before reading", () => {
  const f = fixture();
  expect(() =>
    f.provider.subscribe!(
      "snapshot",
      { cwd: "/other" },
      f.context,
      f.controller.signal,
      f.metadata,
    ),
  ).toThrow("Invalid");
  expect(() =>
    f.provider.subscribe!("snapshot", {}, f.context, f.controller.signal, f.metadata, "cursor"),
  ).toThrow("resume");
  expect(() =>
    f.provider.subscribe!("snapshot", {}, f.context, f.controller.signal, {
      ...f.metadata,
      principal: { ...f.metadata.principal!, scopes: [] },
    }),
  ).toThrow("authority");
  expect(f.calls()).toBe(0);
});
it("does not fetch a canceled snapshot or continue a returned iterator", async () => {
  const f = fixture();
  f.controller.abort();
  await expect(f.stream().next()).rejects.toThrow();
  expect(f.calls()).toBe(0);
  const other = fixture(),
    stream = other.stream();
  await stream.next();
  await stream.return?.();
  expect((await stream.next()).done).toBe(true);
});
