import { assert, describe, it } from "@effect/vitest";

import { createPocketLifecycle, type PocketWorker } from "./pocket-lifecycle.ts";

const metrics = {
  chunkCount: 1,
  totalSamples: 24_000,
  sampleRate: 24_000,
  synthesisDurationMs: 20,
  synthesisCpuMs: 30,
  peakRssBytes: 100,
  firstChunkReadyMs: 10,
};

function harness() {
  let starts = 0;
  let closes = 0;
  let scheduled: (() => void) | undefined;
  const worker: PocketWorker = {
    synthesize: async (_text, consumeChunk) => {
      await consumeChunk("/tmp/chunk.wav", 0);
      return metrics;
    },
    close: async () => {
      closes += 1;
    },
  };
  const lifecycle = createPocketLifecycle({
    startWorker: async () => {
      starts += 1;
      return worker;
    },
    schedule: (_delay, task) => {
      scheduled = task;
      return () => {
        if (scheduled === task) scheduled = undefined;
      };
    },
    idleMs: 30_000,
  });
  return {
    lifecycle,
    starts: () => starts,
    closes: () => closes,
    evict: () => scheduled?.(),
  };
}

describe("Pocket lifecycle", () => {
  it("coalesces prewarm and keeps the ready worker for immediate synthesis", async () => {
    const test = harness();
    await Promise.all([test.lifecycle.prewarm(), test.lifecycle.prewarm()]);
    assert.equal(test.starts(), 1);
    assert.equal(test.lifecycle.state(), "ready");
    assert.deepEqual(await test.lifecycle.synthesize("hello", async () => undefined), {
      ...metrics,
      cold: false,
    });
    assert.equal(test.starts(), 1);
  });

  it("fully offloads the worker after the short idle window", async () => {
    const test = harness();
    await test.lifecycle.prewarm();
    test.evict();
    await Promise.resolve();
    assert.equal(test.lifecycle.state(), "offloaded");
    assert.equal(test.closes(), 1);
  });

  it("keeps the offload timer after a redundant elected-device prewarm", async () => {
    const test = harness();
    await test.lifecycle.prewarm();
    await test.lifecycle.prewarm();
    test.evict();
    await Promise.resolve();
    assert.equal(test.lifecycle.state(), "offloaded");
    assert.equal(test.closes(), 1);
  });

  it("keeps the warm worker while attention is active and resumes eviction afterward", async () => {
    const test = harness();
    test.lifecycle.setRetention(true);
    await test.lifecycle.prewarm();
    test.evict();
    await Promise.resolve();
    assert.equal(test.lifecycle.state(), "ready");
    assert.equal(test.closes(), 0);
    test.lifecycle.setRetention(false);
    test.evict();
    await Promise.resolve();
    assert.equal(test.lifecycle.state(), "offloaded");
    assert.equal(test.closes(), 1);
  });

  it("kills synthesis on interruption and permits a clean future warm", async () => {
    let resolveSynthesis: ((value: typeof metrics) => void) | undefined;
    let starts = 0;
    let closes = 0;
    const lifecycle = createPocketLifecycle({
      startWorker: async () => {
        starts += 1;
        return {
          synthesize: () =>
            new Promise<typeof metrics>((resolve) => {
              resolveSynthesis = resolve;
            }),
          close: async () => {
            closes += 1;
            resolveSynthesis?.(metrics);
          },
        };
      },
      schedule: () => () => undefined,
      idleMs: 30_000,
    });
    const controller = new AbortController();
    const pending = lifecycle.synthesize("first", async () => undefined, controller.signal);
    await Promise.resolve();
    controller.abort();
    const failure = await pending.catch((cause: unknown) => cause);
    assert.instanceOf(failure, DOMException);
    assert.equal((failure as DOMException).name, "AbortError");
    assert.equal(closes, 1);
    await lifecycle.prewarm();
    assert.equal(starts, 2);
  });

  it("does not arm idle eviction while a redundant prewarm observes active synthesis", async () => {
    let finish: ((value: typeof metrics) => void) | undefined;
    let scheduled: (() => void) | undefined;
    const lifecycle = createPocketLifecycle({
      startWorker: async () => ({
        synthesize: () => new Promise((resolve) => (finish = resolve)),
        close: async () => undefined,
      }),
      schedule: (_delay, task) => {
        scheduled = task;
        return () => {
          if (scheduled === task) scheduled = undefined;
        };
      },
      idleMs: 30_000,
    });
    const pending = lifecycle.synthesize("hello", async () => undefined);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(lifecycle.state(), "synthesizing");
    await lifecycle.prewarm();
    assert.equal(lifecycle.state(), "synthesizing");
    assert.isUndefined(scheduled);
    finish?.(metrics);
    await pending;
    assert.equal(lifecycle.state(), "ready");
    assert.isDefined(scheduled);
  });

  it("waits for an interrupted warm process to close before starting another", async () => {
    let starts = 0;
    let finishFirstClose: (() => void) | undefined;
    const lifecycle = createPocketLifecycle({
      startWorker: async (signal) => {
        starts += 1;
        if (starts === 1) {
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              void new Promise<void>((resolve) => {
                finishFirstClose = resolve;
              }).then(() => reject(new DOMException("interrupted", "AbortError")));
            });
          });
        }
        return {
          synthesize: async () => metrics,
          close: async () => undefined,
        };
      },
      schedule: () => () => undefined,
      idleMs: 30_000,
    });
    const warming = lifecycle.prewarm().catch(() => undefined);
    await Promise.resolve();
    lifecycle.interrupt();
    const second = lifecycle.prewarm();
    await Promise.resolve();
    assert.equal(starts, 1);
    finishFirstClose?.();
    await warming;
    await second;
    assert.equal(starts, 2);
  });
});
