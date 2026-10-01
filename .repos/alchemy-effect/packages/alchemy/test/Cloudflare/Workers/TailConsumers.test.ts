import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import * as kv from "@distilled.cloud/cloudflare/kv";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as pathe from "pathe";
import { expectUrlContains } from "../Utils/Http.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * Producer: logs on every request so each invocation produces trace events
 * for its tail consumers.
 */
const producerScript = `export default {
  fetch() {
    console.log("alchemy-tail-marker");
    return new Response("producer-ok");
  },
};`;

test.provider(
  "worker with tailConsumers attaches the consumer and delivers traces",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // The consumer is a file-based async Worker exporting a `tail()`
      // handler that persists each trace batch into a KV namespace keyed by
      // the producing script's name — KV makes delivery observable
      // out-of-band, independent of which isolate received the tail event.
      const deployStack = (tails: "attached" | "detached") =>
        Effect.gen(function* () {
          const events = yield* Cloudflare.KV.Namespace("TailEvents");
          const consumer = yield* Cloudflare.Worker("TailConsumer", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/tail/tail-consumer.ts",
            ),
            env: { EVENTS: events },
          });
          const producer = yield* Cloudflare.Worker("TailProducer", {
            script: producerScript,
            tailConsumers: tails === "attached" ? [consumer] : [],
          });
          return { events, consumer, producer };
        });

      const v1 = yield* stack.deploy(deployStack("attached"));

      // The attribute records the consumer by deployed script name.
      expect(v1.producer.tailConsumers).toEqual([
        { service: v1.consumer.workerName },
      ]);

      // Out-of-band: the producer's script settings carry the tail consumer.
      const settings = yield* workers.getScriptScriptAndVersionSetting({
        accountId,
        scriptName: v1.producer.workerName,
      });
      expect(settings.tailConsumers?.map((c) => c.service)).toEqual([
        v1.consumer.workerName,
      ]);

      // Invoke the producer (retrying through workers.dev propagation),
      // then poll KV until a tail batch keyed by the producer's script name
      // arrives. Each poll re-invokes the producer so delivery that begins
      // slightly after the first request still surfaces.
      yield* expectUrlContains(v1.producer.url!, "producer-ok", {
        label: "tail producer",
      });
      const eventKeys = yield* Effect.gen(function* () {
        yield* expectUrlContains(v1.producer.url!, "producer-ok", {
          timeout: "15 seconds",
          label: "tail producer (poll)",
        });
        const keys = yield* kv.listNamespaceKeys({
          accountId,
          namespaceId: v1.events.namespaceId,
          prefix: `evt:${v1.producer.workerName}:`,
        });
        return keys.result.map((k) => k.name);
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (keys): boolean => keys.length > 0,
          times: 18,
        }),
      );
      expect(eventKeys.length).toBeGreaterThan(0);

      // The recorded batch references the producer script.
      const batch = yield* kv
        .getNamespaceValue({
          accountId,
          namespaceId: v1.events.namespaceId,
          keyName: eventKeys[0],
        })
        .pipe(
          Effect.flatMap((res) =>
            Effect.tryPromise(() =>
              new Response(
                Stream.toReadableStream(res.body) as BodyInit,
              ).text(),
            ),
          ),
        );
      expect(batch).toContain(v1.producer.workerName);

      // Detaching every consumer is an in-place update, never a replace.
      const v2 = yield* stack.deploy(deployStack("detached"));
      expect(v2.producer.workerId).toEqual(v1.producer.workerId);
      expect(v2.producer.workerName).toEqual(v1.producer.workerName);
      expect(v2.producer.tailConsumers ?? []).toEqual([]);
      const detached = yield* workers.getScriptScriptAndVersionSetting({
        accountId,
        scriptName: v2.producer.workerName,
      });
      expect(detached.tailConsumers ?? []).toEqual([]);

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(v1.producer.workerName, accountId);
      yield* waitForWorkerToBeDeleted(v1.consumer.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 240_000 },
);
