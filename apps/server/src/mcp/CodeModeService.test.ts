// @effect-diagnostics nodeBuiltinImport:off -- These fixtures exercise actual native journal persistence in temporary directories.
import { expect, it, vi } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { CodeModeHost } from "./CodeModeService.ts";
import { CodeModeJournal } from "./CodeModeJournal.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("host-test"),
  threadId: ThreadId.make("host-parent"),
  providerSessionId: "host-session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const base = { scope, tools: [], invoke: async () => null, timeoutMs: 60_000, onSettled: () => {} };

it("cancels handles and releases execution quotas after pending guest cleanup", async () => {
  const host = new CodeModeHost();
  try {
    const first = await host.start({
      ...base,
      controller: new AbortController(),
      code: "await new Promise(()=>{});",
    });
    const second = await host.start({
      ...base,
      controller: new AbortController(),
      code: "await new Promise(()=>{});",
    });
    await expect(
      host.start({ ...base, controller: new AbortController(), code: "return 1" }),
    ).rejects.toThrow("2 running");
    expect((await host.cancel(first, scope)).status).toBe("cancelled");
    const third = await host.start({
      ...base,
      controller: new AbortController(),
      code: "return 3",
    });
    expect(await host.wait(third, scope, 1000)).toMatchObject({ status: "completed", result: 3 });
    await host.cancel(second, scope);
  } finally {
    await host.dispose();
  }
});

it("enforces a wall deadline even when the guest has no pending host calls", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const host = new CodeModeHost();
  try {
    const id = await host.start({
      ...base,
      controller: new AbortController(),
      timeoutMs: 500,
      code: "await new Promise(()=>{});",
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(await host.wait(id, scope, 0)).toMatchObject({
      status: "failed",
      error: "Code mode execution timed out.",
    });
  } finally {
    await host.dispose();
    vi.useRealTimers();
  }
});

it("evicts old completed handles rather than keeping unbounded results", async () => {
  const host = new CodeModeHost();
  try {
    let first = "";
    for (let i = 0; i < 33; i++) {
      const id = await host.start({
        ...base,
        controller: new AbortController(),
        code: `return ${i}`,
      });
      if (i === 0) first = id;
      expect((await host.wait(id, scope, 1000)).status).toBe("completed");
    }
    await expect(host.wait(first, scope, 0)).rejects.toThrow("not found");
  } finally {
    await host.dispose();
  }
});

it("reserves process capacity atomically across concurrent submissions", async () => {
  const host = new CodeModeHost();
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        host.start({
          ...base,
          controller: new AbortController(),
          code: "await new Promise(()=>{});",
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
  } finally {
    await host.dispose();
  }
});

it.effect(
  "recovers durable results across restarts and deduplicates submission without replay",
  () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      yield* Effect.promise(async () => {
        const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-code-journal-"));
        const first = new CodeModeHost(new CodeModeJournal(directory, platform));
        const second = new CodeModeHost(new CodeModeJournal(directory, platform));
        let calls = 0;
        const input = {
          ...base,
          tools: ["test"],
          code: "return await t3.test({});",
          clientRequestId: "durable-request",
          invoke: async () => {
            calls++;
            return { accepted: true };
          },
          controller: new AbortController(),
        };
        try {
          await first.recover();
          const id = await first.start(input);
          expect((await first.wait(id, scope, 1000)).status).toBe("completed");
          await first.dispose();
          await second.recover();
          const credential = { ...scope, providerSessionId: "new-session" };
          const retry = await second.start({
            ...input,
            scope: credential,
            controller: new AbortController(),
          });
          expect(retry).toBe(id);
          expect(await second.wait(retry, credential, 0, true)).toMatchObject({
            status: "completed",
            result: { accepted: true },
            calls: [{ status: "completed", result: { accepted: true } }],
          });
          expect(calls).toBe(1);
          await expect(
            second.start({
              ...input,
              scope: credential,
              controller: new AbortController(),
              code: "return 2",
            }),
          ).rejects.toThrow("different code");
        } finally {
          await first.dispose();
          await second.dispose();
          await NodeFSP.rm(directory, { recursive: true, force: true });
        }
      });
    }),
);

it.effect(
  "marks interrupted execution and dispatch outcomes on recovery without spawning a host",
  () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      yield* Effect.promise(async () => {
        const directory = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "t3-code-interrupted-"),
        );
        const journal = new CodeModeJournal(directory, platform);
        const host = new CodeModeHost(journal);
        const id = NodeCrypto.randomUUID();
        try {
          await journal.write({
            scope,
            createdAt: 1,
            runId: null,
            requestId: "interrupted-request",
            codeHash: NodeCrypto.createHash("sha256").update("return 1").digest("hex"),
            state: {
              executionId: id,
              status: "running",
              result: null,
              error: null,
              logs: [],
              calls: [{ tool: "test", status: "running", result: null }],
            },
          });
          const partial = NodePath.join(directory, `${id}.json.tmp`);
          await NodeFSP.writeFile(partial, '{"partial":');
          await host.recover();
          await expect(NodeFSP.stat(partial)).rejects.toMatchObject({ code: "ENOENT" });
          const recovered = await host.wait(
            id,
            { ...scope, providerSessionId: "recovered-session" },
            0,
            true,
          );
          expect(recovered.status).toBe("failed");
          expect(recovered.error).toContain("not replayed");
          expect(recovered.calls[0]).toMatchObject({
            status: "failed",
            result: { message: expect.stringContaining("uncertain") },
          });
          let invoked = false;
          expect(
            await host.start({
              ...base,
              code: "return 1",
              clientRequestId: "interrupted-request",
              controller: new AbortController(),
              invoke: async () => {
                invoked = true;
              },
            }),
          ).toBe(id);
          expect(invoked).toBe(false);
        } finally {
          await host.dispose();
          await NodeFSP.rm(directory, { recursive: true, force: true });
        }
      });
    }),
);
