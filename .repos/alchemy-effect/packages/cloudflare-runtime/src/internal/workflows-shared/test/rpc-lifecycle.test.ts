// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
// Alchemy modifications: uses Array<T> syntax for non-tuple array types to match the repository convention;
// attaches disposers through `withDisposer` and annotates `this` so the tests type-check under strict settings.
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, it, vi } from "vitest";
import workerdUnsafe from "workerd:unsafe";
import { WorkflowBinding } from "../binding.ts";
import { InstanceEvent } from "../instance.ts";
import { WorkflowInstanceIntrospectorHandle } from "../introspection.ts";
import { normalizeForStorage } from "../lib/serialization.ts";
import { WorkflowInstanceModifier } from "../modifier.ts";
import type { WorkflowBinding as IntrospectionBinding } from "../types.ts";
import { setTestWorkflowCallback } from "./test-entry.ts";
import { runWorkflowAndAwait } from "./utils.ts";

afterEach(async () => {
  await workerdUnsafe.abortAllDurableObjects();
  vi.restoreAllMocks();
  Reflect.deleteProperty(WorkflowInstanceModifier.prototype, Symbol.dispose);
});

/** Attaches an RPC disposer without changing the value's serializable type. */
const withDisposer = <T extends object>(value: T, dispose: () => void): T =>
  Object.assign(value, { [Symbol.dispose]: dispose });

function createBinding(): WorkflowBinding {
  return new WorkflowBinding(createExecutionContext(), {
    ENGINE: env.ENGINE,
    BINDING_NAME: "TEST_WORKFLOW",
    WORKFLOW_NAME: "test-workflow",
  });
}

it("releases the step callback's RPC result and preserves the live data shape", async ({
  expect,
}) => {
  const dispose = vi.fn();
  let result: unknown;
  await runWorkflowAndAwait(crypto.randomUUID(), async (_event, step) => {
    result = await step.do("RPC result", async () =>
      withDisposer({ value: 42, bytes: new Uint8Array(new ArrayBuffer(8), 2, 2) }, dispose),
    );
  });

  expect(result).toEqual({ value: 42, bytes: new Uint8Array(2) });
  expect(result).toHaveProperty("bytes.byteOffset", 2);
  expect(result).toHaveProperty("bytes.buffer.byteLength", 8);
  // The remote disposer runs asynchronously after the local stub is released.
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
});

it.for([false, true])(
  "disposes an introspector's modifier (modified: %s)",
  async (modified, { expect }) => {
    const binding = createBinding();
    await using instance = new WorkflowInstanceIntrospectorHandle(
      binding as unknown as IntrospectionBinding,
      crypto.randomUUID(),
    );
    if (modified) {
      await instance.modify((modifier) => modifier.disableSleeps());
    }

    await instance.dispose();
    await expect(instance.modify((modifier) => modifier.disableSleeps())).rejects.toThrow(
      "RPC stub used after being disposed",
    );
    // The await-using scope calls dispose() again, exercising idempotence.
  },
);

it.for([false, true])(
  "releases the temporary modifier used by create (modified: %s)",
  async (modified, { expect }) => {
    const id = crypto.randomUUID();
    const binding = createBinding();
    const dispose = vi.fn();
    // RPC target disposers are looked up on the prototype.
    Object.defineProperty(WorkflowInstanceModifier.prototype, Symbol.dispose, {
      value: dispose,
      configurable: true,
    });

    const sessionId = await binding.unsafeStartIntrospection();
    try {
      if (modified) {
        await binding.unsafeSetIntrospectionOperations(sessionId, [{ type: "disableSleeps" }]);
      }
      setTestWorkflowCallback(async () => undefined);
      await binding.create({ id });
      const instance = await binding.get(id);
      await vi.waitUntil(async () => (await instance.status()).status === "complete");
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    } finally {
      await binding.unsafeStopIntrospection(sessionId);
      await binding.unsafeAbort(id);
    }
  },
);

