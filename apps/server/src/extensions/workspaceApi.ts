// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import { ExtensionOperationError } from "@t3tools/contracts";
import { WORKSPACE_FILES_API, type WorkspaceEntry } from "@t3tools/extension-sdk/catalogue";
import { MAX_PAYLOAD_BYTES, type Json, type ViewContext } from "@t3tools/extension-sdk/contracts";
import { validateWorkspaceReadTextInput } from "@t3tools/extension-sdk/workspace";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { WorkspaceFileSystem } from "../workspace/WorkspaceFileSystem.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";
import { makeExtensionScopeResolver } from "./scope.ts";
import { boundedWorkspaceText } from "./workspaceText.ts";

const listInput = Schema.decodeUnknownSync(
  Schema.Struct({
    relativePath: Schema.String.check(Schema.isMaxLength(512)),
    cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  }),
  { onExcessProperty: "error" },
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const cursorInput = Schema.decodeUnknownSync(
  Schema.Struct({
    fingerprint: Schema.String,
    offset: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  { onExcessProperty: "error" },
);
const failure = (detail: string) =>
  new ExtensionOperationError({ operation: "workspace.api", detail });
const isOperationError = Schema.is(ExtensionOperationError);
const ioFailure = () =>
  failure("Workspace resource cannot be accessed within the current project.");

/** Dependencies remain host-owned; callers supply only a scoped resource and relative path. */
export function createWorkspaceApiProvider(
  dependencies: Parameters<typeof makeExtensionScopeResolver>[0] & {
    readonly workspace: Pick<WorkspaceFileSystem["Service"], "readFile">;
    readonly paths: Pick<WorkspacePaths["Service"], "resolveRelativePathWithinRoot">;
    readonly path: Path.Path;
  },
) {
  const resolve = makeExtensionScopeResolver(dependencies);
  const { path } = dependencies;
  const list = Effect.fn("WorkspaceApi.list")(function* (
    input: unknown,
    scope: { readonly cwd: string; readonly context: ViewContext },
  ) {
    const safe = yield* Effect.try({
      try: () => {
        const value = listInput(input);
        if (value.relativePath !== "")
          validateWorkspaceReadTextInput({ relativePath: value.relativePath });
        return value;
      },
      catch: () => failure("Invalid workspace directory request."),
    });
    const target =
      safe.relativePath === ""
        ? { absolutePath: scope.cwd, relativePath: "" }
        : yield* dependencies.paths
            .resolveRelativePathWithinRoot({
              workspaceRoot: scope.cwd,
              relativePath: safe.relativePath,
            })
            .pipe(Effect.mapError(ioFailure));
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const root = await NodeFSP.realpath(scope.cwd);
        const directory = await NodeFSP.realpath(target.absolutePath);
        const relative = path.relative(root, directory);
        if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
          throw ioFailure();
        const before = await NodeFSP.stat(directory);
        const entries: WorkspaceEntry[] = [];
        // Fail explicitly on oversized directories instead of truncating an unpageable snapshot.
        let scanned = 0;
        const handle = await NodeFSP.opendir(directory);
        for await (const entry of handle) {
          signal.throwIfAborted();
          if (++scanned > 10000)
            throw failure("Workspace directory exceeds the 10,000-entry scan limit.");
          if (!entry.isFile() && !entry.isDirectory()) continue;
          const relativePath = target.relativePath
            ? target.relativePath + "/" + entry.name
            : entry.name;
          // Unrepresentable platform names and symbolic links are not public resources.
          try {
            validateWorkspaceReadTextInput({ relativePath });
          } catch {
            continue;
          }
          if (relativePath.length > 512) continue;
          entries.push({
            name: entry.name,
            relativePath,
            kind: entry.isDirectory() ? "directory" : "file",
          });
        }
        signal.throwIfAborted();
        const after = await NodeFSP.stat(directory);
        if (
          before.ino !== after.ino ||
          before.mtimeMs !== after.mtimeMs ||
          (await NodeFSP.realpath(target.absolutePath)) !== directory ||
          (await NodeFSP.realpath(scope.cwd)) !== root
        )
          throw failure("Workspace directory changed during listing; restart pagination.");
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const fingerprint = NodeCrypto.createHash("sha256")
          .update(encodeJson([scope.context, directory, after.ino, after.mtimeMs, entries]))
          .digest("hex");
        const cursor =
          safe.cursor === undefined
            ? undefined
            : cursorInput(decodeJson(Buffer.from(safe.cursor, "base64url").toString("utf8")));
        if (cursor && (cursor.fingerprint !== fingerprint || cursor.offset >= entries.length))
          throw failure("Workspace directory cursor is stale; restart pagination.");
        const offset = cursor?.offset ?? 0;
        let end = offset;
        let bytes = 2048;
        while (end < entries.length && end - offset < (safe.limit ?? 100)) {
          const entryBytes = Buffer.byteLength(encodeJson(entries[end]), "utf8") + 1;
          if (bytes + entryBytes > MAX_PAYLOAD_BYTES) break;
          bytes += entryBytes;
          end++;
        }
        return {
          entries: entries.slice(offset, end),
          nextCursor:
            end < entries.length
              ? Buffer.from(encodeJson({ fingerprint, offset: end })).toString("base64url")
              : null,
        };
      },
      catch: (cause) => (isOperationError(cause) ? cause : ioFailure()),
    });
  });
  const invoke = Effect.fn("WorkspaceApi.invoke")(function* (
    method: string,
    input: unknown,
    context: ViewContext,
  ) {
    const scope = yield* resolve(context);
    let result: Json;
    if (method === "listEntries") {
      result = yield* list(input, scope);
    } else if (method === "readText") {
      const safe = yield* Effect.try({
        try: () => {
          const value = validateWorkspaceReadTextInput(input);
          if (value.relativePath.length > 512)
            throw failure("Workspace path exceeds 512 characters.");
          return value;
        },
        catch: () => failure("Invalid workspace file request."),
      });
      const read = yield* dependencies.workspace
        .readFile({
          cwd: scope.cwd,
          relativePath: safe.relativePath,
        })
        .pipe(Effect.mapError(ioFailure));
      result = yield* Effect.try({
        try: () =>
          boundedWorkspaceText({
            ...read,
            contents: read.contents.slice(0, 48000).replace(/[\uD800-\uDBFF]$/, ""),
            truncated: read.truncated || read.contents.length > 48000,
          }),
        catch: ioFailure,
      });
    } else return yield* failure("Workspace API method is unavailable.");
    yield* resolve(scope.context);
    return result;
  });
  return {
    providerId: "host.workspace",
    definition: WORKSPACE_FILES_API,
    invoke: (
      method: string,
      input: Json,
      context: ViewContext,
      signal: AbortSignal,
    ): Promise<Json> => Effect.runPromise(invoke(method, input, context), { signal }),
  };
}

export const makeWorkspaceApiProvider = Effect.fn("WorkspaceApi.make")(function* () {
  const environment = yield* ServerEnvironment;
  return createWorkspaceApiProvider({
    environmentId: yield* environment.getEnvironmentId,
    projects: yield* ProjectionProjectRepository,
    threads: yield* ProjectionThreadRepository,
    workspace: yield* WorkspaceFileSystem,
    paths: yield* WorkspacePaths,
    path: yield* Path.Path,
  });
});
