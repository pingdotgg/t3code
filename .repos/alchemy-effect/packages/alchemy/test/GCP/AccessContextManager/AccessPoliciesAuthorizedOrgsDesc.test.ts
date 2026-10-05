import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as acm from "@distilled.cloud/gcp/accesscontextmanager_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  lastSegment,
  logLevel,
  projectContext,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  acm.getAccessPoliciesAuthorizedOrgsDescs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getAccessPoliciesAuthorizedOrgsDescs on an inaccessible descriptor fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        acm.getAccessPoliciesAuthorizedOrgsDescs({
          name: "accessPolicies/123456789012/authorizedOrgsDescs/alchemy_missing_desc",
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:accesscontextmanager", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an authorized orgs descriptor",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const ctx = yield* projectContext();
      const scopes =
        ctx.projectNumber.length > 0
          ? [`projects/${ctx.projectNumber}`]
          : undefined;
      const organization =
        ctx.organization ??
        (ctx.parent.startsWith("organizations/")
          ? ctx.parent
          : "organizations/123456789012");

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* GCP.AccessContextManager.AccessPolicy(
            "OrgsPolicy",
            {
              title: "authorized orgs policy",
              scopes,
            },
          );
          const desc =
            yield* GCP.AccessContextManager.AccessPoliciesAuthorizedOrgsDesc(
              "Partner",
              {
                policy: policy.name,
                authorizationDirection: "AUTHORIZATION_DIRECTION_FROM",
                assetType: "ASSET_TYPE_DEVICE",
                authorizationType: "AUTHORIZATION_TYPE_TRUST",
                orgs: [organization],
              },
            );
          return { policy, desc };
        }),
      );

      expect(created.desc.name).toContain("/authorizedOrgsDescs/");
      expect(created.desc.policy).toEqual(created.policy.name);
      expect(created.desc.authorizationDirection).toEqual(
        "AUTHORIZATION_DIRECTION_FROM",
      );
      expect(created.desc.assetType).toEqual("ASSET_TYPE_DEVICE");
      expect(created.desc.orgs.map(lastSegment)).toContain(
        lastSegment(organization),
      );

      const fetched = yield* acm.getAccessPoliciesAuthorizedOrgsDescs({
        name: created.desc.name,
      });
      expect(fetched.name).toEqual(created.desc.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* GCP.AccessContextManager.AccessPolicy(
            "OrgsPolicy",
            {
              title: "authorized orgs policy",
              scopes,
            },
          );
          const desc =
            yield* GCP.AccessContextManager.AccessPoliciesAuthorizedOrgsDesc(
              "Partner",
              {
                policy: policy.name,
                authorizedOrgsDescId: created.desc.authorizedOrgsDescId,
                authorizationDirection: "AUTHORIZATION_DIRECTION_FROM",
                assetType: "ASSET_TYPE_DEVICE",
                authorizationType: "AUTHORIZATION_TYPE_TRUST",
                orgs: [organization],
              },
            );
          return { policy, desc };
        }),
      );

      expect(updated.desc.name).toEqual(created.desc.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.desc.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:accesscontextmanager", "live"],
    timeout: 120_000,
  },
);
