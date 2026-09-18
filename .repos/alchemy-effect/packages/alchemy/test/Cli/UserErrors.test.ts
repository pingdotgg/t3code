import { AuthError } from "@/Auth/AuthProvider.ts";
import { StackEntrypointError } from "@/Alchemist/Session.ts";
import { handleCliErrors } from "@/Cli/commands/errors.ts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { expect, it } from "alchemy-test";
import { format } from "node:util";

it.effect("renders auth failures as user-facing CLI errors", () =>
  Effect.gen(function* () {
    const errors: string[] = [];
    const capturedConsole = {
      ...globalThis.console,
      error: (...args: ReadonlyArray<unknown>) => errors.push(format(...args)),
    } as Console.Console;

    const result = yield* handleCliErrors(
      Effect.fail(
        new AuthError({
          message:
            "Cloudflare credentials need refreshing. Run: alchemy profile refresh --profile admin --provider Cloudflare",
        }),
      ),
    ).pipe(
      Effect.result,
      Effect.provideService(Console.Console, capturedConsole),
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("error:");
    expect(errors[0]).toContain("alchemy profile refresh --profile admin");
    expect(errors[0]).not.toContain("at Effect.fn");
  }),
);

it.effect("renders missing stack entrypoints without a resolver stack", () =>
  Effect.gen(function* () {
    const errors: string[] = [];
    const capturedConsole = {
      ...globalThis.console,
      error: (...args: ReadonlyArray<unknown>) => errors.push(format(...args)),
    } as Console.Console;

    const result = yield* handleCliErrors(
      Effect.fail(
        new StackEntrypointError({
          message:
            "Stack entrypoint 'alchemy.run.ts' does not exist. Run this command from an Alchemy project or pass --config <path>.",
        }),
      ),
    ).pipe(
      Effect.result,
      Effect.provideService(Console.Console, capturedConsole),
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("error:");
    expect(errors[0]).toContain("alchemy.run.ts");
    expect(errors[0]).toContain("--config <path>");
    expect(errors[0]).not.toContain("at Effect.fn");
  }),
);
