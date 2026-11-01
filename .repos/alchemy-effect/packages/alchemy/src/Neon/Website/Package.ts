import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import { sha256 } from "../../Util/sha256.ts";
import type { WebsiteArtifactProps } from "./Artifact.ts";

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
        import.meta.url.endsWith(".ts")
          ? "./PackageRunner.ts"
          : "./PackageRunner.js",
        import.meta.url,
      ),
    );
    const child = yield* ChildProcess.make(
      "node",
      [
        "--max-old-space-size=1536",
        ...(runner.endsWith(".ts")
          ? [
              "--experimental-transform-types",
              "--no-warnings=ExperimentalWarning",
            ]
          : []),
        runner,
        inputPath,
        outputPath,
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "inherit" },
    );
    const code = yield* child.exitCode;
    if (code !== 0)
      return yield* Effect.fail(new Error(`Website packaging exited ${code}`));
    const archive = yield* fs.readFile(outputPath);
    return { archive, hash: yield* sha256(archive) };
  },
  Effect.scoped,
  Effect.timeout("90 seconds"),
);
