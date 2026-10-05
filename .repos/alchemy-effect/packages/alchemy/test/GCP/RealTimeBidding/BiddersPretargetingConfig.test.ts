import * as GCP from "@/GCP";
import { PROBE_NAME, PROBE_PARENT } from "@/GCP/RealTimeBidding/internal.ts";
import * as Test from "@/Test/Alchemy";
import * as rtb from "@distilled.cloud/gcp/realtimebidding_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  rtb.getBiddersPretargetingConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const probeCreate = (parent: string) =>
  rtb.createBiddersPretargetingConfigs({
    parent,
    body: { displayName: "alchemy-rtb-probe" },
  });

// Real-time Bidding needs a bidder account and the realtime-bidding OAuth
// scope; the service account profile gets InsufficientScopes. Set
// GCP_TEST_REALTIMEBIDDING_PARENT=bidders/{id} with such credentials.
const parent = process.env.GCP_TEST_REALTIMEBIDDING_PARENT?.trim();
const runLifecycle = !!parent && !process.env.FAST;

test.provider.skipIf(runLifecycle)(
  "getBiddersPretargetingConfigs without the Real-time Bidding scope fails with InsufficientScopes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        rtb.getBiddersPretargetingConfigs({ name: PROBE_NAME }),
      );
      expect(error._tag).toEqual("InsufficientScopes");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:realtimebidding", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "createBiddersPretargetingConfigs without the Real-time Bidding scope fails with InsufficientScopes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(probeCreate(PROBE_PARENT));
      expect(error._tag).toEqual("InsufficientScopes");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:realtimebidding", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a pretargeting config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.RealTimeBidding.BiddersPretargetingConfig(
            "WebHtml",
            {
              parent: parent!,
              displayName: "web-html",
              includedEnvironments: ["WEB"],
              includedFormats: ["HTML"],
            },
          );
        }),
      );

      expect(created.name).toContain("/pretargetingConfigs/");
      expect(created.parent).toEqual(parent);
      expect(created.configId.length).toBeGreaterThan(0);
      expect(created.displayName).toEqual("web-html");
      expect(created.includedEnvironments).toContain("WEB");
      expect(created.includedFormats).toContain("HTML");
      expect(["ACTIVE", "SUSPENDED"]).toContain(created.state);

      const fetched = yield* rtb.getBiddersPretargetingConfigs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("[alchemy ");
      expect(fetched.displayName).toContain("web-html");
      expect(fetched.includedFormats).toContain("HTML");

      const listed = yield* rtb.listBiddersPretargetingConfigs({
        parent: parent!,
        pageSize: 100,
      });
      expect(
        (listed.pretargetingConfigs ?? []).some(
          (row) => row.name === created.name,
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.RealTimeBidding.BiddersPretargetingConfig(
            "WebHtml",
            {
              parent: created.parent,
              configId: created.configId,
              displayName: "web-html-v2",
              includedEnvironments: ["WEB"],
              includedFormats: ["HTML", "NATIVE"],
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("web-html-v2");
      expect(updated.includedFormats).toContain("NATIVE");

      const fetchedUpdate = yield* rtb.getBiddersPretargetingConfigs({
        name: updated.name,
      });
      expect(fetchedUpdate.displayName).toContain("web-html-v2");
      expect(fetchedUpdate.displayName).toContain("[alchemy ");
      expect(fetchedUpdate.includedFormats).toContain("NATIVE");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(updated.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:realtimebidding", "live"],
    timeout: 90_000,
  },
);
