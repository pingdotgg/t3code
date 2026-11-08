import { type ManagedCloudSandboxResourceId, WorktreeMcpFailure } from "@t3tools/contracts";
import {
  baseSshArgs,
  buildSshHostSpecEffect,
  resolveSshCommand,
  shellSingleQuote,
} from "@t3tools/ssh/command";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Manager from "../cloudSandbox/CloudSandboxManager.ts";
import * as Git from "../vcs/GitVcsDriver.ts";

export class CloudSandboxProjectTransfer extends Context.Service<
  CloudSandboxProjectTransfer,
  {
    readonly transfer: (input: {
      readonly resourceId: ManagedCloudSandboxResourceId;
      readonly cwd: string;
    }) => Effect.Effect<string, WorktreeMcpFailure>;
  }
>()("t3/workspace/CloudSandboxProjectTransfer") {}

const isWorktreeMcpFailure = Schema.is(WorktreeMcpFailure);
const installScript = (resourceId: ManagedCloudSandboxResourceId) => `set -eu
umask 077
root="$HOME/.t3/cloud-workspaces/${resourceId}"
mkdir -p "$root"
stage=$(mktemp -d "$root/.incoming-XXXXXX")
cleanup() {
  rm -rf "$stage"
}
trap cleanup EXIT HUP INT TERM
tar -xf - -C "$stage"
if [ ! -d "$root/repo/.git" ]; then
  git init -q -b transferred "$stage/repo"
  if [ -f "$stage/source.shallow" ]; then
    cp "$stage/source.shallow" "$stage/repo/.git/shallow"
  fi
  if [ -f "$stage/source.bundle" ]; then
    git -C "$stage/repo" fetch --quiet --no-tags "$stage/source.bundle" HEAD
    git -C "$stage/repo" reset --mixed -q FETCH_HEAD
  fi
  tar -xpf "$stage/working-tree.tar" -C "$stage/repo"
  mv "$stage/repo" "$root/repo"
fi
cd "$root/repo"
printf '%s\\n' "$PWD"
`;

