import * as AWS from "@/AWS";
import { JobTemplate } from "@/AWS/EMRContainers";
import { Role } from "@/AWS/IAM";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as emrc from "@distilled.cloud/aws/emr-containers";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the tags the observe/read/delete paths
// depend on. describeJobTemplate on a well-formed nonexistent id must
// surface the typed ResourceNotFoundException; deleteJobTemplate on the
// same id must surface the typed ValidationException the idempotent delete
// path swallows (its typed union has no not-found tag).
test.provider("typed error semantics on a nonexistent job template", () =>
  Effect.gen(function* () {
    const id = "abcdefabcdefabcdefabcdef01";

    const describeError = yield* Effect.flip(emrc.describeJobTemplate({ id }));
    expect(describeError._tag).toBe("ResourceNotFoundException");

    const deleteError = yield* Effect.flip(emrc.deleteJobTemplate({ id }));
    expect(deleteError._tag).toBe("ValidationException");
  }),
);

// Ungated list() probe: proves the pagination + attribute mapping wiring.
test.provider("list returns a well-formed array of job templates", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(JobTemplate);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    for (const jt of all) {
      expect(typeof jt.jobTemplateId).toBe("string");
      expect(typeof jt.jobTemplateName).toBe("string");
      expect(jt.jobTemplateArn).toContain(":/jobtemplates/");
    }
  }),
);

// Full lifecycle — job templates are account-level, free, and provision
// synchronously (no EKS cluster required), so this runs ungated.
test.provider(
  "job template lifecycle: create, tag replace, data replace, destroy",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      const deployTemplate = (
        releaseLabel: string,
        tags: Record<string, string>,
      ) =>
        stack.deploy(
          Effect.gen(function* () {
            const role = yield* Role("JobRole", {
              assumeRolePolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: { Service: "pods.eks.amazonaws.com" },
                    Action: ["sts:AssumeRole", "sts:TagSession"],
                  },
                ],
              },
            });
            return yield* JobTemplate("Template", {
              jobTemplateData: {
                executionRoleArn: role.roleArn,
                releaseLabel,
                jobDriver: {
                  sparkSubmitJobDriver: {
                    entryPoint: "s3://alchemy-test-emrc/scripts/etl.py",
                    sparkSubmitParameters: "--conf spark.executor.instances=1",
                  },
                },
                jobTags: { Origin: "alchemy-test" },
              },
              tags,
            });
          }),
        );

      // 1. CREATE
      const first = yield* deployTemplate("emr-7.5.0-latest", {
        Purpose: "alchemy-emrc-test",
      });
      expect(first.jobTemplateArn).toContain(":/jobtemplates/");

      // Out-of-band verification via distilled.
      const observed = yield* emrc.describeJobTemplate({
        id: first.jobTemplateId,
      });
      expect(observed.jobTemplate?.jobTemplateData.releaseLabel).toBe(
        "emr-7.5.0-latest",
      );
      expect(observed.jobTemplate?.tags?.Purpose).toBe("alchemy-emrc-test");

      // 2. TAG CHANGE — replaces (EMR containers' TagResource rejects job
      // template ARNs with the typed InvalidResourceArn, so tags are
      // create-only and any tag change replaces the template)
      const retagged = yield* deployTemplate("emr-7.5.0-latest", {
        Purpose: "alchemy-emrc-test-updated",
      });
      expect(retagged.jobTemplateId).not.toBe(first.jobTemplateId);
      const retaggedObserved = yield* emrc.describeJobTemplate({
        id: retagged.jobTemplateId,
      });
      expect(retaggedObserved.jobTemplate?.tags?.Purpose).toBe(
        "alchemy-emrc-test-updated",
      );

      // 3. REPLACE — jobTemplateData is immutable, changing it replaces
      const replaced = yield* deployTemplate("emr-7.2.0-latest", {
        Purpose: "alchemy-emrc-test-updated",
      });
      expect(replaced.jobTemplateId).not.toBe(retagged.jobTemplateId);

      // The replaced (old) template is deleted by the engine.
      const oldGone = yield* Effect.flip(
        emrc.describeJobTemplate({ id: retagged.jobTemplateId }),
      );
      expect(oldGone._tag).toBe("ResourceNotFoundException");

      // 4. DESTROY
      yield* stack.destroy();
      const gone = yield* Effect.flip(
        emrc.describeJobTemplate({ id: replaced.jobTemplateId }),
      );
      expect(gone._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 240_000 },
);
