import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

const denyRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}`;

/** Deny-all Firestore ruleset the bindings test and release. */
export const DenyAll = GCP.FirebaseRules.Ruleset("Firestore", {
  source: { files: [{ name: "firestore.rules", content: denyRules }] },
});

/** Release pointing at {@link DenyAll} (generated release id). */
export const Live = Effect.gen(function* () {
  const ruleset = yield* DenyAll;
  return yield* GCP.FirebaseRules.Release("Live", {
    rulesetName: ruleset.name,
  });
});

/**
 * Effect-native Cloud Run service exercising every Firebase Rules binding as
 * its own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class FirebaseRulesBindingsHost extends GCP.Function<FirebaseRulesBindingsHost>()(
  "FirebaseRulesBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const testRuleset = yield* GCP.FirebaseRules.TestRuleset(yield* DenyAll);
    const getExecutable = yield* GCP.FirebaseRules.GetReleaseExecutable(
      yield* Live,
    );

    return {
      fetch: serveProbes({
        testRuleset: testRuleset({
          body: {
            testSuite: {
              testCases: [
                {
                  expectation: "DENY",
                  request: {
                    auth: null,
                    path: "/databases/(default)/documents/notes/a",
                    method: "get",
                  },
                },
                {
                  expectation: "ALLOW",
                  request: {
                    auth: null,
                    path: "/databases/(default)/documents/notes/a",
                    method: "get",
                  },
                },
              ],
            },
          },
        }),
        getReleaseExecutable: getExecutable(),
      }),
    };
  }).pipe(
    Effect.provide(GCP.FirebaseRules.TestRulesetHttp),
    Effect.provide(GCP.FirebaseRules.GetReleaseExecutableHttp),
  ),
) {}
