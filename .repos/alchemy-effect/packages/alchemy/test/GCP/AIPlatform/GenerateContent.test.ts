import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "GenerateContent calls Gemini through the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              const global =
                yield* GCP.AIPlatform.GenerateContent("gemini-2.5-flash");
              const regional = yield* GCP.AIPlatform.GenerateContent({
                model: "gemini-2.5-flash",
                location: "us-central1",
              });
              return Effect.fn(function* () {
                const text = yield* global.text("Reply with exactly: pong");
                const response = yield* regional.generate({
                  contents: [
                    {
                      role: "user",
                      parts: [{ text: "Reply with exactly: ping" }],
                    },
                  ],
                });
                return {
                  text,
                  regional:
                    response.candidates?.[0]?.content?.parts
                      ?.map((part) => part.text ?? "")
                      .join("") ?? "",
                  modelVersion: response.modelVersion,
                };
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(out.text.toLowerCase()).toContain("pong");
      expect(out.regional.toLowerCase()).toContain("ping");
      expect(out.modelVersion).toContain("gemini-2.5-flash");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:gcp", "provider:gcp:aiplatform", "live"],
    timeout: 120_000,
  },
);
