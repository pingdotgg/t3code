import * as AWS from "@alchemy.run/aws";
import { LaunchTemplate } from "@alchemy.run/aws/AutoScaling";
import { amazonLinux2023 } from "@alchemy.run/aws/EC2";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// `list()` enumerates every launch template in the account/region via the
// paginated `ec2.describeLaunchTemplates` op. Deploy a real launch template,
// resolve the provider from context via the typed `findProvider`, call
// `list()`, and assert the deployed template appears in the exhaustively
// paginated result. (The greenfield read path depends on the distilled `ec2`
// patch that types `InvalidLaunchTemplateName.NotFoundException` on
// `describeLaunchTemplates` — landed in patches/ec2.json.)
test.provider(
  "list enumerates the deployed launch template",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Launch templates do not validate the AMI at creation time; fall back to a
      // syntactically valid id if the lookup returns nothing.
      const imageId = amazonLinux2023();

      const template = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* LaunchTemplate("ListLaunchTemplate", {
            launchTemplateName: "alchemy-test-lt-list",
            imageId,
            instanceType: "t3.micro",
          });
        }),
      );

      const provider = yield* Provider.findProvider(LaunchTemplate);
      const all = yield* provider.list();

      expect(all.some((t) => t.launchTemplateId === template.launchTemplateId)).toBe(true);

      yield* stack.destroy();

      // Out-of-band proof the template is gone: describing the deleted name
      // raises the typed `InvalidLaunchTemplateName.NotFoundException`.
      const remaining = yield* ec2
        .describeLaunchTemplates({ LaunchTemplateNames: ["alchemy-test-lt-list"] } as any)
        .pipe(
          Effect.map((r) => (r.LaunchTemplates ?? []).length),
          Effect.catchTag("InvalidLaunchTemplateName.NotFoundException", () => Effect.succeed(0)),
        );
      expect(remaining).toBe(0);
    }),
  { tags: ["provider:aws", "provider:aws:autoscaling", "provider:aws:ec2", "live"] },
);

// Metadata options land in the template data; a change publishes a new
// default version carrying the new options.
test.provider(
  "metadataOptions land in the default template version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const imageId = amazonLinux2023();

      const program = (httpPutResponseHopLimit: number) =>
        Effect.gen(function* () {
          return yield* LaunchTemplate("MetadataLaunchTemplate", {
            imageId,
            instanceType: "t3.micro",
            metadataOptions: { httpTokens: "required", httpPutResponseHopLimit },
          });
        });

      const observeMetadata = (launchTemplateId: string) =>
        ec2
          .describeLaunchTemplateVersions({
            LaunchTemplateId: launchTemplateId,
            Versions: ["$Default"],
          })
          .pipe(
            Effect.map((r) => r.LaunchTemplateVersions?.[0]?.LaunchTemplateData?.MetadataOptions),
          );

      const first = yield* stack.deploy(program(1));
      expect(yield* observeMetadata(first.launchTemplateId)).toMatchObject({
        HttpTokens: "required",
        HttpPutResponseHopLimit: 1,
      });

      const second = yield* stack.deploy(program(2));
      expect(second.launchTemplateId).toBe(first.launchTemplateId);
      expect(second.defaultVersionNumber).toBeGreaterThan(first.defaultVersionNumber);
      expect(yield* observeMetadata(second.launchTemplateId)).toMatchObject({
        HttpTokens: "required",
        HttpPutResponseHopLimit: 2,
      });

      yield* stack.destroy();

      const remaining = yield* ec2
        .describeLaunchTemplates({ LaunchTemplateIds: [second.launchTemplateId] })
        .pipe(
          Effect.map((r) => (r.LaunchTemplates ?? []).length),
          Effect.catchTag("InvalidLaunchTemplateId.NotFound", () => Effect.succeed(0)),
        );
      expect(remaining).toBe(0);
    }),
  { tags: ["provider:aws", "provider:aws:autoscaling", "provider:aws:ec2", "live"] },
);
