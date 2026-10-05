import { functionEnvironment, functionSlug } from "@/Neon/FunctionConfig";
import { expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const props = {
  branch: { projectId: "project", branchId: "branch" },
  main: "index.ts",
};
for (const key of [
  "NEON_API_KEY",
  "DATABASE_URL",
  "AWS_SECRET_ACCESS_KEY",
  "NEON_AI_GATEWAY_TOKEN",
  "NEON_DATA_API_URL",
  "NEON_BRANCH",
  "ALCHEMY_STAGE",
]) {
  test.effect(
    `rejects overriding injected environment ${key}`,
    () =>
      Effect.gen(function* () {
        const rejected = yield* functionEnvironment(
          { ...props, env: { [key]: "must-not-deploy" } },
          [],
        ).pipe(
          Effect.as(false),
          Effect.catchTag("FunctionConfigurationError", () =>
            Effect.succeed(true),
          ),
        );
        expect(rejected).toBe(true);
      }),
    { tags: ["unit", "provider:neon", "provider:neon:function", "local"] },
  );
}
test.effect(
  "unwraps redacted application values only at deployment",
  () =>
    Effect.gen(function* () {
      expect(
        yield* functionEnvironment(
          {
            ...props,
            env: { APP_TOKEN: Redacted.make("test-token"), OMITTED: undefined },
          },
          [],
        ),
      ).toEqual({ APP_TOKEN: "test-token" });
    }),
  { tags: ["unit", "provider:neon", "provider:neon:function", "local"] },
);
for (const slug of [
  "contains-hyphen",
  "Uppercase",
  "morethan20characterslong",
  "",
]) {
  test.effect(
    `rejects invalid explicit slug ${JSON.stringify(slug)}`,
    () =>
      Effect.gen(function* () {
        expect(
          yield* functionSlug("Api", slug).pipe(
            Effect.as(false),
            Effect.catchTag("FunctionConfigurationError", () =>
              Effect.succeed(true),
            ),
          ),
        ).toBe(true);
      }),
    { tags: ["unit", "provider:neon", "provider:neon:function", "local"] },
  );
}
