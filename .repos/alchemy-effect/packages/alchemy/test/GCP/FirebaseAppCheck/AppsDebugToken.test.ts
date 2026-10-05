import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as firebaseappcheck from "@distilled.cloud/gcp/firebaseappcheck_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  lifecycleAppId,
  logLevel,
  runLifecycle,
  missingDebugToken,
  waitUntilDebugTokenGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsAppsDebugTokens on a missing token fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const missing = yield* missingDebugToken();
      const error = yield* Effect.flip(
        firebaseappcheck.getProjectsAppsDebugTokens({
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
  "create, update, and delete a debug token",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const app = lifecycleAppId ?? "";

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.FirebaseAppCheck.AppsDebugToken("Local", {
            app,
            displayName: "alchemy-test",
          });
        }),
      );

      expect(created.name).toContain("/debugTokens/");
      expect(created.debugTokenId).toEqual(expect.any(String));
      expect(created.appId).toEqual(expect.any(String));
      expect(created.displayName).toEqual("alchemy-test");
      expect(created.token).toEqual(expect.any(String));
      expect((created.token ?? "").length).toBeGreaterThan(8);

      const fetched = yield* firebaseappcheck.getProjectsAppsDebugTokens({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("[alchemy ");
      expect(fetched.displayName).toContain("alchemy-test");
      expect(fetched.token).toBeFalsy();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.FirebaseAppCheck.AppsDebugToken("Local", {
            app,
            displayName: "alchemy-prod",
            token: created.token,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("alchemy-prod");
      expect(updated.token).toEqual(created.token);

      yield* stack.destroy();

      const gone = yield* waitUntilDebugTokenGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:firebaseappcheck", "live"],
    timeout: 90_000,
  },
);
