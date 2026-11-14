import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { WorkerPreviewConfigError } from "@alchemy.run/cloudflare/Workers/WorkerProvider";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { expectUrlContains } from "../Utils/Http.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const script = (marker: string) =>
  `export default { fetch() { return new Response("${marker}"); } };`;

const envScript = `export default { fetch(_request, env) { return new Response([env.LINEAR.teamIds.FIN, env.LINEAR.stateIds["FIN/Triage"], env.LINEAR.stateIds["In Review"], env.SIGNING_KEY.algorithm.namedCurve].join("|")); } };`;

const linearConfig = {
  teamIds: { FIN: "team-fin" },
  stateIds: { "FIN/Triage": "state-1", "In Review": "state-2" },
};
const envMarker = "team-fin|state-1|state-2|P-256";

const ECDSA_P256_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "I1ozXkOgIpZDp-Nn7Q3OtPapgQ_h2E8UqrtEPPqz2qY",
  y: "cJhHJik5pjNIZolyCryZu3NDb8zgL_5z4HWXdkAu-lQ",
  d: "4MwKCFxYuXltCvTaoz2RDvf_B8VRr2Ft0UtFIkcWuDI",
};

describe.concurrent(
  "Cloudflare.Worker preview",
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
  () => {
    test.provider(
      "preview of a parent worker, updated, then deleted",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const v1 = yield* stack.deploy(
            Effect.gen(function* () {
              const parent = yield* Cloudflare.Worker("PreviewParent", {
                script: script("parent-marker-v1"),
              });
              const preview = yield* Cloudflare.Worker("PreviewChild", {
                script: script("preview-marker-v1"),
                preview: { of: parent, message: "alchemy preview test" },
              });
              return { parent, preview };
            }),
          );

          expect(v1.preview.previewOf).toEqual(v1.parent.workerName);
          expect(v1.preview.workerName).toEqual(v1.parent.workerName);
          expect(v1.preview.previewId).toBeDefined();
          expect(v1.preview.previewName).toBeDefined();
          expect(v1.preview.previewSlug).toBeDefined();
          expect(v1.preview.deploymentId).toBeDefined();
          expect(v1.preview.url).toBeDefined();
          expect(v1.preview.url).toContain(`${v1.preview.previewSlug}-${v1.parent.workerName}.`);
          expect(v1.preview.versionOf).toBeUndefined();

          yield* expectUrlContains(v1.parent.url!, "parent-marker-v1", {
            label: "parent serves its own code",
          });
          yield* expectUrlContains(v1.preview.url!, "preview-marker-v1", {
            label: "Preview URL serves the Preview's code",
          });

          const v2 = yield* stack.deploy(
            Effect.gen(function* () {
              const parent = yield* Cloudflare.Worker("PreviewParent", {
                script: script("parent-marker-v1"),
              });
              const preview = yield* Cloudflare.Worker("PreviewChild", {
                script: script("preview-marker-v2"),
                preview: { of: parent },
              });
              return { parent, preview };
            }),
          );

          expect(v2.preview.previewId).toEqual(v1.preview.previewId);
          expect(v2.preview.previewName).toEqual(v1.preview.previewName);
          expect(v2.preview.url).toEqual(v1.preview.url);
          yield* expectUrlContains(v2.preview.url!, "preview-marker-v2", {
            label: "updated Preview serves new code at the same URL",
          });
          yield* expectUrlContains(v2.parent.url!, "parent-marker-v1", {
            label: "parent is untouched by the Preview update",
          });

          yield* stack.destroy();

          const { accountId } = yield* yield* CloudflareEnvironment;
          const gone = yield* workers
            .getPreview({
              accountId,
              workerId: v1.parent.workerName,
              previewId: v1.preview.previewId!,
            })
            .pipe(
              Effect.map(() => false),
              Effect.catchTag("PreviewNotFound", () => Effect.succeed(true)),
              Effect.catchTag("WorkerNotFound", () => Effect.succeed(true)),
            );
          expect(gone).toBe(true);
        }).pipe(logLevel),
      { timeout: 240_000 },
    );

    test.provider(
      "Preview sees json and secret_key binding payloads exactly as declared",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { parent, preview } = yield* stack.deploy(
            Effect.gen(function* () {
              const env = {
                LINEAR: linearConfig,
                SIGNING_KEY: Cloudflare.Workers.SecretKey("SIGNING_KEY", {
                  format: "jwk",
                  algorithm: { name: "ECDSA", namedCurve: "P-256" },
                  usages: ["sign"],
                  keyJwk: ECDSA_P256_JWK,
                }),
              };
              const parent = yield* Cloudflare.Worker("EnvParent", { script: envScript, env });
              const preview = yield* Cloudflare.Worker("EnvPreview", {
                script: envScript,
                env,
                preview: { of: parent },
              });
              return { parent, preview };
            }),
          );

          yield* expectUrlContains(parent.url!, envMarker, {
            label: "parent sees the payloads as declared",
          });
          yield* expectUrlContains(preview.url!, envMarker, {
            label: "Preview sees the same payloads as its parent",
          });

          yield* stack.destroy();
        }).pipe(logLevel),
      { timeout: 240_000 },
    );

    test.provider(
      "rejects preview combined with version.parent",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { parent } = yield* stack.deploy(
            Effect.gen(function* () {
              const parent = yield* Cloudflare.Worker("ComboParent", {
                script: script("combo-parent"),
              });
              return { parent };
            }),
          );

          const error = yield* stack
            .deploy(
              Effect.gen(function* () {
                yield* Cloudflare.Worker("ComboParent", { script: script("combo-parent") });
                return yield* Cloudflare.Worker("ComboPreview", {
                  script: script("combo-preview"),
                  preview: { of: parent.workerName },
                  version: { parent: parent.workerName },
                });
              }),
            )
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkerPreviewConfigError);
          expect(String(error)).toContain("preview and version cannot be set");

          yield* stack.destroy();
        }).pipe(logLevel),
      { timeout: 180_000 },
    );

    test.provider(
      "rejects script-level settings on a Preview worker",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { parent } = yield* stack.deploy(
            Effect.gen(function* () {
              const parent = yield* Cloudflare.Worker("SettingsParent", {
                script: script("settings-parent"),
              });
              return { parent };
            }),
          );

          const error = yield* stack
            .deploy(
              Effect.gen(function* () {
                yield* Cloudflare.Worker("SettingsParent", { script: script("settings-parent") });
                return yield* Cloudflare.Worker("SettingsPreview", {
                  script: script("settings-preview"),
                  preview: { of: parent.workerName },
                  crons: ["*/5 * * * *"],
                });
              }),
            )
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkerPreviewConfigError);
          expect(String(error)).toContain("script-level settings");

          yield* stack.destroy();
        }).pipe(logLevel),
      { timeout: 180_000 },
    );
  },
);
