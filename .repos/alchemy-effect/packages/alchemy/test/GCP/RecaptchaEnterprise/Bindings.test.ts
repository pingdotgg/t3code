import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as recaptchaenterprise from "@distilled.cloud/gcp/recaptchaenterprise_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import RecaptchaBindingsHost, { Signup } from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RecaptchaBindings");

let baseUrl: string;
let hostAccount: string;
let project: string;
let keyName: string;
let keyId: string;

describe.skipIf(!dockerAvailable)(
  "RecaptchaEnterprise Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:recaptchaenterprise",
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
            const host = yield* RecaptchaBindingsHost;
            const key = yield* Signup;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              name: key.name,
              keyId: key.keyId,
              project: key.project,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        keyName = out.name;
        keyId = out.keyId;
        project = out.project;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("CreateAssessment", () => {
      test.provider(
        "assesses a token against the key as the host's service account, granted recaptchaenterprise.agent on the project",
        (_stack) =>
          Effect.gen(function* () {
            const assessment =
              yield* expectProbe<recaptchaenterprise.GoogleCloudRecaptchaenterpriseV1Assessment>(
                baseUrl,
                "createAssessment",
              );
            expect(assessment.name).toEqual(
              expect.stringContaining("/assessments/"),
            );
            expect(assessment.event?.siteKey).toEqual(keyId);
            expect(assessment.event?.expectedAction).toEqual("login");
            // The token is not a real reCAPTCHA token.
            expect(assessment.tokenProperties?.valid).toEqual(false);

            // The assessment exists server-side: annotating it succeeds.
            yield* recaptchaenterprise.annotateProjectsAssessments({
              name: assessment.name ?? "",
              body: { annotation: "LEGITIMATE" },
            });

            // reCAPTCHA keys have no IAM policy of their own.
            const policy = yield* crm.getIamPolicyProjects({
              resource: `projects/${project}`,
              body: { options: { requestedPolicyVersion: 3 } },
            });
            const roles = (policy.bindings ?? [])
              .filter((binding) =>
                (binding.members ?? []).includes(
                  `serviceAccount:${hostAccount}`,
                ),
              )
              .map((binding) => ({
                role: binding.role,
                condition: binding.condition,
              }));
            expect(roles).toEqual([
              { role: "roles/recaptchaenterprise.agent", condition: undefined },
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:recaptchaenterprise", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
