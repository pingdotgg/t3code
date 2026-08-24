import * as AWS from "@/AWS";
import { ComponentVersion } from "@/AWS/GreengrassV2";
import * as Test from "@/Test/Alchemy";
import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "describeComponent on a nonexistent ARN fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const region = yield* yield* AWS.Region;
      const { Account } = yield* sts.getCallerIdentity({});
      const error = yield* Effect.flip(
        greengrassv2.describeComponent({
          arn: `arn:aws:greengrass:${region}:${Account}:components:com.alchemy.test.Nonexistent:versions:0.0.1`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const recipe = (version: string) =>
  JSON.stringify({
    RecipeFormatVersion: "2020-01-25",
    ComponentName: "com.alchemy.test.GgHello",
    ComponentVersion: version,
    ComponentDescription: "Alchemy GreengrassV2 test component",
    ComponentPublisher: "Alchemy",
    Manifests: [
      {
        Platform: { os: "linux" },
        Lifecycle: { run: "echo hello from alchemy" },
      },
    ],
  });

const componentExists = (arn: string) =>
  greengrassv2.describeComponent({ arn }).pipe(
    Effect.map(() => true),
    Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(false)),
  );

const waitUntilComponentGone = (arn: string) =>
  componentExists(arn).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (exists) => exists === false,
      times: 10,
    }),
    Effect.map((exists) => expect(exists).toBe(false)),
  );

test.provider(
  "create, tag-update, replace (version bump), destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // 1. CREATE from an inline recipe.
      const { component } = yield* stack.deploy(
        Effect.gen(function* () {
          const component = yield* ComponentVersion("Hello", {
            recipe: recipe("1.0.0"),
            tags: { fixture: "greengrass-component" },
          });
          return { component };
        }),
      );
      expect(component.componentName).toBe("com.alchemy.test.GgHello");
      expect(component.componentVersion).toBe("1.0.0");
      expect(component.arn).toContain(
        ":components:com.alchemy.test.GgHello:versions:1.0.0",
      );

      // Out-of-band verification via distilled: DEPLOYABLE + branded tags.
      const described = yield* greengrassv2.describeComponent({
        arn: component.arn,
      });
      expect(described.status?.componentState).toBe("DEPLOYABLE");
      expect(described.tags?.fixture).toBe("greengrass-component");
      expect(described.tags?.["alchemy::id"]).toBe("Hello");

      // 2. UPDATE tags in place — same immutable component version.
      const { component: retagged } = yield* stack.deploy(
        Effect.gen(function* () {
          const component = yield* ComponentVersion("Hello", {
            recipe: recipe("1.0.0"),
            tags: { fixture: "greengrass-component", team: "edge" },
          });
          return { component };
        }),
      );
      expect(retagged.arn).toBe(component.arn);
      const retaggedTags = yield* greengrassv2.listTagsForResource({
        resourceArn: component.arn,
      });
      expect(retaggedTags.tags?.team).toBe("edge");

      // 3. REPLACE — bumping the recipe version registers a new component
      //    version and deletes the old one.
      const { component: bumped } = yield* stack.deploy(
        Effect.gen(function* () {
          const component = yield* ComponentVersion("Hello", {
            recipe: recipe("1.0.1"),
            tags: { fixture: "greengrass-component" },
          });
          return { component };
        }),
      );
      expect(bumped.componentVersion).toBe("1.0.1");
      expect(bumped.arn).not.toBe(component.arn);
      yield* waitUntilComponentGone(component.arn);

      // 4. DESTROY — the replacement version is deleted too.
      yield* stack.destroy();
      yield* waitUntilComponentGone(bumped.arn);
    }),
  { timeout: 300_000 },
);
