import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { FrameworkServerError } from "alchemy/Website/Server";
import { registerHooks } from "node:module";

// Simulate an absent optional peer without changing the workspace install.
let attempts = 0;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "@alchemy.run/frontend-frameworks" ||
      specifier.startsWith("@alchemy.run/frontend-frameworks/")
    ) {
      attempts++;
      throw new Error(`Cannot find package '${specifier}'`);
    }
    return nextResolve(specifier, context);
  },
});

const providers: string[] = [];
for (const provider of ["Prisma", "Neon", "Fly", "Hetzner", "Railway"]) {
  const module = await import(`alchemy/${provider}`);
  if (module.Website) providers.push(provider);
}
const providerImportAttempts = attempts;
const { loadFrontendCore } = await import("alchemy/Website/FrontendCore");
const exit = await Effect.runPromiseExit(loadFrontendCore);
const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
console.log(
  JSON.stringify({
    providers,
    providerImportAttempts,
    loaderImportAttempts: attempts - providerImportAttempts,
    defect:
      Exit.isFailure(exit) &&
      exit.cause.reasons.some((reason) => reason._tag === "Die"),
    error:
      error instanceof FrameworkServerError
        ? {
            _tag: error._tag,
            framework: error.framework,
            message: error.message,
            cause:
              error.cause instanceof Error ? error.cause.message : error.cause,
          }
        : null,
  }),
);
