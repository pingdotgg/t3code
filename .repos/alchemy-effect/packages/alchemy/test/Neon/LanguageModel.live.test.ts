import * as Neon from "@/Neon";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import NativeLanguageModel from "./fixtures/language-model-native.ts";
import HttpLanguageModel from "./fixtures/language-model-http.ts";
import { languageModelBranch } from "./fixtures/language-model-resources.ts";

const { test } = Test.make({ providers: Neon.providers() });
const Text = Schema.Struct({ text: Schema.String });

test.provider.skipIf(
  process.env.NEON_TEST_AI_PAID !== "1" || !process.env.NEON_TEST_AI_MODEL,
)(
  "injected and explicit credentials use the same HTTP Effect AI client for generation, streaming, tools and objects",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const branch = yield* languageModelBranch;
          const native = yield* NativeLanguageModel;
          const http = yield* HttpLanguageModel;
          return { branch, native, http };
        }),
      );
      yield* Effect.gen(function* () {
        const client = (yield* HttpClient.HttpClient).pipe(
          HttpClient.transformResponse(
            Effect.tap((response) =>
              response.status < 400
                ? Effect.void
                : response.json.pipe(
                    Effect.flatMap(
                      Schema.decodeUnknownEffect(
                        Schema.Struct({ reason: Schema.String }),
                      ),
                    ),
                    Effect.flatMap(({ reason }) =>
                      Effect.log("Neon AI fixture rejected the request", {
                        status: response.status,
                        reason,
                      }),
                    ),
                  ),
            ),
          ),
          HttpClient.filterStatusOk,
        );
        for (const fn of [deployed.native, deployed.http]) {
          const generated = yield* client.get(`${fn.url}/generate`).pipe(
            Effect.retry({ times: 3, schedule: Schedule.spaced("1 second") }),
            Effect.flatMap((response) => response.json),
            Effect.flatMap(Schema.decodeUnknownEffect(Text)),
          );
          expect(generated.text.length).toBeGreaterThan(0);
          const streamed = yield* client.get(`${fn.url}/stream`).pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  text: Schema.String,
                  finished: Schema.Boolean,
                }),
              ),
            ),
          );
          expect(streamed.text.length).toBeGreaterThan(0);
          expect(streamed.finished).toBe(true);
          const tool = yield* client.get(`${fn.url}/tool`).pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({ results: Schema.Array(Schema.Number) }),
              ),
            ),
          );
          expect(tool.results).toContain(5);
          const object = yield* client.get(`${fn.url}/object`).pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({ greeting: Schema.String }),
              ),
            ),
          );
          expect(object.greeting.length).toBeGreaterThan(0);
        }
        const credentials = yield* SDK.listCredentials({
          project_id: deployed.branch.projectId,
          branch_id: deployed.branch.branchId,
        });
        expect(
          credentials.credentials.some(
            (entry) =>
              !entry.revoked_at && entry.scopes.includes("ai_gateway:invoke"),
          ),
        ).toBe(true);
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));
      expect(
        yield* SDK.getProjectBranch({
          project_id: deployed.branch.projectId,
          branch_id: deployed.branch.branchId,
        }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:aigateway",
      "provider:neon:branch",
      "provider:neon:credential",
      "provider:neon:function",
      "provider:neon:languagemodel",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);