it.for([false, true])(
  "aborts after modifier acquisition fails (modify attempted: %s)",
  async (attemptModify, { expect }) => {
    const binding = createBinding();
    const error = new Error("modifier acquisition failed");
    vi.spyOn(binding, "unsafeGetInstanceModifier").mockRejectedValue(error);
    const abort = vi.spyOn(binding, "unsafeAbort");
    const id = crypto.randomUUID();
    {
      await using instance = new WorkflowInstanceIntrospectorHandle(
        binding as unknown as IntrospectionBinding,
        id,
      );
      if (attemptModify) {
        await expect(instance.modify((modifier) => modifier.disableSleeps())).rejects.toBe(error);
      }
      await expect(instance.dispose()).resolves.toBeUndefined();
    }
    expect(abort).toHaveBeenCalledExactlyOnceWith(id, "Instance dispose");
  },
);

it("still reports a modifier disposer failure after aborting", async ({ expect }) => {
  const binding = createBinding();
  const error = new Error("modifier disposal failed");
  vi.spyOn(binding, "unsafeGetInstanceModifier").mockResolvedValue({
    [Symbol.dispose]() {
      throw error;
    },
  });
  const abort = vi.spyOn(binding, "unsafeAbort");
  const id = crypto.randomUUID();
  const instance = new WorkflowInstanceIntrospectorHandle(
    binding as unknown as IntrospectionBinding,
    id,
  );
  await expect(instance.dispose()).rejects.toBe(error);
  expect(abort).toHaveBeenCalledExactlyOnceWith(id, "Instance dispose");
});

it.for([
  { name: "function-valued property", create: () => ({ helper: () => 42 }) },
  {
    name: "function-valued array property",
    create: () => Object.assign([42], { helper: () => 42 }),
  },
])("rejects a non-cloneable step result: $name", async ({ create }, { expect }) => {
  // The storage normaliser used to discard extra array properties. They must
  // not let non-serialisable output bypass the step result contract.
  const id = crypto.randomUUID();
  await runWorkflowAndAwait(id, async (_event, step) => {
    await step.do("non-cloneable result", async () => create());
  });
  const engine = env.ENGINE.get(env.ENGINE.idFromName(id));
  const { logs } = await engine.readLogs();
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: InstanceEvent.WORKFLOW_FAILURE,
      metadata: expect.objectContaining({
        error: expect.objectContaining({
          message: expect.stringContaining("not serialisable"),
        }),
      }),
    }),
  );
});

it("preserves data from class instances with prototype methods", async ({ expect }) => {
  class Result {
    value = 42;
    method(): number {
      return this.value;
    }
  }
  const stub = env.ENGINE.get(env.ENGINE.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (_engine, state) => {
    const value = new Result();
    // Both the old storage path and structuredClone ignore prototype methods.
    await state.storage.put("result", { value: normalizeForStorage(value) });
    expect(await state.storage.get("result")).toEqual({ value: { value: 42 } });
    expect(structuredClone(value)).toEqual({ value: 42 });
  });
});

