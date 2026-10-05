import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";
import { DEFAULT_NETWORK } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const runLifecycle =
  !!process.env.GCP_TEST_COMPUTE_INTERCONNECT && !process.env.FAST;

const region = "us-central1";

const waitUntilGone = (interconnectAttachment: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute
        .getInterconnectAttachments({
          project,
          region,
          interconnectAttachment,
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (status) => status === "gone",
            times: 10,
          }),
        ),
    ),
  );

test.provider(
  "getInterconnectAttachments on a missing attachment fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getInterconnectAttachments({
          project,
          region,
          interconnectAttachment: "alchemy-missing-vlan",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

test.provider(
  "insertInterconnectAttachments with a malformed router fails with BadRequest",
  () =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        compute.insertInterconnectAttachments({
          project,
          region,
          body: {
            name: "alchemy-vlan-probe",
            description: "alchemy entitlement probe",
            router: "does-not-exist",
            type: "PARTNER",
          },
        }),
      );
      expect(error._tag).toEqual("BadRequest");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an interconnect attachment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const router = yield* GCP.Compute.Router("Edge", {
            region,
            network: DEFAULT_NETWORK,
            description: "interconnect router",
          });
          const attachment = yield* GCP.Compute.InterconnectAttachment("Vlan", {
            region,
            router: router.routerName,
            type: "PARTNER",
            description: "partner vlan",
          });
          return { router, attachment };
        }),
      );

      expect(created.attachment.interconnectAttachmentName).toEqual(
        expect.any(String),
      );
      expect(created.attachment.region).toEqual(region);
      expect(created.attachment.description).toEqual("partner vlan");

      const fetched = yield* compute.getInterconnectAttachments({
        project: created.attachment.project,
        region,
        interconnectAttachment: created.attachment.interconnectAttachmentName,
      });
      expect(fetched.name).toEqual(
        created.attachment.interconnectAttachmentName,
      );
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const router = yield* GCP.Compute.Router("Edge", {
            routerName: created.router.routerName,
            region,
            network: DEFAULT_NETWORK,
            description: "interconnect router",
          });
          return yield* GCP.Compute.InterconnectAttachment("Vlan", {
            interconnectAttachmentName:
              created.attachment.interconnectAttachmentName,
            region,
            router: router.routerName,
            type: "PARTNER",
            description: "updated partner vlan",
            adminEnabled: false,
          });
        }),
      );
      expect(updated.description).toEqual("updated partner vlan");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        created.attachment.interconnectAttachmentName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
