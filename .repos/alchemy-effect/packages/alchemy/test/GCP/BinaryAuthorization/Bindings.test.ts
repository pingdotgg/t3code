import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import {
  currentProject,
  TEST_ATTESTATION,
  TEST_POD,
  TEST_RESOURCE_URI,
} from "./common.ts";
import BinaryAuthorizationBindingsHost, {
  GkePolicy,
  Verifier,
  Viewed,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(
  testOptions,
  "BinaryAuthorizationBindings",
);

let baseUrl: string;
let hostAccount: string;
let viewed: { name: string; noteReference: string };
let verifier: { name: string; noteReference: string };
let policyName: string;

/** Every project-level role (and its IAM Condition) `account` holds. */
const projectGrantsOf = (account: string) =>
  Effect.gen(function* () {
    const project = yield* currentProject;
    const policy = yield* resourcemanager.getIamPolicyProjects({
      resource: `projects/${project}`,
      body: { options: { requestedPolicyVersion: 3 } },
    });
    return (policy.bindings ?? [])
      .filter((binding) =>
        (binding.members ?? []).includes(`serviceAccount:${account}`),
      )
      .map((binding) => ({
        role: binding.role,
        condition: binding.condition?.expression,
      }))
      .sort((left, right) => (left.role ?? "").localeCompare(right.role ?? ""));
  });

/** Platform policies have no resource-level IAM: both roles sit on the project. */
const PROJECT_GRANTS = [
  {
    role: "roles/binaryauthorization.policyEvaluator",
    condition: undefined,
  },
  { role: "roles/binaryauthorization.policyViewer", condition: undefined },
];

/** Roles `account` holds on an attestor's own IAM policy. */
const attestorRolesOf = (attestor: string, account: string) =>
  binaryauthorization
    .getIamPolicyProjectsAttestors({
      resource: attestor,
      "options.requestedPolicyVersion": 3,
    })
    .pipe(
      Effect.map((policy) =>
        (policy.bindings ?? [])
          .filter((binding) =>
            (binding.members ?? []).includes(`serviceAccount:${account}`),
          )
          .map((binding) => binding.role),
      ),
    );

describe.skipIf(!dockerAvailable)(
  "BinaryAuthorization Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:binaryauthorization",
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
            const host = yield* BinaryAuthorizationBindingsHost;
            const viewedAttestor = yield* Viewed;
            const verifierAttestor = yield* Verifier;
            const policy = yield* GkePolicy;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              viewed: {
                name: viewedAttestor.name,
                noteReference: viewedAttestor.noteReference,
              },
              verifier: {
                name: verifierAttestor.name,
                noteReference: verifierAttestor.noteReference,
              },
              policy: policy.name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        viewed = out.viewed;
        verifier = out.verifier;
        policyName = out.policy;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("GetAttestor", () => {
      test.provider(
        "reads the attestor as the host's service account, granted on the attestor only",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<{
              name?: string;
              userOwnedGrafeasNote?: { noteReference?: string };
            }>(baseUrl, "getAttestor");
            expect(live.name).toEqual(viewed.name);
            expect(live.userOwnedGrafeasNote?.noteReference).toEqual(
              viewed.noteReference,
            );

            expect(yield* attestorRolesOf(viewed.name, hostAccount)).toEqual([
              "roles/binaryauthorization.attestorsViewer",
            ]);
            expect(yield* projectGrantsOf(hostAccount)).toEqual(PROJECT_GRANTS);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:binaryauthorization", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ValidateAttestation", () => {
      test.provider(
        "validates against the attestor as the host's service account, granted on the attestor only",
        (_stack) =>
          Effect.gen(function* () {
            const result = yield* expectProbe<{ result?: string }>(
              baseUrl,
              "validateAttestation",
            );
            // The attestor has no public keys, so nothing can verify.
            expect(result.result).toEqual("ATTESTATION_NOT_VERIFIABLE");
            const expected =
              yield* binaryauthorization.validateAttestationOccurrenceProjectsAttestors(
                {
                  attestor: verifier.name,
                  body: {
                    occurrenceResourceUri: TEST_RESOURCE_URI,
                    occurrenceNote: verifier.noteReference,
                    attestation: TEST_ATTESTATION,
                  },
                },
              );
            expect(result.result).toEqual(expected.result);

            expect(yield* attestorRolesOf(verifier.name, hostAccount)).toEqual([
              "roles/binaryauthorization.attestorsVerifier",
            ]);
            expect(yield* projectGrantsOf(hostAccount)).toEqual(PROJECT_GRANTS);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:binaryauthorization", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetPlatformsPolicy", () => {
      test.provider(
        "reads the platform policy as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<{ name?: string; etag?: string }>(
              baseUrl,
              "getPlatformsPolicy",
            );
            const expected =
              yield* binaryauthorization.getProjectsPlatformsPolicies({
                name: policyName,
              });
            expect(live.name).toEqual(policyName);
            expect(live.etag).toEqual(expected.etag);
            expect(yield* projectGrantsOf(hostAccount)).toEqual(PROJECT_GRANTS);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:binaryauthorization", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("EvaluateGkePolicy", () => {
      test.provider(
        "evaluates a pod against the platform policy as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<{ verdict?: string }>(
              baseUrl,
              "evaluateGkePolicy",
            );
            const expected =
              yield* binaryauthorization.evaluateProjectsPlatformsGkePolicies({
                name: policyName,
                body: { resource: TEST_POD },
              });
            expect(live.verdict).toEqual(expected.verdict);
            expect(live.verdict).toEqual(expect.any(String));
            expect(yield* projectGrantsOf(hostAccount)).toEqual(PROJECT_GRANTS);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:binaryauthorization", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
