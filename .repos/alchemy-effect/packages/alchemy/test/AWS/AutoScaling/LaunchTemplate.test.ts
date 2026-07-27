import * as AWS from "@/AWS";
import { LaunchTemplate } from "@/AWS/AutoScaling";
import { amazonLinux2023 } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// `list()` enumerates every launch template in the account/region via the
// paginated `ec2.describeLaunchTemplates` op. Deploy a real launch template,
// resolve the provider from context via the typed `findProvider`, call
// `list()`, and assert the deployed template appears in the exhaustively
// paginated result. (The greenfield read path depends on the distilled `ec2`
// patch that types `InvalidLaunchTemplateName.NotFoundException` on
// `describeLaunchTemplates` — landed in patches/ec2.json.)
test.provider("list enumerates the deployed launch template", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    // Launch templates do not validate the AMI at creation time; fall back to a
    // syntactically valid id if the lookup returns nothing.
    const imageId = (yield* amazonLinux2023()) ?? "ami-00000000000000000";

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

    expect(
      all.some((t) => t.launchTemplateId === template.launchTemplateId),
    ).toBe(true);

    yield* stack.destroy();

    // Out-of-band proof the template is gone: describing the deleted name
    // raises the typed `InvalidLaunchTemplateName.NotFoundException`.
    const remaining = yield* ec2
      .describeLaunchTemplates({
        LaunchTemplateNames: ["alchemy-test-lt-list"],
      } as any)
      .pipe(
        Effect.map((r) => (r.LaunchTemplates ?? []).length),
        Effect.catchTag("InvalidLaunchTemplateName.NotFoundException", () =>
          Effect.succeed(0),
        ),
      );
    expect(remaining).toBe(0);
  }),
);
