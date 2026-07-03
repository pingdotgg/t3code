import * as NodeServices from "@effect/platform-node/NodeServices";
import fs from "node:fs";

import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { ProviderEventLoggers, ProviderEventLoggersLive } from "./ProviderEventLoggers.ts";

const TestLayer = ProviderEventLoggersLive.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-provider-loggers-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

describe("ProviderEventLoggers", () => {
  it.effect("fans every write from both streams into the shared provider-events.ndjson file", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(TestLayer);
      const loggers = Context.get(context, ProviderEventLoggers);
      const config = Context.get(context, ServerConfig);

      assert.notEqual(loggers.native, undefined);
      assert.notEqual(loggers.canonical, undefined);
      if (!loggers.native || !loggers.canonical) {
        return;
      }

      // The global sink flushes synchronously once its buffer threshold
      // (32 lines) is reached, so writing enough events lets us assert
      // against the file deterministically without racing its periodic
      // background flush timer.
      for (let index = 0; index < 40; index++) {
        yield* loggers.canonical.write({ id: `canonical-evt-${index}` }, ThreadId.make("thread-2"));
      }
      for (let index = 0; index < 40; index++) {
        yield* loggers.native.write({ id: `native-evt-${index}` }, ThreadId.make("thread-1"));
      }

      const lines = fs
        .readFileSync(config.globalProviderEventLogPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      assert.equal(lines.length >= 32, true);
      assert.equal(
        lines.some((line) => line.stream === "canonical"),
        true,
      );
    }).pipe(Effect.scoped),
  );
});
