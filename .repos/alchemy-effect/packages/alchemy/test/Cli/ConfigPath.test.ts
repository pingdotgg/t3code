import { UserInputError } from "@/Cli/commands/errors.ts";
import { resolveConfig } from "@/Cli/commands/flags.ts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect, it } from "alchemy-test";

describe("stack command config paths", () => {
  it.effect("uses the positional config path", () =>
    Effect.gen(function* () {
      const args = yield* resolveConfig({
        config: undefined,
        configPath: "infra.ts",
      });
      expect(args.main).toBe("infra.ts");
    }),
  );

  it.effect("uses --config", () =>
    Effect.gen(function* () {
      const args = yield* resolveConfig({
        config: "infra.ts",
        configPath: undefined,
      });
      expect(args.main).toBe("infra.ts");
    }),
  );

  it.effect("defaults to alchemy.run.ts", () =>
    Effect.gen(function* () {
      const args = yield* resolveConfig({
        config: undefined,
        configPath: undefined,
      });
      expect(args.main).toBe("alchemy.run.ts");
    }),
  );

  it.effect("rejects using the positional path and --config together", () =>
    Effect.gen(function* () {
      const result = yield* resolveConfig({
        config: "flag.ts",
        configPath: "positional.ts",
      }).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(UserInputError);
        expect(result.failure.message).toContain("not both");
      }
    }),
  );
});