it.for(["object", "stream", "reject", "cancel-reject"] as const)(
  "cleans up a late callback after a timeout: %s",
  async (kind, { expect }) => {
    const lateCleanup = vi.fn();
    const originalCancel = ReadableStream.prototype.cancel;
    const cancel = vi.spyOn(ReadableStream.prototype, "cancel");
    if (kind === "cancel-reject") {
      cancel.mockImplementation(async function (this: ReadableStream, reason) {
        await originalCancel.call(this, reason);
        throw new Error("late stream cancellation failed");
      });
    }
    const winningDispose = vi.fn();
    const winningCancel = vi.fn();
    const attempts: Array<number> = [];
    const lateResult = Promise.withResolvers<void>();
    let lateSettled = false;
    let cleanupSeenByRetry = false;
    let result: unknown;
    await runWorkflowAndAwait(crypto.randomUUID(), async (_event, step) => {
      const value = await step.do<{ attempt: number } | ReadableStream<Uint8Array>>(
        "late callback result",
        {
          timeout: "1 second",
          retries: { limit: 1, delay: 1, backoff: "constant" },
        },
        async (ctx) => {
          attempts.push(ctx.attempt);
          if (ctx.attempt === 1) {
            // Only the retry can release this callback: cleanup must not
            // delay the retry until the abandoned callback finishes.
            await lateResult.promise;
            lateSettled = true;
            if (kind === "reject") {
              throw new Error("late callback failed");
            }
            if (kind === "object") {
              return { attempt: 1, [Symbol.dispose]: lateCleanup };
            }
            // Observe cancellation on the receiving stream. Workerd does
            // not reliably notify the source's cancel hook over RPC.
            return new ReadableStream<Uint8Array>();
          }
          lateResult.resolve();
          cleanupSeenByRetry = await vi
            .waitUntil(
              () =>
                kind === "reject"
                  ? lateSettled
                  : kind === "object"
                    ? lateCleanup.mock.calls.length === 1
                    : cancel.mock.settledResults.length === 1,
              { timeout: 500 },
            )
            .then(
              () => true,
              () => false,
            );
          if (kind === "stream" || kind === "cancel-reject") {
            return new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("retry succeeded"));
                controller.close();
              },
              cancel: winningCancel,
            });
          }
          return { attempt: 2, [Symbol.dispose]: winningDispose };
        },
      );
      result = value instanceof ReadableStream ? await new Response(value).text() : value;
    });

    expect(attempts).toEqual([1, 2]);
    expect(lateSettled).toBe(true);
    expect(cleanupSeenByRetry).toBe(true);
    if (kind === "stream" || kind === "cancel-reject") {
      expect(result).toBe("retry succeeded");
      expect(winningCancel).not.toHaveBeenCalled();
    } else {
      expect(result).toEqual({ attempt: 2 });
      await vi.waitFor(() => expect(winningDispose).toHaveBeenCalledOnce());
    }
    if (kind === "object") {
      expect(lateCleanup).toHaveBeenCalledOnce();
    }
    if (kind === "stream" || kind === "cancel-reject") {
      expect(cancel).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          name: "WorkflowTimeoutError",
        }),
      );
      expect(cancel.mock.settledResults[0]?.type).toBe(
        kind === "stream" ? "fulfilled" : "rejected",
      );
    } else {
      expect(cancel).not.toHaveBeenCalled();
    }
  },
);

it("cleans up a late callback that lands after its step has finished", async ({ expect }) => {
  const lateCleanup = vi.fn();
  const attempts: Array<number> = [];
  const lateResult = Promise.withResolvers<void>();
  let cleanupSeenByLaterStep = false;

  await runWorkflowAndAwait(crypto.randomUUID(), async (_event, step) => {
    await step.do(
      "late callback result",
      {
        timeout: "1 second",
        retries: { limit: 1, delay: 1, backoff: "constant" },
      },
      async (ctx) => {
        attempts.push(ctx.attempt);
        if (ctx.attempt === 1) {
          // Held open past the retry, so the abandoned callback's cleanup is
          // left running from the engine with no step awaiting it.
          await lateResult.promise;
          return withDisposer({ attempt: 1 }, lateCleanup);
        }
        return { attempt: 2 };
      },
    );

    // The engine keeps the abandoned cleanup alive across the step boundary:
    // releasing the first callback here still disposes its result.
    await step.do("later step", async () => {
      lateResult.resolve();
      cleanupSeenByLaterStep = await vi
        .waitUntil(() => lateCleanup.mock.calls.length === 1, { timeout: 500 })
        .then(
          () => true,
          () => false,
        );
    });
  });

  expect(attempts).toEqual([1, 2]);
  expect(cleanupSeenByLaterStep).toBe(true);
  expect(lateCleanup).toHaveBeenCalledOnce();
});
