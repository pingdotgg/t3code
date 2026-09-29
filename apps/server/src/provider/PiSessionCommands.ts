import type { ProviderSessionCommandInput, ProviderSessionCommandResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/unstable/process";

import { PiRpcError, piRecordString, type PiRpcConnection } from "./PiRpc.ts";
import { spawnAndCollect } from "./providerSnapshot.ts";
import { expandHomePathWith } from "../pathExpansion.ts";

/** Pi's TUI utilities need explicit RPC/client handling; they are not agent prompts. */
export const runPiSessionCommand = Effect.fn("runPiSessionCommand")(function* (
  input: ProviderSessionCommandInput,
  connection: PiRpcConnection,
  environment: NodeJS.ProcessEnv,
  cwd: string | undefined,
) {
  if (input.command !== "export" && input.outputPath !== undefined) {
    return yield* new PiRpcError({
      operation: input.command,
      detail: `/${input.command} does not accept arguments.`,
    });
  }
  if (input.command === "copy") {
    const data = yield* connection.request({ type: "get_last_assistant_text" });
    const text = piRecordString(data, "text");
    if (!text) {
      return yield* new PiRpcError({ operation: "copy", detail: "No assistant response to copy" });
    }
    return { command: "copy", text } satisfies ProviderSessionCommandResult;
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-export-" });
  const outputPath =
    input.command === "export" && input.outputPath
      ? path.resolve(cwd ?? ".", expandHomePathWith(input.outputPath, path))
      : path.join(directory, "session.html");
  yield* connection.request({ type: "export_html", outputPath });

  if (input.command === "export") {
    const html = yield* fs.readFileString(outputPath);
    return {
      command: "export",
      fileName: path.basename(outputPath),
      html,
      ...(input.outputPath ? { outputPath } : {}),
    } satisfies ProviderSessionCommandResult;
  }

  // Pi's RPC has no share operation. Match its unlisted-gist sharing path,
  // using the server's gh authentication rather than the client's credentials.
  const result = yield* spawnAndCollect(
    "gh",
    ChildProcess.make("gh", ["gist", "create", "--public=false", outputPath], {
      env: environment,
      shell: false,
      cwd,
    }),
  ).pipe(Effect.timeout("60 seconds"));
  if (result.code !== 0) {
    return yield* new PiRpcError({
      operation: "share",
      detail:
        result.stderr.trim() || "GitHub CLI sharing failed. Run 'gh auth login' on the server.",
    });
  }
  const match = /^https:\/\/gist\.github\.com\/(?:[^/\s]+\/)?([\da-f]+)\/?$/i.exec(
    result.stdout.trim(),
  );
  if (!match?.[1]) {
    return yield* new PiRpcError({
      operation: "share",
      detail: "GitHub CLI returned an invalid gist URL",
    });
  }
  return {
    command: "share",
    url: `${environment.PI_SHARE_VIEWER_URL || "https://pi.dev/session/"}#${match[1]}`,
  } satisfies ProviderSessionCommandResult;
});
