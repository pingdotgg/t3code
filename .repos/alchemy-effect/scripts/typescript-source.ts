import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { SourceFile } from "tsrs/unstable/ast";
import { API, formatDiagnostics } from "tsrs/unstable/async";

export class SyntaxProjectError extends Data.TaggedError("SyntaxProjectError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const tryApi = <A>(message: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new SyntaxProjectError({ message, cause }),
  });

/**
 * Native syntax-only project: don't load imports, libraries, or inferred types.
 * The tsrs API process and its temporary tsconfig live as long as the ambient
 * `Scope`.
 */
export const createSyntaxProject = Effect.fn("createSyntaxProject")(function* (
  files: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-typescript-" });
  const configPath = path.join(directory, "tsconfig.json");
  yield* fs.writeFileString(
    configPath,
    JSON.stringify({
      files,
      compilerOptions: {
        noResolve: true,
        noLib: true,
        types: [],
        jsx: "preserve",
      },
    }),
  );
  const api = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new API(),
      catch: (cause) => new SyntaxProjectError({ message: "Failed to start tsrs API", cause }),
    }),
    (api) => tryApi("Failed to close tsrs API", () => api.close()).pipe(Effect.ignore),
  );
  const snapshot = yield* tryApi(`Failed to open syntax project ${configPath}`, () =>
    api.createSnapshot({ openProjects: [configPath] }),
  );
  const project = snapshot.getConfiguredProject(configPath);
  if (!project) {
    return yield* new SyntaxProjectError({
      message: `Failed to open syntax project ${configPath}`,
    });
  }
  const diagnostics = yield* tryApi("Failed to read syntactic diagnostics", () =>
    project.program.getSyntacticDiagnostics(),
  );
  if (diagnostics.length) {
    return yield* new SyntaxProjectError({ message: formatDiagnostics(diagnostics, api) });
  }

  const getSourceFile = (filename: string): Effect.Effect<SourceFile, SyntaxProjectError> =>
    tryApi(`Failed to read source file ${filename}`, () =>
      project.program.getSourceFile(filename),
    ).pipe(
      Effect.flatMap((sourceFile) =>
        sourceFile
          ? Effect.succeed(sourceFile)
          : Effect.fail(new SyntaxProjectError({ message: `Missing source file ${filename}` })),
      ),
    );

  return { api, project, getSourceFile };
});
