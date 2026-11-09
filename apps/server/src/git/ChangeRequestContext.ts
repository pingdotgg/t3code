import { GitManagerError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";

const SCRIPT = "hooks.changeRequestContext in .t3code/vcs.json";
const MAX_CONTEXT_BYTES = 128_000;
const isGitManagerError = Schema.is(GitManagerError);
const decodePaths = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMaxLength(16)),
  ),
);

export const readChangeRequestContext = Effect.fn("GitManager.readChangeRequestContext")(
  function* (input: { cwd: string; baseBranch: string; headBranch: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const config = yield* VcsProjectConfig.VcsProjectConfig;
    const command = yield* config.resolveChangeRequestContext({ cwd: input.cwd });
    if (command === null) return [];
    const platform = yield* HostProcess.Platform;
    const environment = yield* HostProcess.Environment;
    const processCommand =
      typeof command === "string"
        ? {
            command: platform === "win32" ? (environment.ComSpec ?? "cmd.exe") : "/bin/sh",
            args: platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command],
          }
        : { command: command[0], args: command.slice(1) };
    const result = yield* vcsProcess.run({
      operation: "GitManager.readChangeRequestContext",
      ...processCommand,
      cwd: input.cwd,
      env: {
        T3_HEAD_BRANCH: input.headBranch,
        T3_BASE_BRANCH: input.baseBranch,
      },
      timeoutMs: 30_000,
      maxOutputBytes: 16_000,
    });
    const fail = (detail: string) =>
      new GitManagerError({ operation: "readChangeRequestContext", cwd: input.cwd, detail });
    if (result.stdoutTruncated || result.stdoutInvalidUtf8)
      return yield* fail(`${SCRIPT} must print a JSON array of at most 16 file paths (16 KB).`);
    const paths = yield* decodePaths(result.stdout);
    const root = yield* fs.realPath(input.cwd);
    const files: Array<{ path: string; content: string | null }> = [];
    let bytes = 0;
    for (const file of new Set(paths)) {
      const relative = path.relative(input.cwd, path.resolve(input.cwd, file));
      if (
        path.isAbsolute(file) ||
        path.isAbsolute(relative) ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`)
      )
        return yield* fail(`${SCRIPT} must select files inside the checkout using relative paths.`);
      const target = path.resolve(input.cwd, file);
      const resolved = yield* fs.realPath(target).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
        }),
      );
      if (resolved === null) {
        files.push({ path: file, content: null });
        continue;
      }
      const resolvedRelative = path.relative(root, resolved);
      if (
        path.isAbsolute(resolvedRelative) ||
        resolvedRelative === ".." ||
        resolvedRelative.startsWith(`..${path.sep}`)
      )
        return yield* fail(`${SCRIPT} selected a symlink pointing outside the checkout.`);
      const info = yield* fs.stat(resolved);
      if (info.type !== "File" || bytes + Number(info.size) > MAX_CONTEXT_BYTES)
        return yield* fail(`${SCRIPT} must select text files totaling at most 128 KB.`);
      const data = yield* fs.readFile(resolved);
      bytes += data.byteLength;
      if (bytes > MAX_CONTEXT_BYTES || data.includes(0))
        return yield* fail(`${SCRIPT} must select text files totaling at most 128 KB.`);
      const content = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(data),
        catch: (cause) =>
          new GitManagerError({
            operation: "readChangeRequestContext",
            cwd: input.cwd,
            detail: `${SCRIPT} must select UTF-8 text files.`,
            cause,
          }),
      });
      files.push({ path: file, content });
    }
    return files;
  },
  (effect, input) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isGitManagerError(cause)
          ? cause
          : new GitManagerError({
              operation: "readChangeRequestContext",
              cwd: input.cwd,
              detail: `Failed to load additional change request context from ${SCRIPT}.`,
              cause,
            }),
      ),
    ),
);
