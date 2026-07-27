import * as AWS from "@/AWS";
import { EmailTemplate } from "@/AWS/SES";
import * as Test from "@/Test/Alchemy";
import * as sesv2 from "@distilled.cloud/aws/sesv2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class TemplateStillExists extends Data.TaggedError("TemplateStillExists")<{
  readonly name: string;
}> {}

const assertTemplateDeleted = (name: string) =>
  sesv2.getEmailTemplate({ TemplateName: name }).pipe(
    Effect.flatMap(() => Effect.fail(new TemplateStillExists({ name }))),
    Effect.catchTag("NotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "TemplateStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "template lifecycle: create, update content, update tags, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const template = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EmailTemplate("WelcomeTemplate", {
            subject: "Welcome, {{name}}!",
            text: "Hi {{name}}, thanks for signing up.",
            html: "<h1>Hi {{name}}</h1>",
            tags: { Environment: "test" },
          });
        }),
      );

      expect(template.templateName).toBeDefined();
      expect(template.templateArn).toContain(":template/");

      // out-of-band verification via distilled
      const observed = yield* sesv2.getEmailTemplate({
        TemplateName: template.templateName,
      });
      expect(observed.TemplateContent.Subject).toBe("Welcome, {{name}}!");
      expect(observed.TemplateContent.Html).toBe("<h1>Hi {{name}}</h1>");
      const tags = Object.fromEntries(
        (observed.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("WelcomeTemplate");

      // update content in place
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EmailTemplate("WelcomeTemplate", {
            subject: "Hello again, {{name}}!",
            text: "Hi {{name}}, welcome back.",
            html: "<h1>Welcome back, {{name}}</h1>",
            tags: { Environment: "test", Extra: "1" },
          });
        }),
      );
      const updated = yield* sesv2.getEmailTemplate({
        TemplateName: template.templateName,
      });
      expect(updated.TemplateContent.Subject).toBe("Hello again, {{name}}!");
      const updatedTags = Object.fromEntries(
        (updated.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(updatedTags.Extra).toBe("1");

      yield* stack.destroy();
      yield* assertTemplateDeleted(template.templateName);
    }),
  { timeout: 120_000 },
);

test.provider(
  "custom name replaces on rename",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EmailTemplate("NamedTemplate", {
            templateName: "alchemy-test-ses-template-a",
            subject: "A",
            text: "A",
          });
        }),
      );
      expect(first.templateName).toBe("alchemy-test-ses-template-a");

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EmailTemplate("NamedTemplate", {
            templateName: "alchemy-test-ses-template-b",
            subject: "B",
            text: "B",
          });
        }),
      );
      expect(second.templateName).toBe("alchemy-test-ses-template-b");
      yield* assertTemplateDeleted("alchemy-test-ses-template-a");

      yield* stack.destroy();
      yield* assertTemplateDeleted("alchemy-test-ses-template-b");
    }),
  { timeout: 120_000 },
);
