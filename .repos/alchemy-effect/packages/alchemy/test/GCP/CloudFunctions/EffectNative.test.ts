import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudfunctions from "@distilled.cloud/gcp/cloudfunctions_v2";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import EffectFunction, { Marker, Pings } from "./fixtures/effect-function.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class NotReady extends Data.TaggedError("NotReady")<{ status: number }> {}

test.provider.skipIf(!!process.env.FAST)(
  "effect-native function serves fetch with bindings and consumes a topic",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* EffectFunction;
          const bucket = yield* Marker;
          const topic = yield* Pings;
          // Let the test call the function without an identity token.
          yield* GCP.IAM.Member("PublicInvoker", {
            kind: "run.service",
            name: fn.service.as<string>(),
            role: "roles/run.invoker",
            member: "allUsers",
          });
          return {
            name: fn.name,
            url: fn.url,
            project: fn.project,
            runtime: fn.runtime,
            entryPoint: fn.entryPoint,
            serviceAccount: fn.serviceAccountEmail,
            managed: fn.managedServiceAccount,
            bucket: bucket.bucketName,
            topic: topic.name,
          };
        }),
      );

      expect(out.runtime).toEqual("nodejs22");
      expect(out.entryPoint).toEqual("handler");
      expect(out.managed).toEqual(true);

      // fetch runs the Effect program with its Storage bindings.
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(out.url!).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new NotReady({ status: response.status })),
        ),
        Effect.retry({
          while: (error) => error._tag === "NotReady",
          schedule: Schedule.spaced("5 seconds"),
          times: 18,
        }),
      );
      const body = (yield* response.json) as { read: string; node: string };
      expect(body.read).toEqual("from-function");
      expect(body.node).toMatch(/^22\./);

      // A published message is pushed to the function and recorded.
      const published = yield* pubsub.publishProjectsTopics({
        topic: out.topic,
        body: { messages: [{ data: btoa("ping!") }] },
      });
      const messageId = published.messageIds?.[0];
      expect(messageId).toEqual(expect.any(String));
      const marker = yield* storage
        .getObjects({ bucket: out.bucket, object: `ping-${messageId}.txt` })
        .pipe(
          Effect.map((object) => object.size),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (size) => size !== undefined,
            times: 24,
          }),
        );
      expect(marker).toEqual("5");

      yield* stack.destroy();

      const gone = yield* cloudfunctions
        .getProjectsLocationsFunctions({ name: out.name })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
      expect(gone).toEqual("gone");
      const saGone = yield* iam
        .getProjectsServiceAccounts({
          name: `projects/${out.project}/serviceAccounts/${out.serviceAccount}`,
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
      expect(saGone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudfunctions", "live"],
    timeout: 900_000,
  },
);
