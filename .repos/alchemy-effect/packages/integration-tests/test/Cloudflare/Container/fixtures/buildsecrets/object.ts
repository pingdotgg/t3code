import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { BuildInputs } from "./inputs.ts";

/** Built from `context/Dockerfile` with a build arg and a BuildKit secret. */
export class BuildSecretsImage extends Cloudflare.Container<BuildSecretsImage>()(
  "BuildSecretsImage",
  Effect.map(BuildInputs, ({ greeting, token }) => ({
    schedulingPolicy: "durable_object" as const,
    // A template string, not `path.join(import.meta.dirname, …)`: this module
    // is bundled into the Worker, where `import.meta.dirname` is undefined.
    context: `${import.meta.dirname}/context`,
    build: {
      args: { GREETING: greeting },
      secrets: { token: Redacted.make(token) },
    },
  })),
) {}

/** Starts {@link BuildSecretsImage} and reads the file its build wrote. */
export class BuildSecretsObject extends Cloudflare.DurableObject<BuildSecretsObject>()(
  "BuildSecretsObject",
  Effect.gen(function* () {
    const container = yield* BuildSecretsImage;
    return Effect.succeed({
      build: Effect.fn(function* () {
        if (!(yield* container.running)) {
          yield* container.start({ entrypoint: ["sleep", "infinity"], enableInternet: false });
        }
        const output = yield* Effect.scoped(
          Effect.flatMap(container.exec(["cat", "/build.txt"]), (child) => child.output()),
        );
        return new TextDecoder().decode(output.stdout).trim();
      }),
    });
  }),
) {}
