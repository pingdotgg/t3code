import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as androidenterprise from "@distilled.cloud/gcp/androidenterprise_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  enterpriseId,
  logLevel,
  probeEnterpriseId,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (accountId: string, pageId: string, clusterId: string) =>
  androidenterprise
    .getStorelayoutclusters({
      enterpriseId: accountId,
      pageId,
      clusterId,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!runLifecycle)(
  "getStorelayoutclusters on a missing cluster fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidenterprise.getStorelayoutclusters({
          enterpriseId: probeEnterpriseId,
          pageId: "alchemy-missing-page",
          clusterId: "alchemy-missing-cluster",
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidenterprise", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "insertStorelayoutclusters without the EMM OAuth scope fails with InsufficientAuthenticationScopes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidenterprise.insertStorelayoutclusters({
          enterpriseId: probeEnterpriseId,
          pageId: "alchemy-missing-page",
          body: {
            name: [{ locale: "en-US", text: "Alchemy Probe Cluster" }],
          },
        }),
      );
      expect(error._tag).toEqual("InsufficientAuthenticationScopes");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidenterprise", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a store layout cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const page = yield* GCP.AndroidEnterprise.Storelayoutpage("Home", {
            enterpriseId: enterpriseId!,
            name: [{ locale: "en-US", text: "Home" }],
          });
          const cluster = yield* GCP.AndroidEnterprise.Storelayoutcluster(
            "Apps",
            {
              enterpriseId: page.enterpriseId,
              pageId: page.pageId,
              name: [{ locale: "en-US", text: "Work apps" }],
            },
          );
          return { page, cluster };
        }),
      );

      expect(created.cluster.clusterId.length).toBeGreaterThan(0);
      expect(created.cluster.pageId).toEqual(created.page.pageId);
      expect(created.cluster.name?.[0]?.text).toEqual("Work apps");

      const fetched = yield* androidenterprise.getStorelayoutclusters({
        enterpriseId: created.cluster.enterpriseId,
        pageId: created.cluster.pageId,
        clusterId: created.cluster.clusterId,
      });
      expect(fetched.id).toEqual(created.cluster.clusterId);
      expect(fetched.name?.[0]?.text).toEqual("Work apps");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const page = yield* GCP.AndroidEnterprise.Storelayoutpage("Home", {
            enterpriseId: created.page.enterpriseId,
            pageId: created.page.pageId,
            name: [{ locale: "en-US", text: "Home" }],
          });
          const cluster = yield* GCP.AndroidEnterprise.Storelayoutcluster(
            "Apps",
            {
              enterpriseId: page.enterpriseId,
              pageId: page.pageId,
              clusterId: created.cluster.clusterId,
              name: [{ locale: "en-US", text: "Featured apps" }],
            },
          );
          return { page, cluster };
        }),
      );

      expect(updated.cluster.clusterId).toEqual(created.cluster.clusterId);
      expect(updated.cluster.name?.[0]?.text).toEqual("Featured apps");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.cluster.enterpriseId,
        created.cluster.pageId,
        created.cluster.clusterId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:androidenterprise", "live"],
    timeout: 90_000,
  },
);
