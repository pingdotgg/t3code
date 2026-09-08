// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, it, vi } from "vitest";
import workerdUnsafe from "workerd:unsafe";
import { InstanceEvent } from "../index.ts";
import { computeHash } from "../lib/cache.ts";
import {
  InvalidStepReadableStreamError,
  OversizedStreamChunkError,
  UnsupportedStreamChunkError,
  WorkflowTimeoutError,
  isAbortError,
} from "../lib/errors.ts";
import {
  STREAMING_STEP_CHUNKS_TABLE,
  getStreamOutputMetaKey,
  StreamOutputState,
  rollbackStreamOutput,
  writeStreamOutput,
} from "../lib/streams.ts";
import { MODIFIER_KEYS } from "../modifier.ts";
import { runWorkflow, runWorkflowAndAwait } from "./utils.ts";
import type { Engine, EngineLogs } from "../engine.ts";
import type { StreamOutputMeta } from "../lib/streams.ts";

afterEach(async () => {
  await workerdUnsafe.abortAllDurableObjects();
});

describe("Context", () => {
  it("should provide attempt count 1 on first successful attempt", async ({
    expect,
  }) => {
    let receivedAttempt: number | undefined;

    const engineStub = await runWorkflow(
      "MOCK-INSTANCE-ID",
      async (_event, step) => {
        const result = await step.do("a successful step", async (ctx) => {
          receivedAttempt = ctx.attempt;
          return "success";
        });
        return result;
      },
    );

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 5000 },
    );

    expect(receivedAttempt).toBe(1);
  });

  it("should provide attempt count to callback", async ({ expect }) => {
    const receivedAttempts: Array<number> = [];

    const engineStub = await runWorkflow(
      "MOCK-INSTANCE-ID-RETRY",
      async (_event, step) => {
        const result = await step.do(
          "retrying step",
          {
            retries: {
              limit: 2,
              delay: 0,
            },
          },
          async (ctx) => {
            receivedAttempts.push(ctx.attempt);
            throw new Error(`Throwing`);
          },
        );
        return result;
      },
    );

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_FAILURE,
        );
      },
      { timeout: 5000 },
    );

    // Should have received attempts 1, 2, and 3
    expect(receivedAttempts).toEqual([1, 2, 3]);
  });

  it("should wait for retry delays by default", async ({ expect }) => {
    const start = Date.now();
    const engineStub = await runWorkflowAndAwait(
      "MOCK-INSTANCE-RETRY-DELAYS",
      async (_event, step) => {
        const result = await step.do(
          "retrying step with delay",
          {
            retries: {
              limit: 1,
              delay: "1 second",
              backoff: "constant",
            },
          },
          async () => {
            throw new Error("Always fails");
          },
        );
        return result;
      },
    );
    const elapsed = Date.now() - start;

    const logs = (await engineStub.readLogs()) as EngineLogs;
    expect(
      logs.logs.filter((val) => val.event === InstanceEvent.ATTEMPT_START),
    ).toHaveLength(2);
    // Should have waited at least ~1 second for the retry delay
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  it("should skip retry delays when disableRetryDelays is set", async ({
    expect,
  }) => {
    const engineId = env.ENGINE.idFromName("MOCK-INSTANCE-DISABLE-RETRY");
    const engineStub = env.ENGINE.get(engineId);

    // Set the disableRetryDelays flag before running the workflow
    await runInDurableObject(engineStub, async (_engine, state) => {
      await state.storage.put(MODIFIER_KEYS.DISABLE_ALL_RETRY_DELAYS, true);
    });

    const start = Date.now();
    const stub = await runWorkflowAndAwait(
      "MOCK-INSTANCE-DISABLE-RETRY",
      async (_event, step) => {
        const result = await step.do(
          "retrying step with delay",
          {
            retries: {
              limit: 2,
              delay: "10 seconds",
              backoff: "constant",
            },
          },
          async () => {
            throw new Error("Always fails");
          },
        );
        return result;
      },
    );
    const elapsed = Date.now() - start;

    const logs = (await stub.readLogs()) as EngineLogs;
    expect(
      logs.logs.filter((val) => val.event === InstanceEvent.ATTEMPT_START),
    ).toHaveLength(3);
    // Without disableRetryDelays, this would take 20+ seconds (10s + 10s)
    expect(elapsed).toBeLessThan(5000);
  });

  // NOTE: The `step` and `config` fields on WorkflowStepContext are new additions
  // that haven't been published to @cloudflare/workers-types yet. The runtime
  // provides them, but TypeScript doesn't know about them, so we capture ctx as
  // `unknown` and assert on the shape.
  // TODO: Remove these workarounds once https://github.com/cloudflare/workerd/pull/6523 lands.

  it("should provide step name and count in context", async ({ expect }) => {
    let receivedCtx: unknown;

    const engineStub = await runWorkflow(
      "MOCK-INSTANCE-STEP-CTX",
      async (_event, step) => {
        const result = await step.do("my step", async (ctx) => {
          receivedCtx = ctx;
          return "done";
        });
        return result;
      },
    );

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 5000 },
    );

    expect(receivedCtx).toMatchObject({
      step: { name: "my step", count: 1 },
    });
  });

  it("should increment step count for steps with the same name", async ({
    expect,
  }) => {
    const receivedContexts: Array<unknown> = [];

    const engineStub = await runWorkflow(
      "MOCK-INSTANCE-STEP-COUNT",
      async (_event, step) => {
        await step.do("repeated step", async (ctx) => {
          receivedContexts.push(ctx);
          return "first";
        });
        await step.do("repeated step", async (ctx) => {
          receivedContexts.push(ctx);
          return "second";
        });
        await step.do("different step", async (ctx) => {
          receivedContexts.push(ctx);
          return "third";
        });
        return "done";
      },
    );

    // Needs extra headroom: 3 sequential step.do calls + cold DO startup on Windows
    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 10000 },
    );

    expect(receivedContexts[0]).toMatchObject({
      step: { name: "repeated step", count: 1 },
    });
    expect(receivedContexts[1]).toMatchObject({
      step: { name: "repeated step", count: 2 },
    });
    expect(receivedContexts[2]).toMatchObject({
      step: { name: "different step", count: 1 },
    });
  });

  it("should provide resolved config with defaults in context", async ({
    expect,
  }) => {
    let receivedCtx: unknown;

    const engineStub = await runWorkflow(
      "MOCK-INSTANCE-CTX-CONFIG-DEFAULTS",
      async (_event, step) => {
        // No config provided — ctx.config should have all defaults
        const result = await step.do("default config step", async (ctx) => {
          receivedCtx = ctx;
          return "done";
        });
        return result;
      },
    );

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 5000 },
    );

    expect(receivedCtx).toMatchObject({
      config: {
        retries: {
          limit: 5,
          delay: 1000,
          backoff: "exponential",
        },
        timeout: "10 minutes",
      },
    });
  });

  it("should provide resolved config with user overrides merged in context", async ({
    expect,
  }) => {
    let receivedCtx: unknown;

    const engineStub = await runWorkflow(
      "MOCK-INSTANCE-CTX-CONFIG-OVERRIDES",
      async (_event, step) => {
        const result = await step.do(
          "custom config step",
          {
            retries: {
              limit: 3,
              delay: 500,
            },
            timeout: "5 minutes",
          },
          async (ctx) => {
            receivedCtx = ctx;
            return "done";
          },
        );
        return result;
      },
    );

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 5000 },
    );

    // User overrides should be merged with defaults
    expect(receivedCtx).toMatchObject({
      config: {
        retries: {
          limit: 3,
          delay: 500,
          backoff: "exponential",
        },
        timeout: "5 minutes",
      },
    });
  });

  it("should not allow user callback to mutate engine retry config", async ({
    expect,
  }) => {
    const receivedAttempts: Array<number> = [];

    const engineStub = await runWorkflow(
      "MOCK-INSTANCE-CTX-CONFIG-MUTATION",
      async (_event, step) => {
        const result = await step.do(
          "mutating step",
          {
            retries: {
              limit: 1,
              delay: 0,
            },
          },
          async (ctx) => {
            receivedAttempts.push(ctx.attempt);
            // Attempt to escalate retries from 1 to 100
            (
              ctx as unknown as { config: { retries: { limit: number } } }
            ).config.retries.limit = 100;
            throw new Error("retry me");
          },
        );
        return result;
      },
    );

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_FAILURE,
        );
      },
      { timeout: 5000 },
    );

    // With limit: 1, the engine should execute attempt 1 + 1 retry = 2 attempts total.
    // If the mutation leaked, this would keep going far beyond 2.
    expect(receivedAttempts).toEqual([1, 2]);
  });
});

