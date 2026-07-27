import * as AWS from "@/AWS";
import { Blueprint, DataAutomationProject } from "@/AWS/BedrockDataAutomation";
import * as Test from "@/Test/Alchemy";
import * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const unredact = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const documentStandardOutput = (
  granularity: bda.DocumentExtractionGranularityType[],
): bda.StandardOutputConfiguration => ({
  document: {
    extraction: {
      granularity: { types: granularity },
      boundingBox: { state: "DISABLED" },
    },
    generativeField: { state: "DISABLED" },
    outputFormat: {
      textFormat: { types: ["MARKDOWN"] },
      additionalFileFormat: { state: "DISABLED" },
    },
  },
});

const findProject = (projectArn: string) =>
  bda.getDataAutomationProject({ projectArn }).pipe(
    Effect.map((r) => r.project),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

class ProjectStillExists extends Data.TaggedError("ProjectStillExists")<{
  readonly projectArn: string;
}> {}

const assertProjectDeleted = (projectArn: string) =>
  findProject(projectArn).pipe(
    Effect.flatMap((project) =>
      project === undefined
        ? Effect.void
        : Effect.fail(new ProjectStillExists({ projectArn })),
    ),
    Effect.retry({
      while: (e) => e._tag === "ProjectStillExists",
      schedule: Schedule.max([Schedule.exponential(1000), Schedule.recurs(8)]),
    }),
  );

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getDataAutomationProject on a nonexistent ARN fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { Account } = yield* sts.getCallerIdentity({});
      const region = yield* Effect.sync(
        () => process.env.AWS_REGION ?? "us-west-2",
      );
      const error = yield* Effect.flip(
        bda.getDataAutomationProject({
          projectArn: `arn:aws:bedrock:${region}:${Account}:data-automation-project/nonexistent-alchemy-probe`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "create, update configuration, delete project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const project = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DataAutomationProject("TestProject", {
            projectDescription: "alchemy test project",
            standardOutputConfiguration: documentStandardOutput([
              "DOCUMENT",
              "PAGE",
            ]),
            tags: { Environment: "test" },
          });
        }),
      );

      expect(project.projectArn).toContain(":data-automation-project/");
      expect(project.status).toBe("COMPLETED");

      // out-of-band verification via distilled
      const created = yield* findProject(project.projectArn);
      expect(created).toBeDefined();
      expect(unredact(created!.projectName)).toBe(project.projectName);
      expect(unredact(created!.projectDescription ?? "")).toBe(
        "alchemy test project",
      );
      expect(
        created!.standardOutputConfiguration?.document?.extraction?.granularity
          ?.types,
      ).toEqual(["DOCUMENT", "PAGE"]);
      const tags = yield* bda
        .listTagsForResource({ resourceARN: project.projectArn })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries((r.tags ?? []).map((t) => [t.key, t.value])),
          ),
        );
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("TestProject");

      // update the description + granularity in place — same physical project
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DataAutomationProject("TestProject", {
            projectDescription: "alchemy test project v2",
            standardOutputConfiguration: documentStandardOutput([
              "DOCUMENT",
              "PAGE",
              "ELEMENT",
            ]),
            tags: { Environment: "test" },
          });
        }),
      );
      expect(updated.projectArn).toBe(project.projectArn);

      const afterUpdate = yield* findProject(project.projectArn);
      expect(unredact(afterUpdate!.projectDescription ?? "")).toBe(
        "alchemy test project v2",
      );
      expect(
        afterUpdate!.standardOutputConfiguration?.document?.extraction
          ?.granularity?.types,
      ).toEqual(["DOCUMENT", "PAGE", "ELEMENT"]);

      yield* stack.destroy();
      yield* assertProjectDeleted(project.projectArn);
    }),
  { timeout: 240_000 },
);

test.provider(
  "project with custom output driven by a blueprint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { blueprint, project } = yield* stack.deploy(
        Effect.gen(function* () {
          const blueprint = yield* Blueprint("CustomBlueprint", {
            type: "DOCUMENT",
            schema: JSON.stringify({
              $schema: "http://json-schema.org/draft-07/schema#",
              description: "Extract receipt fields",
              class: "receipt",
              type: "object",
              definitions: {},
              properties: {
                total_amount: {
                  type: "string",
                  inferenceType: "explicit",
                  instruction: "The total amount on the receipt",
                },
              },
            }),
          });
          const project = yield* DataAutomationProject("CustomProject", {
            standardOutputConfiguration: documentStandardOutput(["DOCUMENT"]),
            customOutputConfiguration: {
              blueprints: [{ blueprintArn: blueprint.blueprintArn }],
            },
          });
          return { blueprint, project };
        }),
      );

      expect(project.status).toBe("COMPLETED");

      // out-of-band: the project references the blueprint
      const observed = yield* findProject(project.projectArn);
      expect(
        observed?.customOutputConfiguration?.blueprints?.map(
          (b) => b.blueprintArn,
        ),
      ).toEqual([blueprint.blueprintArn]);

      yield* stack.destroy();
      yield* assertProjectDeleted(project.projectArn);
    }),
  { timeout: 240_000 },
);
