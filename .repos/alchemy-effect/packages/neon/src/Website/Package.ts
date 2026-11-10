import { logChildLine } from "alchemy/Util/LogRecord";
import { sha256 } from "alchemy/Util/sha256";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Stream from "effect/Stream";
import type { WebsiteArtifactProps } from "./Artifact.ts";

export class PackageOperationFailed extends Data.TaggedError("PackageOperationFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Release staging, compression and validation buffers between deployments. */
export const packageWebsiteInChild = Effect.fn(
  function* (props: WebsiteArtifactProps) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({
      prefix: "alchemy-neon-package-",
    });
    const inputPath = path.join(directory, "input.json");
    const outputPath = path.join(directory, "output.zip");
    yield* fs.writeFileString(inputPath, JSON.stringify(props));
    const runner = yield* path.fromFileUrl(
      new URL(
        import.meta.url.endsWith(".ts") ? "./PackageRunner.ts" : "./PackageRunner.js",
        import.meta.url,
      ),
    );
    const child = yield* ChildProcess.make(
      "node",
      [
        "--max-old-space-size=1536",
        ...(runner.endsWith(".ts")
          ? ["--experimental-transform-types", "--no-warnings=ExperimentalWarning"]
          : []),
        runner,
        inputPath,
        outputPath,
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    // The runner's diagnostics become log records instead of raw terminal writes.
    const [code] = yield* Effect.all(
      [
        child.exitCode,
        child.stderr.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runForEach((line) => logChildLine(line, { stream: "stderr" })),
        ),
      ],
      { concurrency: "unbounded" },
    );
    if (code !== 0)
      return yield* new PackageOperationFailed({ message: `Website packaging exited ${code}` });
    const archive = yield* fs.readFile(outputPath);
    return { archive, hash: yield* sha256(archive) };
  },
  Effect.scoped,
  Effect.timeout("90 seconds"),
);
