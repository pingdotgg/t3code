import * as GCP from "@/GCP";
import { makeObjectMedia } from "@/GCP/Storage/ObjectMedia.ts";
import * as Test from "@/Test/Alchemy";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as eventarc from "@distilled.cloud/gcp/eventarc_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { spawnSync } from "node:child_process";
import EventarcService, {
  Drops,
  Markers,
  markerFor,
} from "./fixtures/eventarc-service.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const dockerAvailable = (() => {
  try {
    return (
      spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 })
        .status === 0
    );
  } catch {
    return false;
  }
})();

test.provider.skipIf(!dockerAvailable)(
  "Eventarc routes Storage finalize events to an effect-native Function",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        const service = yield* EventarcService;
        const drops = yield* Drops;
        const markers = yield* Markers;
        return {
          project: service.project,
          serviceAccount: service.serviceAccount,
          drops: drops.bucketName,
          markers: markers.bucketName,
        };
      });
      yield* stack.deploy(program);
      // A second deploy re-syncs the host's IAM; the event receiver grant
      // must survive it (it once was revoked as out-of-band).
      const out = yield* stack.deploy(program);
      const projectPolicy = yield* resourcemanager.getIamPolicyProjects({
        resource: `projects/${out.project}`,
      });
      expect(
        (projectPolicy.bindings ?? []).some(
          (binding) =>
            binding.role === "roles/eventarc.eventReceiver" &&
            (binding.members ?? []).includes(
              `serviceAccount:${out.serviceAccount}`,
            ),
        ),
      ).toEqual(true);

      const triggers = yield* eventarc.listProjectsLocationsTriggers({
        parent: `projects/${out.project}/locations/us-central1`,
      });
      const trigger = (triggers.triggers ?? []).find(
        (item) =>
          item.destination?.cloudRun?.path === "/__alchemy/eventarc/drops" &&
          item.labels?.["alchemy-stack"] !== undefined,
      );
      expect(trigger?.name).toEqual(expect.any(String));
      expect(
        Object.values(trigger?.conditions ?? {}).every(
          (condition) =>
            condition?.code === undefined || condition.code === "OK",
        ),
      ).toEqual(true);

      // Deploy returns only after the trigger reports healthy, so an
      // upload now is delivered.
      const media = yield* makeObjectMedia;
      yield* media.upload(out.drops, {
        name: "drop/hello.txt",
        body: "eventarc!",
      });
      const marker = yield* media
        .download({ bucket: out.markers, object: markerFor("drop/hello.txt") })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "GCP.Storage.ObjectNotFound",
            schedule: Schedule.spaced("5 seconds"),
            times: 48,
          }),
        );
      const event = JSON.parse(new TextDecoder().decode(marker.body));
      expect(event.type).toEqual("google.cloud.storage.object.v1.finalized");
      expect(event.bucket).toEqual(out.drops);
      expect(event.name).toEqual("drop/hello.txt");
      expect(event.subject).toEqual("objects/drop/hello.txt");

      yield* stack.destroy();

      const after = yield* eventarc.listProjectsLocationsTriggers({
        parent: `projects/${out.project}/locations/us-central1`,
      });
      expect(
        (after.triggers ?? []).some((item) => item.name === trigger?.name),
      ).toEqual(false);
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:eventarc", "live"], timeout: 900_000 },
);
