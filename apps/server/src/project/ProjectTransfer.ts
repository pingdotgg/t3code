import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import {
  CommandId,
  ProjectId,
  ProjectTransferError,
  type ProjectTransferConfiguration,
  type ProjectTransferInput,
  type ProjectTransferResult,
} from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import {
  resolveProjectAgentBrowserAccess,
  resolveProjectAutoPull,
} from "@t3tools/shared/serverSettings";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { ProjectTransferFiles } from "./ProjectTransferFiles.ts";

const isProjectTransferError = Schema.is(ProjectTransferError);

interface Transfer {
  directory: string;
  file: string;
  byteLength: number;
  configuration: ProjectTransferConfiguration;
  destination?: string;
  mode: "clone" | "copy";
  projectId: ProjectId;
  createdAt: string;
  unpacked: boolean;
  registered: boolean;
}

export const makeProjectTransfer = Effect.fn("makeProjectTransfer")(function* () {
  const path = yield* Path.Path;
  const projects = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const settings = yield* ServerSettingsService;
  const git = yield* GitVcsDriver;
  const files = new ProjectTransferFiles();
  const transfers = new Map<string, Transfer>();
  const semaphore = yield* Semaphore.make(1);
  const io = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (error) =>
        new ProjectTransferError({
          message: error instanceof Error ? error.message : String(error),
        }),
    });
  const release = Effect.fn("ProjectTransfer.release")(function* (id: string) {
    const transfer = transfers.get(id);
    if (!transfer) return;
    if (transfer.destination && !transfer.registered)
      yield* io(() => files.remove(transfer.destination!));
    yield* io(() => files.remove(transfer.directory));
    transfers.delete(id);
  });
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...transfers.keys()], release).pipe(Effect.ignore),
  );

  const handle = Effect.fn("ProjectTransfer.handle")(
    function* (input: ProjectTransferInput): Effect.fn.Return<ProjectTransferResult, unknown> {
      if (input.operation === "release") {
        yield* release(input.transferId);
        return { operation: "release" };
      }
      if (input.operation === "prepare") {
        const found = yield* projects.getProjectShellById(input.projectId);
        if (Option.isNone(found))
          return yield* new ProjectTransferError({
            message: "The source project no longer exists.",
          });
        const project = found.value;
        const currentSettings = yield* settings.getSettings;
        const isGit = yield* git
          .execute({
            operation: "project.transfer.detect",
            cwd: project.workspaceRoot,
            args: ["rev-parse", "--is-inside-work-tree"],
            timeoutMs: 10_000,
          })
          .pipe(
            Effect.map((result) => result.stdout.trim() === "true"),
            Effect.orElseSucceed(() => false),
          );
        const remote = yield* git
          .execute({
            operation: "project.transfer.remote",
            cwd: project.workspaceRoot,
            args: ["remote", "get-url", "origin"],
            timeoutMs: 10_000,
          })
          .pipe(
            Effect.map((result) => result.stdout.trim() || null),
            Effect.catch(() => Effect.succeed(null)),
          );
        if (input.mode === "clone" && !remote)
          return yield* new ProjectTransferError({
            message: "This project has no origin remote. Choose a one-time copy.",
          });
        const configuration: ProjectTransferConfiguration = {
          project: {
            ...project,
            defaultModelSelection:
              project.defaultModelSelection ?? currentSettings.defaultModelSelection,
            defaultThreadEnvMode:
              project.defaultThreadEnvMode ?? currentSettings.defaultThreadEnvMode,
            autoPull: resolveProjectAutoPull(currentSettings, project.id, project.autoPull),
            scripts: resolveProjectScripts(currentSettings, project),
          },
          agentBrowserAccess: resolveProjectAgentBrowserAccess(currentSettings, project.id),
          remoteUrl: remote,
        };
        const directory = yield* io(() => files.temporaryDirectory());
        const transferId = files.id();
        const transfer: Transfer = {
          directory,
          file: path.join(directory, "snapshot.tar"),
          byteLength: 0,
          configuration,
          mode: input.mode,
          projectId: ProjectId.make(files.id()),
          createdAt: DateTime.formatIso(yield* DateTime.now),
          unpacked: false,
          registered: false,
        };
        transfers.set(transferId, transfer);
        yield* Effect.gen(function* () {
          if (input.mode === "copy") {
            const ignored = new Set<string>();
            if (!input.includeIgnored && isGit) {
              const result = yield* git.execute({
                operation: "project.transfer.ignored",
                cwd: project.workspaceRoot,
                args: [
                  "ls-files",
                  "--others",
                  "--ignored",
                  "--exclude-standard",
                  "--directory",
                  "-z",
                ],
                maxOutputBytes: 32 * 1024 * 1024,
              });
              if (result.stdoutTruncated)
                return yield* new ProjectTransferError({
                  message:
                    "Too many ignored files to list. Include ignored files or use a fresh clone.",
                });
              for (const name of result.stdout.split("\0"))
                if (name) ignored.add(name.replace(/\/$/, ""));
            }
            let snapshotRoot = project.workspaceRoot;
            if (yield* io(() => files.isLinkedCheckout(project.workspaceRoot))) {
              // A worktree's .git file points outside its root. Materialize an independent
              // repository, then restore the source index so staged work stays staged.
              snapshotRoot = path.join(directory, "checkout");
              yield* git.execute({
                operation: "project.transfer.materialize",
                cwd: directory,
                args: [
                  "clone",
                  "--no-hardlinks",
                  "--no-checkout",
                  "--",
                  project.workspaceRoot,
                  snapshotRoot,
                ],
                timeoutMs: 600_000,
              });
              const index = yield* git.execute({
                operation: "project.transfer.index",
                cwd: project.workspaceRoot,
                args: ["rev-parse", "--path-format=absolute", "--git-path", "index"],
              });
              yield* io(() =>
                files.overlayCheckout(project.workspaceRoot, snapshotRoot, index.stdout.trim()),
              );
              yield* git.execute({
                operation: "project.transfer.origin",
                cwd: snapshotRoot,
                args: remote
                  ? ["remote", "set-url", "origin", remote]
                  : ["remote", "remove", "origin"],
              });
            }
            const archive = yield* io(() => files.pack(snapshotRoot, directory, ignored));
            transfer.byteLength = archive.byteLength;
          }
        }).pipe(Effect.onError(() => release(transferId).pipe(Effect.ignore)));
        return { operation: "prepare", transferId, configuration, byteLength: transfer.byteLength };
      }
      if (input.operation === "begin") {
        if (input.mode === "clone" && !input.configuration.remoteUrl)
          return yield* new ProjectTransferError({
            message: "A fresh clone requires a repository remote.",
          });
        const directory = yield* io(() => files.temporaryDirectory());
        const destination = yield* io(() => files.reserve(input.destinationPath)).pipe(
          Effect.onError(() => io(() => files.remove(directory)).pipe(Effect.ignore)),
        );
        const transferId = files.id();
        transfers.set(transferId, {
          directory,
          file: path.join(directory, "snapshot.tar"),
          destination,
          mode: input.mode,
          configuration: input.configuration,
          byteLength: input.byteLength,
          projectId: ProjectId.make(files.id()),
          createdAt: DateTime.formatIso(yield* DateTime.now),
          unpacked: false,
          registered: false,
        });
        return { operation: "begin", transferId };
      }
      const transfer = transfers.get(input.transferId);
      if (!transfer)
        return yield* new ProjectTransferError({
          message: "This transfer expired. Start the copy again.",
        });
      if (input.operation === "read") {
        if (transfer.destination)
          return yield* new ProjectTransferError({ message: "This is not a source snapshot." });
        return {
          operation: "read",
          data: yield* io(() => files.read(transfer.file, input.offset, transfer.byteLength)),
        };
      }
      if (!transfer.destination)
        return yield* new ProjectTransferError({ message: "This is not a destination transfer." });
      if (input.operation === "write") {
        if (transfer.unpacked)
          return yield* new ProjectTransferError({ message: "This copy is already complete." });
        yield* io(() => files.write(transfer.file, input.offset, input.data, transfer.byteLength));
        return { operation: "write" };
      }
      const cwd = transfer.destination;
      if (!transfer.unpacked) {
        if (transfer.mode === "clone") {
          yield* git.execute({
            operation: "project.transfer.clone",
            cwd,
            args: ["clone", "--", transfer.configuration.remoteUrl!, "."],
            timeoutMs: 600_000,
            maxOutputBytes: 256 * 1024,
          });
        } else {
          yield* io(() => files.unpack(transfer.file, cwd, transfer.byteLength));
        }
        transfer.unpacked = true;
      }
      const project = transfer.configuration.project;
      // Once a durable project may exist, cancellation must never delete its checkout.
      transfer.registered = true;
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(`${input.transferId}:create`),
        projectId: transfer.projectId,
        workspaceRoot: cwd,
        title: project.title,
        createdAt: transfer.createdAt,
      });
      yield* engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.make(`${input.transferId}:configure`),
        projectId: transfer.projectId,
        defaultModelSelection: project.defaultModelSelection,
        defaultThreadEnvMode: project.defaultThreadEnvMode ?? null,
        autoPull: project.autoPull ?? false,
        projectIcon: project.projectIcon ?? null,
        scripts: project.scripts,
      });
      yield* settings.updateSettings({
        projectScriptOverrides: { [transfer.projectId]: [...project.scripts] },
        projectAutoPullOverrides: { [transfer.projectId]: project.autoPull ?? false },
        projectAgentBrowserAccessOverrides: {
          [transfer.projectId]: transfer.configuration.agentBrowserAccess,
        },
      });
      return { operation: "finish", projectId: transfer.projectId, cwd };
    },
    Effect.mapError((error) =>
      isProjectTransferError(error)
        ? error
        : new ProjectTransferError({
            message: error instanceof Error ? error.message : String(error),
          }),
    ),
  );
  return (input: ProjectTransferInput) => handle(input).pipe(semaphore.withPermits(1));
});
