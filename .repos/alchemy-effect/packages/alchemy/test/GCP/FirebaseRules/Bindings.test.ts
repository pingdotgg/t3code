import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as firebaserules from "@distilled.cloud/gcp/firebaserules_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import FirebaseRulesBindingsHost, {
  DenyAll,
  Live,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "FirebaseRulesBindings");

let baseUrl: string;
let rulesetName: string;
let releaseName: string;
let hostAccount: string;

/** Roles the host's service account holds on the project, by condition. */
const hostProjectRoles = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const policy = yield* resourcemanager.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  return (policy.bindings ?? [])
    .filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    )
    .map((binding) => ({
      role: binding.role,
      condition: binding.condition?.expression,
    }));
});

describe.skipIf(!dockerAvailable)(
  "FirebaseRules Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:firebaserules",
      "provider:gcp:run",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* FirebaseRulesBindingsHost;
            const ruleset = yield* DenyAll;
            const release = yield* Live;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              ruleset: ruleset.name,
              release: release.name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        rulesetName = out.ruleset;
        releaseName = out.release;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("TestRuleset", () => {
      test.provider(
        "evaluates the deployed ruleset as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<firebaserules.TestRulesetResponse>(
              baseUrl,
              "testRuleset",
            );
            expect(out.issues ?? []).toEqual([]);
            // deny-all: the DENY expectation holds, the ALLOW one fails.
            expect(
              (out.testResults ?? []).map((result) => result.state),
            ).toEqual(["SUCCESS", "FAILURE"]);

            // Firebase Rules has no resource-level IAM: project grant.
            const roles = yield* hostProjectRoles;
            expect(roles).toEqual([
              { role: "roles/firebaserules.admin", condition: undefined },
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:firebaserules", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetReleaseExecutable", () => {
      test.provider(
        "reads the release's compiled executable as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const out =
              yield* expectProbe<firebaserules.GetReleaseExecutableResponse>(
                baseUrl,
                "getReleaseExecutable",
              );
            expect(out.rulesetName).toEqual(rulesetName);
            expect((out.executable ?? "").length).toBeGreaterThan(0);

            const direct = yield* firebaserules.getExecutableProjectsReleases({
              name: releaseName,
            });
            expect(out.rulesetName).toEqual(direct.rulesetName);
            expect(out.executableVersion).toEqual(direct.executableVersion);

            const roles = yield* hostProjectRoles;
            expect(roles).toEqual([
              { role: "roles/firebaserules.admin", condition: undefined },
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:firebaserules", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
