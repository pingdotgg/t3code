import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import * as Cloudflare from "alchemy/Cloudflare";

export class DevBox extends Cloudflare.Container<
  DevBox,
  {
    readFile: (path: string) => Effect.Effect<string>;
    writeFile: (path: string, contents: string) => Effect.Effect<void>;
    exec: (command: string) => Effect.Effect<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;
  }
>()("DevBox") {}

export default DevBox.make(
  {
    main: import.meta.url,
    image: "oven/bun:1.3",
  },
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cp = yield* ChildProcessSpawner;

    return {
      readFile: (path: string) => fs.readFileString(path).pipe(Effect.orDie),
      writeFile: (path: string, contents: string) =>
        fs.writeFileString(path, contents).pipe(Effect.orDie),
      exec: (command: string) =>
        cp.spawn(ChildProcess.make(command, { shell: true })).pipe(
          Effect.flatMap(({ exitCode, stdout, stderr }) =>
            Effect.all({
              exitCode,
              stdout: stdout.pipe(Stream.decodeText, Stream.mkString),
              stderr: stderr.pipe(Stream.decodeText, Stream.mkString),
            }),
          ),
          Effect.scoped,
          Effect.orDie,
        ),
    };
  }),
);
