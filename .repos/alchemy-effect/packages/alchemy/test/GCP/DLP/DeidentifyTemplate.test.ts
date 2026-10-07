import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dlp from "@distilled.cloud/gcp/dlp_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const redact = (infoTypes: string[]) => ({
  infoTypeTransformations: {
    transformations: [
      {
        infoTypes: infoTypes.map((name) => ({ name })),
        primitiveTransformation: { replaceWithInfoTypeConfig: {} },
      },
    ],
  },
});

const waitUntilGone = (name: string) =>
  dlp.getProjectsDeidentifyTemplates({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsDeidentifyTemplates on a missing template fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dlp.getProjectsDeidentifyTemplates({
          name: `projects/${project}/deidentifyTemplates/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, replace, and delete a deidentify template",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.DeidentifyTemplate("Emails", {
            displayName: "redact emails",
            description: "replace email findings",
            deidentifyConfig: redact(["EMAIL_ADDRESS"]),
          });
        }),
      );

      expect(created.templateId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/deidentifyTemplates/${created.templateId}`,
      );
      expect(created.project).toEqual(project);
      expect(created.displayName).toEqual("redact emails");
      expect(created.description).toEqual("replace email findings");

      const fetched = yield* dlp.getProjectsDeidentifyTemplates({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("replace email findings");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.DeidentifyTemplate("Emails", {
            templateId: created.templateId,
            displayName: "redact emails and phones",
            description: "replace email and phone findings",
            deidentifyConfig: redact(["EMAIL_ADDRESS", "PHONE_NUMBER"]),
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("redact emails and phones");
      expect(updated.description).toEqual("replace email and phone findings");

      const last = created.templateId.at(-1) ?? "a";
      const nextId = `${created.templateId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DLP.DeidentifyTemplate("Emails", {
            templateId: nextId,
            displayName: "replaced",
            deidentifyConfig: redact(["EMAIL_ADDRESS"]),
          });
        }),
      );

      expect(replaced.templateId).not.toEqual(created.templateId);

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dlp", "live"], timeout: 90_000 },
);
