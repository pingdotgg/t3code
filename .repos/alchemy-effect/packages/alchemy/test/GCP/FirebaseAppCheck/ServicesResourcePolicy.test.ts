import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as firebaseappcheck from "@distilled.cloud/gcp/firebaseappcheck_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  runLifecycle,
  missingResourcePolicy,
  waitUntilResourcePolicyGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsServicesResourcePolicies on a missing policy fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const missing = yield* missingResourcePolicy();
      const error = yield* Effect.flip(
        firebaseappcheck.getProjectsServicesResourcePolicies({
          name: missing,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:firebaseappcheck", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a resource policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.FirebaseAppCheck.ServicesResourcePolicy(
            "IosOauth",
            { enforcementMode: "UNENFORCED" },
          );
        }),
      );

      expect(created.name).toContain("/resourcePolicies/");
      expect(created.resourcePolicyId).toEqual(expect.any(String));
      expect(created.serviceId).toEqual("oauth2.googleapis.com");
      expect(created.enforcementMode).toEqual("UNENFORCED");
      expect(created.targetResource).toContain("/oauthClients/alc-");

      const fetched =
        yield* firebaseappcheck.getProjectsServicesResourcePolicies({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.enforcementMode).toEqual("UNENFORCED");
      expect(fetched.targetResource).toEqual(created.targetResource);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.FirebaseAppCheck.ServicesResourcePolicy(
            "IosOauth",
            {
              targetResource: created.targetResource,
              enforcementMode: "OFF",
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.enforcementMode).toEqual("OFF");
      expect(updated.targetResource).toEqual(created.targetResource);

      yield* stack.destroy();

      const gone = yield* waitUntilResourcePolicyGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:firebaseappcheck", "live"],
    timeout: 90_000,
  },
);