// ── Helpers for stream tests ────────────────────────────────────────────────

function encodeUtf8(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function readStreamBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Array<Uint8Array> = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
  }
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.byteLength;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function countStreamOutputChunks(
  state: DurableObjectState,
  cacheKey: string,
): number {
  const row = state.storage.sql
    .exec<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM streaming_step_chunks WHERE cache_key = ?`,
      cacheKey,
    )
    .one();
  return row?.cnt ?? 0;
}

describe("Context - ReadableStream step outputs", () => {
  it("should persist a readable stream output and replay from cache", async ({
    expect,
  }) => {
    const payload = "hello from a readable stream ".repeat(500); // ~14KB
    const payloadBytes = encodeUtf8(payload);
    let callCount = 0;

    const engineStub = await runWorkflow(
      "STREAM-BASIC",
      async (_event, step) => {
        const stream = await step.do("stream step", async () => {
          callCount++;
          return new ReadableStream<Uint8Array>({
            start(controller) {
              // Enqueue in two chunks
              const mid = Math.floor(payloadBytes.length / 2);
              controller.enqueue(payloadBytes.slice(0, mid));
              controller.enqueue(payloadBytes.slice(mid));
              controller.close();
            },
          });
        });

        // The result should be a ReadableStream we can read
        const bytes = await readStreamBytes(
          stream as ReadableStream<Uint8Array>,
        );
        return decodeUtf8(bytes);
      },
    );

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 5000 },
    );

    const logs = (await engineStub.readLogs()) as EngineLogs;
    const successLog = logs.logs.find(
      (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
    );
    expect(successLog?.metadata.result).toBe(payload);

    // The closure should have been called exactly once (cache hit on replay)
    expect(callCount).toBe(1);

    // Verify the stream metadata is stored and marked complete
    const hash = await computeHash("stream step");
    const cacheKey = `${hash}-1`;
    const metaKey = getStreamOutputMetaKey(cacheKey);

    await runInDurableObject(engineStub, async (_engine, state) => {
      const meta = (await state.storage.get(metaKey)) as StreamOutputMeta;
      expect(meta).toBeDefined();
      expect(meta.state).toBe(StreamOutputState.Complete);
      expect(meta.totalBytes).toBe(payloadBytes.byteLength);
      expect(meta.chunkCount).toBeGreaterThanOrEqual(1);
    });
  });

  it("should persist an empty readable stream", async ({ expect }) => {
    const engineStub = await runWorkflow(
      "STREAM-EMPTY",
      async (_event, step) => {
        const stream = await step.do("empty stream step", async () => {
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          });
        });

        // Should be a readable stream that yields no data
        const bytes = await readStreamBytes(
          stream as ReadableStream<Uint8Array>,
        );
        return bytes.byteLength;
      },
    );

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 5000 },
    );

    const logs = (await engineStub.readLogs()) as EngineLogs;
    const successLog = logs.logs.find(
      (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
    );
    expect(successLog?.metadata.result).toBe(0);

    // Verify stream metadata
    const hash = await computeHash("empty stream step");
    const cacheKey = `${hash}-1`;
    const metaKey = getStreamOutputMetaKey(cacheKey);

    await runInDurableObject(engineStub, async (_engine, state) => {
      const meta = (await state.storage.get(metaKey)) as StreamOutputMeta;
      expect(meta).toBeDefined();
      expect(meta.state).toBe(StreamOutputState.Complete);
      expect(meta.totalBytes).toBe(0);
      expect(meta.chunkCount).toBe(0);
    });
  });

  // ── Tests that exercise stream error paths directly inside the DO ────
  //
  // The tests below call writeStreamOutput() inside runInDurableObject()
  // rather than running a full workflow through step.do().
  //
  // Why: In the test harness the user callback runs in a separate
  // WorkerEntrypoint (TestWorkflow) and communicates with the Engine
  // Durable Object over RPC. Returning a problematic ReadableStream from
  // that callback fails at the *RPC transfer* layer with native workerd
  // errors that are different from the custom errors the engine raises:
  //
  //   • Locked stream  → TypeError: "The ReadableStream has been locked
  //                       to a reader."
  //   • Non-byte chunks → TypeError: "This ReadableStream did not return
  //                        bytes."
  //   • Very large chunks → Error: "Network connection lost." (the RPC
  //                         pipe disconnects under load)
  //
  // In production the callback executes in the *same* isolate as the
  // engine, so the stream reaches writeStreamOutput() directly and the
  // engine's own validation (iterateStreamChunks, normalizeChunkToUint8Array,
  // chunk-size check) surfaces the correct custom error types.
  //
  // By calling writeStreamOutput() inside the DO we replicate the
  // production code-path and avoid the RPC transfer artefacts.

  it("should surface a locked readable stream as a fatal error", async ({
    expect,
  }) => {
    const engineId = env.ENGINE.idFromName("STREAM-LOCKED");
    const engineStub = env.ENGINE.get(engineId);

    await runInDurableObject(engineStub, async (_engine, state) => {
      // Create the streaming table (normally done during engine init)
      // eslint-disable-next-line workers-sdk/no-unsafe-command-execution -- DO SQL exec, not child_process
      state.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS ${STREAMING_STEP_CHUNKS_TABLE} (
					cache_key TEXT NOT NULL,
					attempt INTEGER NOT NULL,
					chunk_index INTEGER NOT NULL,
					chunk BLOB NOT NULL,
					PRIMARY KEY (cache_key, attempt, chunk_index)
				) WITHOUT ROWID
			`);

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encodeUtf8("data"));
          controller.close();
        },
      });
      // Lock the stream by acquiring a reader
      stream.getReader();

      try {
        await writeStreamOutput({
          storage: state.storage,
          cacheKey: "locked-stream-test",
          attempt: 1,
          stream,
        });
        expect.unreachable("writeStreamOutput should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidStepReadableStreamError);
      }
    });
  });

  it("should surface an unsupported chunk type as a fatal error", async ({
    expect,
  }) => {
    const engineId = env.ENGINE.idFromName("STREAM-UNSUPPORTED-CHUNK");
    const engineStub = env.ENGINE.get(engineId);

    await runInDurableObject(engineStub, async (_engine, state) => {
      // eslint-disable-next-line workers-sdk/no-unsafe-command-execution -- DO SQL exec, not child_process
      state.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS ${STREAMING_STEP_CHUNKS_TABLE} (
					cache_key TEXT NOT NULL,
					attempt INTEGER NOT NULL,
					chunk_index INTEGER NOT NULL,
					chunk BLOB NOT NULL,
					PRIMARY KEY (cache_key, attempt, chunk_index)
				) WITHOUT ROWID
			`);

      const stream = new ReadableStream({
        start(controller) {
          // Enqueue a string -- not supported (only ArrayBuffer / TypedArray)
          controller.enqueue("this is a string, not bytes");
          controller.close();
        },
      });

      try {
        await writeStreamOutput({
          storage: state.storage,
          cacheKey: "unsupported-chunk-test",
          attempt: 1,
          stream,
        });
        expect.unreachable("writeStreamOutput should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(UnsupportedStreamChunkError);
      }
    });
  });

  it("should surface an oversized stream chunk as a fatal error", async ({
    expect,
  }) => {
    const engineId = env.ENGINE.idFromName("STREAM-OVERSIZED-CHUNK");
    const engineStub = env.ENGINE.get(engineId);

    await runInDurableObject(engineStub, async (_engine, state) => {
      // eslint-disable-next-line workers-sdk/no-unsafe-command-execution -- DO SQL exec, not child_process
      state.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS ${STREAMING_STEP_CHUNKS_TABLE} (
					cache_key TEXT NOT NULL,
					attempt INTEGER NOT NULL,
					chunk_index INTEGER NOT NULL,
					chunk BLOB NOT NULL,
					PRIMARY KEY (cache_key, attempt, chunk_index)
				) WITHOUT ROWID
			`);

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // 17 MiB chunk -- exceeds the 16 MiB per-chunk limit
          controller.enqueue(new Uint8Array(17 * 1024 * 1024));
          controller.close();
        },
      });

      try {
        await writeStreamOutput({
          storage: state.storage,
          cacheKey: "oversized-chunk-test",
          attempt: 1,
          stream,
        });
        expect.unreachable("writeStreamOutput should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(OversizedStreamChunkError);
      }
    });
  });

  it("should clean up streaming_step_chunks on restart", async ({ expect }) => {
    const instanceId = "STREAM-RESTART-CLEANUP";
    const engineId = env.ENGINE.idFromName(instanceId);

    const engineStub = await runWorkflowAndAwait(
      instanceId,
      async (_event, step) => {
        const stream = await step.do("stream before restart", async () => {
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encodeUtf8("data for restart test"));
              controller.close();
            },
          });
        });
        const bytes = await readStreamBytes(
          stream as ReadableStream<Uint8Array>,
        );
        return decodeUtf8(bytes);
      },
    );

    // Verify chunks exist before restart
    const hash = await computeHash("stream before restart");
    const cacheKey = `${hash}-1`;

    await runInDurableObject(engineStub, async (_engine, state) => {
      const chunkCount = countStreamOutputChunks(state, cacheKey);
      expect(chunkCount).toBeGreaterThanOrEqual(1);
    });

    // Trigger restart
    try {
      await runInDurableObject(engineStub, async (engine) => {
        await engine.changeInstanceStatus("restart");
      });
    } catch (e) {
      if (!isAbortError(e)) {
        throw e;
      }
    }

    const restartedStub: DurableObjectStub<Engine> = env.ENGINE.get(engineId);
    await runInDurableObject(restartedStub, async (engine, state) => {
      await engine.attemptRestart();

      // Check immediately after attemptRestart returns, before the
      // fire-and-forget init() call (engine.ts:892) has a chance to
      // re-execute the workflow and recreate the chunks.
      const chunkCount = countStreamOutputChunks(state, cacheKey);
      expect(chunkCount).toBe(0);
    });
  });

  it("should preserve mock stream chunks across restart", async ({
    expect,
  }) => {
    const mockPayload = "mock stream survives restart";
    const mockPayloadBytes = encodeUtf8(mockPayload);

    const instanceId = "STREAM-MOCK-SURVIVES-RESTART";
    const engineId = env.ENGINE.idFromName(instanceId);
    const engineStub = env.ENGINE.get(engineId);

    // Set up a mocked stream step via the modifier
    await runInDurableObject(engineStub, async (engine) => {
      const modifier = engine.getInstanceModifier();
      await modifier.mockStepResult(
        { name: "mocked restart stream" },
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(mockPayloadBytes);
            controller.close();
          },
        }),
      );
    });

    const hash = await computeHash("mocked restart stream");
    const baseCacheKey = `${hash}-1`;

    // Run the workflow once so the engine is initialised and can be restarted
    const stub = await runWorkflow(instanceId, async (_event, step) => {
      const stream = await step.do("mocked restart stream", async () => {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encodeUtf8("WRONG - real step ran"));
            controller.close();
          },
        });
      });
      const bytes = await readStreamBytes(stream as ReadableStream<Uint8Array>);
      return decodeUtf8(bytes);
    });

    await vi.waitUntil(
      async () => {
        const logs = (await stub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 5000 },
    );

    // Trigger restart
    try {
      await runInDurableObject(stub, async (engine) => {
        await engine.changeInstanceStatus("restart");
      });
    } catch (e) {
      if (!isAbortError(e)) {
        throw e;
      }
    }

    // After restart, mock stream chunks (attempt=0) must still exist
    const restartedStub: DurableObjectStub<Engine> = env.ENGINE.get(engineId);
    await runInDurableObject(restartedStub, async (engine, state) => {
      await engine.attemptRestart();

      const chunkCount = countStreamOutputChunks(state, baseCacheKey);
      expect(chunkCount).toBeGreaterThanOrEqual(1);
    });

    // Run the workflow again — the mock sentinel (KV) and its SQL chunks
    // should both be present, allowing the mocked stream to replay correctly.
    const stub2 = await runWorkflow(instanceId, async (_event, step) => {
      const stream = await step.do("mocked restart stream", async () => {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encodeUtf8("WRONG - real step ran after restart"),
            );
            controller.close();
          },
        });
      });
      const bytes = await readStreamBytes(stream as ReadableStream<Uint8Array>);
      return decodeUtf8(bytes);
    });

    await vi.waitUntil(
      async () => {
        const logs = (await stub2.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 5000 },
    );

    const logs = (await stub2.readLogs()) as EngineLogs;
    const successLog = logs.logs.find(
      (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
    );
    expect(successLog?.metadata.result).toBe(mockPayload);
  });

  it("should normalize TypedArray chunks to Uint8Array on replay", async ({
    expect,
  }) => {
    // Return Int16Array chunks -- they should be stored as raw bytes
    // and replayed as Uint8Array
    const int16Data = new Int16Array([1, 2, 3, 256, -1]);
    const expectedBytes = new Uint8Array(
      int16Data.buffer,
      int16Data.byteOffset,
      int16Data.byteLength,
    );

    const engineStub = await runWorkflow(
      "STREAM-TYPED-ARRAY",
      async (_event, step) => {
        const stream = await step.do("typed array step", async () => {
          return new ReadableStream({
            start(controller) {
              controller.enqueue(int16Data);
              controller.close();
            },
          });
        });

        const bytes = await readStreamBytes(
          stream as ReadableStream<Uint8Array>,
        );
        return Array.from(bytes);
      },
    );

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 5000 },
    );

    const logs = (await engineStub.readLogs()) as EngineLogs;
    const successLog = logs.logs.find(
      (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
    );
    expect(successLog?.metadata.result).toEqual(Array.from(expectedBytes));
  });

  it("should return a replay ReadableStream from waitForStepResult", async ({
    expect,
  }) => {
    const payload = "stream content for waitForStepResult";
    const payloadBytes = encodeUtf8(payload);

    const engineStub = await runWorkflow(
      "STREAM-WAIT-FOR-STEP",
      async (_event, step) => {
        const stream = await step.do("stream step", async () => {
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(payloadBytes);
              controller.close();
            },
          });
        });
        const bytes = await readStreamBytes(
          stream as ReadableStream<Uint8Array>,
        );
        return decodeUtf8(bytes);
      },
    );

    // Use engine's waitForStepResult to get the stream
    const stepResult = await engineStub.waitForStepResult("stream step");

    // Should be a ReadableStream
    expect(stepResult).toBeInstanceOf(ReadableStream);

    const replayBytes = await readStreamBytes(
      stepResult as ReadableStream<Uint8Array>,
    );
    expect(decodeUtf8(replayBytes)).toBe(payload);

    // Wait for workflow to finish
    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 5000 },
    );
  });

  it("should mock a step result with a ReadableStream via modifier", async ({
    expect,
  }) => {
    const mockPayload = "mocked stream content from modifier";
    const mockPayloadBytes = encodeUtf8(mockPayload);

    const instanceId = "STREAM-MOCK-STEP-RESULT";
    const engineId = env.ENGINE.idFromName(instanceId);
    const engineStub = env.ENGINE.get(engineId);

    // Set up the mock stream result via the modifier before running the workflow
    await runInDurableObject(engineStub, async (engine) => {
      const modifier = engine.getInstanceModifier();
      await modifier.mockStepResult(
        { name: "mocked stream step" },
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(mockPayloadBytes);
            controller.close();
          },
        }),
      );
    });

    const hash = await computeHash("mocked stream step");
    const baseCacheKey = `${hash}-1`;
    const valueKey = `${baseCacheKey}-value`;

    await runInDurableObject(engineStub, async (_engine, state) => {
      // normal non-mocked key should not exist
      expect(
        await state.storage.get(getStreamOutputMetaKey(baseCacheKey)),
      ).toBeUndefined();

      const replaceResult = await state.storage.get<{
        __mockStreamOutput: true;
        cacheKey: string;
        meta: StreamOutputMeta;
      }>(`${MODIFIER_KEYS.REPLACE_RESULT}${valueKey}`);

      expect(replaceResult?.__mockStreamOutput).toBe(true);
      expect(replaceResult?.cacheKey).toBe(baseCacheKey);
      expect(replaceResult?.meta.state).toBe(StreamOutputState.Complete);
      expect(replaceResult?.meta.attempt).toBe(0);
      expect(
        countStreamOutputChunks(state, baseCacheKey),
      ).toBeGreaterThanOrEqual(1);
    });

    // Run a workflow that uses the mocked step
    const stub = await runWorkflow(instanceId, async (_event, step) => {
      const stream = await step.do("mocked stream step", async () => {
        // This should NOT be called -- the mock replaces it
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encodeUtf8("WRONG - real step ran"));
            controller.close();
          },
        });
      });
      const bytes = await readStreamBytes(stream as ReadableStream<Uint8Array>);
      return decodeUtf8(bytes);
    });

    await vi.waitUntil(
      async () => {
        const logs = (await stub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 5000 },
    );

    const logs = (await stub.readLogs()) as EngineLogs;
    const successLog = logs.logs.find(
      (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
    );
    // The workflow should have received the mocked stream content
    expect(successLog?.metadata.result).toBe(mockPayload);
  });

  it("should resolve stream output to a text preview in readLogs", async ({
    expect,
  }) => {
    const payload = "hello from stream preview test";
    const payloadBytes = encodeUtf8(payload);

    const engineStub = await runWorkflow(
      "STREAM-PREVIEW-TEXT",
      async (_event, step) => {
        const stream = await step.do("preview step", async () => {
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(payloadBytes);
              controller.close();
            },
          });
        });
        const bytes = await readStreamBytes(
          stream as ReadableStream<Uint8Array>,
        );
        return decodeUtf8(bytes);
      },
    );

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 5000 },
    );

    const logs = (await engineStub.readLogs()) as EngineLogs;
    const stepLog = logs.logs.find(
      (val) => val.event === InstanceEvent.STEP_SUCCESS,
    );
    // readLogs() should resolve the stream output metadata to the preview text
    expect(stepLog?.metadata.result).toBe(payload);
  });

  it("should truncate a long stream preview in readLogs", async ({
    expect,
  }) => {
    // Generate a payload longer than the 1024-char preview limit
    const payload = "A".repeat(2048);
    const payloadBytes = encodeUtf8(payload);

    const engineStub = await runWorkflow(
      "STREAM-PREVIEW-TRUNCATED",
      async (_event, step) => {
        const stream = await step.do("long preview step", async () => {
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(payloadBytes);
              controller.close();
            },
          });
        });
        const bytes = await readStreamBytes(
          stream as ReadableStream<Uint8Array>,
        );
        return decodeUtf8(bytes);
      },
    );

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 5000 },
    );

    const logs = (await engineStub.readLogs()) as EngineLogs;
    const stepLog = logs.logs.find(
      (val) => val.event === InstanceEvent.STEP_SUCCESS,
    );
    // readLogs() should truncate the preview to 1024 chars
    expect(stepLog?.metadata.result).toBe(
      "A".repeat(1024) + "[truncated output]",
    );
  });

  it("should resolve non-UTF-8 stream output to a binary summary in readLogs", async ({
    expect,
  }) => {
    // Write raw bytes that are not valid UTF-8
    const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0x80, 0x81]);

    const engineStub = await runWorkflow(
      "STREAM-PREVIEW-BINARY",
      async (_event, step) => {
        const stream = await step.do("binary step", async () => {
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(invalidUtf8);
              controller.close();
            },
          });
        });
        const bytes = await readStreamBytes(
          stream as ReadableStream<Uint8Array>,
        );
        return bytes.byteLength;
      },
    );

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 5000 },
    );

    const logs = (await engineStub.readLogs()) as EngineLogs;
    const stepLog = logs.logs.find(
      (val) => val.event === InstanceEvent.STEP_SUCCESS,
    );
    // readLogs() should fall back to a binary size summary
    expect(stepLog?.metadata.result).toBe(
      `[ReadableStream (binary): ${invalidUtf8.byteLength} bytes]`,
    );
  });

  it("should time out during stream write and roll back", async ({
    expect,
  }) => {
    // In the full workflow path a stream-write timeout triggers retries
    // (default limit: 5, exponential backoff from 1 s), so the test would
    // exceed its timeout before WORKFLOW_FAILURE is ever logged.  Testing
    // writeStreamOutput() directly lets us verify timeout + rollback
    // behaviour without retry overhead.

    const engineId = env.ENGINE.idFromName("STREAM-TIMEOUT");
    const engineStub = env.ENGINE.get(engineId);

    const cacheKey = "timeout-stream-test";

    await runInDurableObject(engineStub, async (_engine, state) => {
      // eslint-disable-next-line workers-sdk/no-unsafe-command-execution -- DO SQL exec, not child_process
      state.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS ${STREAMING_STEP_CHUNKS_TABLE} (
					cache_key TEXT NOT NULL,
					attempt INTEGER NOT NULL,
					chunk_index INTEGER NOT NULL,
					chunk BLOB NOT NULL,
					PRIMARY KEY (cache_key, attempt, chunk_index)
				) WITHOUT ROWID
			`);

      const abortController = new AbortController();

      // Create a timeout promise that rejects after 1 second, mirroring
      // the timeoutPromise() used by Context.do() in production.
      const timeoutTask = new Promise<never>((_, reject) => {
        setTimeout(() => {
          const error = new WorkflowTimeoutError(
            "Execution timed out after 1000ms",
          );
          abortController.abort(error);
          reject(error);
        }, 1000);
      });

      // Stream that never closes — each pull emits a small chunk then
      // waits longer than the timeout.
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          controller.enqueue(encodeUtf8("chunk "));
          await new Promise((resolve) => setTimeout(resolve, 2000));
        },
      });

      try {
        await writeStreamOutput({
          storage: state.storage,
          cacheKey,
          attempt: 1,
          stream,
          signal: abortController.signal,
          timeoutTask,
        });
        expect.unreachable("writeStreamOutput should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(WorkflowTimeoutError);
      }

      // Mimic the rollback that context.ts performs in the outer catch
      // (line ~704) when a stream write times out.
      await rollbackStreamOutput(state.storage, cacheKey, 1);

      // Verify that all chunks and metadata were cleaned up
      const chunkCount = countStreamOutputChunks(state, cacheKey);
      expect(chunkCount).toBe(0);

      const metaKey = getStreamOutputMetaKey(cacheKey);
      const meta = await state.storage.get(metaKey);
      expect(meta).toBeUndefined();
    });
  });
});

describe("Context - typed-array step outputs (issue #14101)", () => {
  it("should persist a 200KB Uint8Array step output on a tight backing buffer", async ({
    expect,
  }) => {
    // Baseline: a 200KB view sized exactly to its backing buffer must
    // succeed. This case worked on `main` too — anchors the regression test
    // suite to "small enough to fit, regardless of normalisation".
    const engineStub = await runWorkflow(
      "UINT8-TIGHT-200K",
      async (_event, step) => {
        return await step.do("emit-tight-bytes", async () => {
          return new Uint8Array(200_000);
        });
      },
    );

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 10000 },
    );

    const logs = (await engineStub.readLogs()) as EngineLogs;
    expect(
      logs.logs.some((val) => val.event === InstanceEvent.WORKFLOW_SUCCESS),
    ).toBe(true);
    expect(
      logs.logs.some((val) => val.event === InstanceEvent.WORKFLOW_FAILURE),
    ).toBe(false);
  });

  it("should persist a 200KB Uint8Array view sliced from an 800KB backing buffer (regression #14101)", async ({
    expect,
  }) => {
    // The exact reporter's repro: a Uint8Array view sized 200KB but
    // sliced from a much larger backing ArrayBuffer (800KB here). Prior
    // to the fix, workerd's v8::ValueSerializer would serialise the
    // entire 800KB backing buffer along with the view, blowing past the
    // 1MiB SQL blob limit and surfacing a raw `SQLITE_TOOBIG` error.
    const engineStub = await runWorkflow(
      "UINT8-SLICED-200K-OF-800K",
      async (_event, step) => {
        return await step.do("emit-sliced-bytes", async () => {
          const backing = new ArrayBuffer(800_000);
          return new Uint8Array(backing, 0, 200_000);
        });
      },
    );

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 10000 },
    );

    const logs = (await engineStub.readLogs()) as EngineLogs;
    expect(
      logs.logs.some((val) => val.event === InstanceEvent.WORKFLOW_SUCCESS),
    ).toBe(true);
    expect(
      logs.logs.some((val) => val.event === InstanceEvent.WORKFLOW_FAILURE),
    ).toBe(false);
  });

  it("should return the original Uint8Array to the next step in the live execution path", async ({
    expect,
  }) => {
    // The persisted form preserves the view type (`Uint8Array` stays
    // `Uint8Array`) so the live execution path and cached replays observe
    // the same shape — downstream user code that branches on
    // `value instanceof Uint8Array` works either way.
    let observedInNext: unknown = "not-seen";
    const engineStub = await runWorkflow(
      "UINT8-ROUND-TRIP",
      async (_event, step) => {
        const bytes = await step.do("emit-bytes", async () => {
          return new Uint8Array([1, 2, 3, 4, 5]);
        });
        await step.do("read-bytes", async () => {
          observedInNext = bytes;
          return "ok";
        });
      },
    );

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 10000 },
    );

    expect(observedInNext).toBeInstanceOf(Uint8Array);
    expect(Array.from(observedInNext as Uint8Array)).toEqual([1, 2, 3, 4, 5]);
  });

  it("should preserve typed-array view types other than Uint8Array on the live execution path", async ({
    expect,
  }) => {
    // Persisting must preserve the constructor type (`Int16Array` stays
    // `Int16Array`, etc.) so downstream `instanceof` checks behave the
    // same whether the step ran live or via cached replay.
    let observedInNext: unknown = "not-seen";
    const engineStub = await runWorkflow(
      "INT16-ROUND-TRIP",
      async (_event, step) => {
        const bytes = await step.do("emit-int16", async () => {
          return new Int16Array([1, 2, 3, 4, 5]);
        });
        await step.do("read-int16", async () => {
          observedInNext = bytes;
          return "ok";
        });
      },
    );

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 10000 },
    );

    expect(observedInNext).toBeInstanceOf(Int16Array);
    expect(Array.from(observedInNext as Int16Array)).toEqual([1, 2, 3, 4, 5]);
  });

  it("should compact typed-array views nested inside an object (deep-walk regression)", async ({
    expect,
  }) => {
    // A view sliced from a much larger backing buffer would bloat past
    // SQLITE_TOOBIG if nested-level normalisation were missing. Recurses
    // into plain objects.
    const engineStub = await runWorkflow(
      "NESTED-UINT8-SLICED",
      async (_event, step) => {
        return await step.do("emit-nested-sliced-bytes", async () => {
          const backing = new ArrayBuffer(800_000);
          return {
            image: new Uint8Array(backing, 0, 200_000),
            meta: { width: 100, height: 100 },
          };
        });
      },
    );

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 10000 },
    );

    const logs = (await engineStub.readLogs()) as EngineLogs;
    expect(
      logs.logs.some((val) => val.event === InstanceEvent.WORKFLOW_SUCCESS),
    ).toBe(true);
    expect(
      logs.logs.some((val) => val.event === InstanceEvent.WORKFLOW_FAILURE),
    ).toBe(false);
  });

  it("should compact typed-array views nested deep inside arrays of objects", async ({
    expect,
  }) => {
    // Two levels of nesting (array of object of view). Confirms the
    // walker descends through both arrays and plain objects.
    const engineStub = await runWorkflow(
      "ARRAY-OF-OBJECTS-WITH-SLICED-VIEWS",
      async (_event, step) => {
        return await step.do("emit-array-of-objects", async () => {
          const backing = new ArrayBuffer(800_000);
          return [
            { data: new Uint8Array(backing, 0, 100_000) },
            { data: new Uint8Array(backing, 100_000, 100_000) },
          ];
        });
      },
    );

    await vi.waitUntil(
      async () => {
        const logs = (await engineStub.readLogs()) as EngineLogs;
        return logs.logs.some(
          (val) => val.event === InstanceEvent.WORKFLOW_SUCCESS,
        );
      },
      { timeout: 10000 },
    );

    const logs = (await engineStub.readLogs()) as EngineLogs;
    expect(
      logs.logs.some((val) => val.event === InstanceEvent.WORKFLOW_SUCCESS),
    ).toBe(true);
    expect(
      logs.logs.some((val) => val.event === InstanceEvent.WORKFLOW_FAILURE),
    ).toBe(false);
  });
});
