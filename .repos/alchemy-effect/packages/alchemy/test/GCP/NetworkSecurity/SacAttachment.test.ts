import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// An attachment needs a SAC realm already paired with its SSE partner
// (Palo Alto Prisma Access / Symantec), which happens outside GCP. Set
// GCP_TEST_SAC_PARTNER_REALM to the full resource name of such a realm to
// run the lifecycle. The NCC gateway spoke it needs takes well over 5
// minutes to provision.
const partnerRealm = process.env.GCP_TEST_SAC_PARTNER_REALM;
const runLifecycle =
  !!partnerRealm && !!process.env.GCP_TEST_SLOW && !process.env.FAST;

const waitUntilGone = (name: string) =>
  networksecurity.getProjectsLocationsSacAttachments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsSacAttachments on a missing attachment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networksecurity.getProjectsLocationsSacAttachments({
          name: `projects/${project}/locations/us-central1/sacAttachments/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);

// GCP validates the gateway before the realm, so proving the typed
// unpaired-realm rejection needs a real NCC gateway spoke (slow).
test.provider.skipIf(!process.env.GCP_TEST_SLOW || !!process.env.FAST)(
  "createProjectsLocationsSacAttachments on an unpaired realm fails with SacRealmNotPaired",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const { realm, gateway } = yield* stack.deploy(
        Effect.gen(function* () {
          const hub = yield* GCP.NetworkConnectivity.Hub("ProbeMesh", {
            description: "sac unpaired probe hub",
          });
          const gateway = yield* GCP.NetworkConnectivity.Spoke("ProbeGateway", {
            location: "us-central1",
            hub: hub.name,
            gateway: {
              capacity: "CAPACITY_1_GBPS",
              ipRangeReservations: [{ ipRange: "10.22.0.0/23" }],
            },
          });
          const realm = yield* GCP.NetworkSecurity.SacRealm("Unpaired", {
            securityService: "PALO_ALTO_PRISMA_ACCESS",
          });
          return { realm, gateway };
        }),
      );

      const error = yield* Effect.flip(
        networksecurity.createProjectsLocationsSacAttachments({
          parent: `projects/${project}/locations/us-central1`,
          sacAttachmentId: "alchemy-unpaired-probe",
          body: { sacRealm: realm.name, nccGateway: gateway.name },
        }),
      );
      expect(error._tag).toEqual("SacRealmNotPaired");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 2_400_000,
    retry: 0,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a sac attachment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const hub = yield* GCP.NetworkConnectivity.Hub("Mesh", {
            description: "sac hub",
          });
          const gateway = yield* GCP.NetworkConnectivity.Spoke("Gateway", {
            location: "us-central1",
            hub: hub.name,
            gateway: {
              capacity: "CAPACITY_1_GBPS",
              ipRangeReservations: [{ ipRange: "10.20.0.0/23" }],
            },
          });
          const attachment = yield* GCP.NetworkSecurity.SacAttachment(
            "PrismaLink",
            {
              location: "us-central1",
              sacRealm: partnerRealm!,
              nccGateway: gateway.name,
              labels: { env: "test" },
            },
          );
          return { hub, gateway, attachment };
        }),
      );

      expect(created.attachment.name).toContain("/sacAttachments/");
      expect(created.attachment.location).toEqual("us-central1");
      expect(created.attachment.labels).toMatchObject({ env: "test" });
      expect(created.attachment.sacRealm).toContain(
        partnerRealm!.split("/").pop()!,
      );

      const fetched = yield* networksecurity.getProjectsLocationsSacAttachments(
        {
          name: created.attachment.name,
        },
      );
      expect(fetched.name).toEqual(created.attachment.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.attachment.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 1_200_000,
    retry: 0,
  },
);
