import * as AWS from "@/AWS";
import { Project } from "@/AWS/CodeBuild/Project.ts";
import {
  normalizePolicyDocument,
  type PolicyDocument,
} from "@/AWS/IAM/Policy.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const projectName = "alchemy-test-codebuild-project";

const buildspec = [
  "version: 0.2",
  "phases:",
  "  build:",
  "    commands:",
  "      - echo Hello from CodeBuild",
].join("\n");

const codebuildRole = (logical: string) =>
  AWS.IAM.Role(logical, {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "codebuild.amazonaws.com" },
          Action: ["sts:AssumeRole"],
        },
      ],
    },
    inlinePolicies: {
      Logs: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "logs:CreateLogGroup",
              "logs:CreateLogStream",
              "logs:PutLogEvents",
            ],
            Resource: ["*"],
          },
        ],
      },
    },
  });

const getProject = codebuild
  .batchGetProjects({ names: [projectName] })
  .pipe(Effect.map((res) => res.projects?.[0]));

class CodeBuildRoleNotReady extends Data.TaggedError("CodeBuildRoleNotReady")<{
  readonly buildId: string;
  readonly message: string;
}> {}

test.provider(
  "lifecycle: create NO_SOURCE project, update, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create — a NO_SOURCE project with an inline buildspec. Defining a
      // project is instant; no build is run.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* codebuildRole("ProjectRole");
          return yield* Project("LifecycleProject", {
            projectName,
            serviceRole: role.roleArn,
            source: { type: "NO_SOURCE", buildspec },
            environment: {
              image: "aws/codebuild/amazonlinux2-x86_64-standard:5.0",
              computeType: "BUILD_GENERAL1_SMALL",
              environmentVariables: [{ name: "STAGE", value: "dev" }],
            },
          });
        }),
      );
      expect(deployed.projectArn).toContain(`project/${projectName}`);

      // Out-of-band verification via distilled.
      const created = yield* getProject;
      expect(created?.name).toBe(projectName);
      expect(created?.source?.type).toBe("NO_SOURCE");
      expect(created?.environment?.computeType).toBe("BUILD_GENERAL1_SMALL");
      expect(
        created?.environment?.environmentVariables?.find(
          (v) => v.name === "STAGE",
        )?.value,
      ).toBe("dev");

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(Project);
      const all = yield* provider.list();
      expect(all.some((p) => p.projectName === projectName)).toBe(true);

      // Update — change an env var and timeout in place (no replacement),
      // and attach a typed PolicyDocument resource policy sharing the
      // project with this account's root principal.
      const identity = yield* sts.getCallerIdentity({});
      const resourcePolicy: PolicyDocument = {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "Share",
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${identity.Account}:root` },
            Action: ["codebuild:BatchGetProjects"],
            Resource: deployed.projectArn,
          },
        ],
      };
      const updateProject = Effect.gen(function* () {
        const role = yield* codebuildRole("ProjectRole");
        return yield* Project("LifecycleProject", {
          projectName,
          serviceRole: role.roleArn,
          source: { type: "NO_SOURCE", buildspec },
          environment: {
            image: "aws/codebuild/amazonlinux2-x86_64-standard:5.0",
            computeType: "BUILD_GENERAL1_MEDIUM",
            environmentVariables: [{ name: "STAGE", value: "prod" }],
          },
          timeout: "30 minutes",
          resourcePolicy,
        });
      });
      yield* stack.deploy(updateProject);
      const updated = yield* getProject;
      expect(updated?.environment?.computeType).toBe("BUILD_GENERAL1_MEDIUM");
      expect(
        updated?.environment?.environmentVariables?.find(
          (v) => v.name === "STAGE",
        )?.value,
      ).toBe("prod");
      expect(updated?.timeoutInMinutes).toBe(30);

      // The PolicyDocument round-trips through the wire as a string that
      // normalizes back to exactly the desired document.
      const readPolicy = codebuild
        .getResourcePolicy({ resourceArn: deployed.projectArn })
        .pipe(
          Effect.map((res) => res.policy),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      const attached = yield* readPolicy;
      expect(attached).toBeDefined();
      expect(normalizePolicyDocument(attached!)).toBe(
        normalizePolicyDocument(resourcePolicy),
      );

      // Re-deploy the identical PolicyDocument — the drift comparison is on
      // normalized documents, so this converges cleanly as a no-op and the
      // policy is unchanged.
      yield* stack.deploy(updateProject);
      const afterRedeploy = yield* readPolicy;
      expect(normalizePolicyDocument(afterRedeploy!)).toBe(
        normalizePolicyDocument(resourcePolicy),
      );

      // Drop the resourcePolicy prop — reconcile deletes the attached policy.
      yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* codebuildRole("ProjectRole");
          return yield* Project("LifecycleProject", {
            projectName,
            serviceRole: role.roleArn,
            source: { type: "NO_SOURCE", buildspec },
            environment: {
              image: "aws/codebuild/amazonlinux2-x86_64-standard:5.0",
              computeType: "BUILD_GENERAL1_MEDIUM",
              environmentVariables: [{ name: "STAGE", value: "prod" }],
            },
            timeout: "30 minutes",
          });
        }),
      );
      const afterRemoval = yield* readPolicy;
      expect(afterRemoval === undefined || afterRemoval === "").toBe(true);

      // Destroy — project is deleted; verify it is gone out-of-band.
      yield* stack.destroy();
      const after = yield* getProject;
      expect(after).toBeUndefined();
    }),
  { timeout: 300_000 },
);

// Exercise the StartBuild + BatchGetBuilds path end-to-end against a
// NO_SOURCE project. Lambda compute keeps this within the regular test budget.
test.provider(
  "NO_SOURCE build runs to SUCCEEDED",
  (stack) => {
    const buildIds: string[] = [];
    return Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* codebuildRole("BuildRole");
          return yield* Project("BuildProject", {
            projectName: `${projectName}-run`,
            serviceRole: role.roleArn,
            source: { type: "NO_SOURCE", buildspec },
            environment: {
              image: "aws/codebuild/amazonlinux2-x86_64-standard:5.0",
              computeType: "BUILD_GENERAL1_SMALL",
            },
            // This smoke build does not consume its logs. Disabling both log
            // destinations removes a race where CodeBuild assumes a freshly
            // created role before its CloudWatch Logs policy has propagated.
            logsConfig: {
              cloudWatchLogs: { status: "DISABLED" },
              s3Logs: { status: "DISABLED" },
            },
          });
        }),
      );

      const configured = yield* codebuild.batchGetProjects({
        names: [deployed.projectName],
      });
      expect(configured.projects?.[0]?.logsConfig?.cloudWatchLogs?.status).toBe(
        "DISABLED",
      );
      expect(configured.projects?.[0]?.logsConfig?.s3Logs?.status).toBe(
        "DISABLED",
      );

      const build = yield* Effect.gen(function* () {
        const started = yield* codebuild.startBuild({
          projectName: deployed.projectName,
        });
        const buildId = started.build?.id;
        expect(buildId).toBeDefined();
        buildIds.push(buildId!);

        // Poll until the build reaches a terminal status. IN_QUEUE is not
        // terminal; bound the total polling delay to 50 seconds.
        const terminal = yield* codebuild
          .batchGetBuilds({ ids: [buildId!] })
          .pipe(
            Effect.map((res) => res.builds?.[0]),
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (b) => {
                const status = b?.buildStatus;
                return (
                  status === "SUCCEEDED" ||
                  status === "FAILED" ||
                  status === "FAULT" ||
                  status === "STOPPED" ||
                  status === "TIMED_OUT"
                );
              },
              times: 10,
            }),
          );

        // createProject validates the role but can return before the role's
        // trust policy is usable by the CodeBuild data plane. Retry only this
        // exact queued propagation failure. A buildspec/container failure is
        // returned unchanged and must fail the SUCCEEDED assertion below.
        const roleNotReady = terminal?.phases
          ?.flatMap((phase) => phase.contexts ?? [])
          .find(
            (context) =>
              context.statusCode === "ACCESS_DENIED" &&
              context.message?.includes("Unable to assume role"),
          );
        if (terminal?.buildStatus === "FAILED" && roleNotReady) {
          yield* Effect.logWarning(
            `CodeBuild role not ready for ${buildId}: ${roleNotReady.message}`,
          );
          return yield* Effect.fail(
            new CodeBuildRoleNotReady({
              buildId: buildId!,
              message: roleNotReady.message ?? "Unable to assume role",
            }),
          );
        }
        return terminal;
      }).pipe(
        Effect.retry({
          while: (error) => error._tag === "CodeBuildRoleNotReady",
          schedule: Schedule.spaced("3 seconds"),
          times: 6,
        }),
      );
      expect(build?.buildStatus).toBe("SUCCEEDED");

      yield* stack.destroy();
      const after = yield* codebuild.batchGetProjects({
        names: [`${projectName}-run`],
      });
      expect(after.projects?.[0]).toBeUndefined();

      return build;
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Effect.forEach(
            buildIds,
            (buildId) =>
              codebuild.stopBuild({ id: buildId }).pipe(Effect.ignore),
            { concurrency: 2, discard: true },
          );
          yield* stack.destroy().pipe(Effect.ignore);
        }),
      ),
    );
  },
  { timeout: 120_000 },
);