const make = Effect.gen(function* () {
  const manager = yield* Manager.CloudSandboxManager;
  const git = yield* Git.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const run = Effect.fn("CloudSandboxProjectTransfer.run")(function* (
    command: string,
    args: readonly string[],
    cwd: string,
  ) {
    const child = yield* spawner.spawn(
      ChildProcess.make(command, args, { cwd, stdout: "ignore", stderr: "pipe" }),
    );
    const [stderr, exitCode] = yield* Effect.all(
      [child.stderr.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      yield* Effect.logWarning("Checkout archive command failed.", {
        command,
        exitCode,
        stderr: stderr.slice(0, 2_000),
      });
      return yield* new WorktreeMcpFailure({
        code: "operation_failed",
        message: "The checkout archive could not be created.",
      });
    }
  });
  const query = Effect.fn("CloudSandboxProjectTransfer.query")(function* (
    cwd: string,
    args: readonly string[],
  ) {
    const result = yield* git.execute({
      operation: "CloudSandboxProjectTransfer.query",
      cwd,
      args,
      maxOutputBytes: 8_000_000,
    });
    if (result.stdoutTruncated)
      return yield* new WorktreeMcpFailure({
        code: "operation_failed",
        message: "The checkout file list exceeds the transfer limit.",
      });
    return result.stdout;
  });
  return CloudSandboxProjectTransfer.of({
    transfer: Effect.fn("CloudSandboxProjectTransfer.transfer")(
      function* ({ resourceId, cwd }) {
        const root = (yield* query(cwd, ["rev-parse", "--show-toplevel"])).trim();
        const prefix = (yield* query(cwd, ["rev-parse", "--show-prefix"]))
          .trim()
          .replace(/\/+$/, "");
        const entries = yield* query(root, ["ls-files", "--stage", "-z"]);
        if (entries.split("\0").some((entry) => entry.startsWith("160000 ")))
          return yield* new WorktreeMcpFailure({
            code: "invalid_request",
            message: "Sandbox checkout transfer does not support Git submodules.",
          });
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloud-checkout-" });
        const archiveMembers: string[] = [];
        const headCheck = yield* git.execute({
          operation: "CloudSandboxProjectTransfer.head",
          cwd: root,
          args: ["rev-parse", "--verify", "--quiet", "HEAD"],
          allowNonZeroExit: true,
        });
        if (headCheck.exitCode === 0) {
          const bundle = path.join(directory, "source.bundle");
          yield* git.execute({
            operation: "CloudSandboxProjectTransfer.bundle",
            cwd: root,
            args: ["bundle", "create", bundle, "HEAD"],
          });
          archiveMembers.push("source.bundle");

          const isShallow = (yield* query(root, ["rev-parse", "--is-shallow-repository"])).trim();
          if (isShallow === "true") {
            const rawShallowPath = (yield* query(root, [
              "rev-parse",
              "--git-path",
              "shallow",
            ])).trim();
            const shallowPath = path.isAbsolute(rawShallowPath)
              ? rawShallowPath
              : path.resolve(root, rawShallowPath);
            if (yield* fs.exists(shallowPath)) {
              yield* fs.copyFile(shallowPath, path.join(directory, "source.shallow"));
              archiveMembers.push("source.shallow");
            }
          }
        }
        const deleted = new Set((yield* query(root, ["ls-files", "--deleted", "-z"])).split("\0"));
        const files = (yield* query(root, [
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "--deduplicate",
          "-z",
        ]))
          .split("\0")
          .filter((file) => file !== "" && !deleted.has(file));
        const list = path.join(directory, "files");
        yield* fs.writeFileString(list, files.length === 0 ? "" : `${files.join("\0")}\0`);
        yield* run(
          "tar",
          ["-cf", path.join(directory, "working-tree.tar"), "--null", "--no-recursion", "-T", list],
          root,
        );
        archiveMembers.push("working-tree.tar");
        const archive = path.join(directory, "checkout.tar");
        yield* run("tar", ["-cf", archive, ...archiveMembers], directory);
        const remoteRoot = yield* manager.withConnection(resourceId, (target) =>
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(
                yield* resolveSshCommand,
                [
                  ...baseSshArgs(target, { batchMode: "yes" }),
                  "-o",
                  "ServerAliveInterval=15",
                  "-o",
                  "ServerAliveCountMax=3",
                  "--",
                  yield* buildSshHostSpecEffect(target),
                  "sh",
                  "-c",
                  shellSingleQuote(installScript(resourceId)),
                ],
                { stdin: { stream: fs.stream(archive), endOnDone: true }, stderr: "pipe" },
              ),
            );
            const [output, stderr, code] = yield* Effect.all(
              [
                child.stdout.pipe(Stream.decodeText(), Stream.mkString),
                child.stderr.pipe(Stream.decodeText(), Stream.mkString),
                child.exitCode,
              ],
              { concurrency: "unbounded" },
            );
            if (code !== 0 || !output.trim().startsWith("/")) {
              yield* Effect.logWarning("Remote sandbox checkout install failed.", {
                resourceId,
                exitCode: code,
                stderr: stderr.slice(0, 2_000),
              });
              return yield* new WorktreeMcpFailure({
                code: "operation_failed",
                message: "The sandbox checkout could not be installed.",
              });
            }
            return output.trim();
          }),
        );
        return prefix === "" ? remoteRoot : `${remoteRoot.replace(/\/+$/, "")}/${prefix}`;
      },
      Effect.scoped,
      Effect.tapError((cause) =>
        Effect.logWarning("Cloud sandbox checkout transfer failed.", { cause }),
      ),
      Effect.mapError((cause) =>
        isWorktreeMcpFailure(cause)
          ? cause
          : new WorktreeMcpFailure({
              code: "operation_failed",
              message: "The source checkout could not be transferred into the sandbox.",
            }),
      ),
    ),
  });
});
export const layer = Layer.effect(CloudSandboxProjectTransfer, make);
