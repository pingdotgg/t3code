// @effect-diagnostics nodeBuiltinImport:off
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ExtensionOperationError,
} from "@t3tools/contracts";
import {
  EDITABLE_TEXT_MAX_BYTES,
  textEditsApi,
  validateReadSnapshotInput,
  validateSaveInput,
} from "@t3tools/extension-sdk/catalogue";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import type { HostApiProvider } from "@t3tools/extension-runtime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { WorkspaceEntries } from "../workspace/WorkspaceEntries.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";
import {
  readEditableFile,
  decodeEditableUtf8,
  replaceEditableFile,
} from "../workspace/textEdits.ts";
import { makeExtensionScopeResolver } from "./scope.ts";

const failure = (detail: string) =>
  new ExtensionOperationError({ operation: "workspace.text-edits", detail });
const isOperationError = Schema.is(ExtensionOperationError);

export type TextEditsApiDependencies = Parameters<typeof makeExtensionScopeResolver>[0] & {
  readonly readEditableFile?: typeof readEditableFile;
  readonly replaceEditableFile?: typeof replaceEditableFile;
  readonly entries: Pick<WorkspaceEntries["Service"], "refresh">;
  readonly paths: WorkspacePaths["Service"];
};

/** Shape of the broker's per-invocation metadata used by this provider. */
export type TextEditsMetadata = {
  readonly principal?:
    | { readonly environmentId: string; readonly scopes: readonly string[] }
    | undefined;
  readonly assertAuthority?: () => Promise<void>;
};

type Authority = {
  readonly assertAuthority: () => Promise<void>;
  readonly requireScope: (scope: string) => Effect.Effect<void, ExtensionOperationError>;
};

/** Capture authority pieces once; every later re-check uses the same closure. */
const authority = (
  dependencies: TextEditsApiDependencies,
  metadata: TextEditsMetadata,
): Effect.Effect<Authority, ExtensionOperationError> =>
  Effect.sync(() => {
    if (!metadata.assertAuthority) throw failure("Editable text authority is unavailable.");
    const assertAuthority = metadata.assertAuthority;
    const principal = metadata.principal;
    if (!principal || principal.environmentId !== dependencies.environmentId)
      throw failure("Editable text authority is unavailable.");
    return {
      assertAuthority,
      requireScope: (scope) =>
        principal.scopes.includes(scope)
          ? Effect.void
          : Effect.fail(
              failure(
                "Editable text request requires the authenticated session scope for this method.",
              ),
            ),
    };
  });

/**
 * Host provider for t3.workspace/text-edits@1.1.0 (satisfies ^1.0.0 ranges).
 *
 * readSnapshot needs an authenticated principal carrying orchestration:read;
 * save needs orchestration:operate in addition to the transport write scope
 * and the broker's write-effect gate — access:write alone is not enough.
 * metadata.assertAuthority is captured and awaited immediately before the
 * commit and again before the result is produced; the broker re-checks after
 * the provider returns and suppresses revoked or stale results.
 */
export function createTextEditsApiProvider(
  dependencies: TextEditsApiDependencies,
): HostApiProvider {
  const resolve = makeExtensionScopeResolver(dependencies);
  const read = dependencies.readEditableFile ?? readEditableFile;
  const replace = dependencies.replaceEditableFile ?? replaceEditableFile;
  const invoke = Effect.fn("TextEditsApi.invoke")(function* (
    method: string,
    input: unknown,
    context: ViewContext,
    signal: AbortSignal,
    metadata: TextEditsMetadata,
  ) {
    signal.throwIfAborted();
    const auth = yield* authority(dependencies, metadata);
    if (method === "readSnapshot") {
      const safe = yield* Effect.try({
        try: () => validateReadSnapshotInput(input),
        catch: (cause) =>
          isOperationError(cause) ? cause : failure("Invalid editable text request."),
      });
      const scope = yield* resolve(context).pipe(
        Effect.mapError(() => failure("Editable text is unavailable for this request.")),
      );
      yield* auth.requireScope(AuthOrchestrationReadScope);
      const result = yield* read({
        cwd: scope.cwd,
        relativePath: safe.relativePath,
      }).pipe(Effect.mapError(() => failure("Workspace resource cannot be accessed.")));
      yield* resolve(scope.context).pipe(
        Effect.mapError(() => failure("Editable text is unavailable for this request.")),
      );
      yield* Effect.tryPromise({
        try: () => auth.assertAuthority(),
        catch: () => failure("Editable text authority is no longer authorized."),
      });
      signal.throwIfAborted();
      if (result.outcome === "error")
        return {
          kind: "not-editable" as const,
          relativePath: safe.relativePath,
          reason: result.reason,
        };
      return {
        kind: "editable" as const,
        relativePath: safe.relativePath,
        // Same BOM-preserving decode as the IO boundary: a leading EF BB BF
        // survives as U+FEFF so the save below re-encodes it byte-identically.
        contents: decodeEditableUtf8(result.bytes) ?? "",
        revision: result.revision,
      };
    }
    if (method === "save") {
      const safe = yield* Effect.try({
        try: () => validateSaveInput(input),
        catch: (cleaned) =>
          isOperationError(cleaned)
            ? cleaned
            : failure(
                `Invalid editable text request: ${cleaned instanceof Error ? cleaned.message : String(cleaned)}`,
              ),
      });
      const scope = yield* resolve(context).pipe(
        Effect.mapError(() => failure("Editable text is unavailable for this request.")),
      );
      yield* auth.requireScope(AuthOrchestrationOperateScope);
      // Pre-commit authority barrier, awaited by the IO boundary inside the
      // per-realpath lock immediately before the rename: the original scope
      // must still resolve to the same root, the broker's current-authority
      // re-check must pass, and the signal must still be live. A rejection
      // here aborts the commit (original bytes retained).
      const beforeCommit = async () => {
        const current = await Effect.runPromise(
          resolve(scope.context).pipe(
            Effect.mapError(() => failure("Editable text is unavailable for this request.")),
          ),
        ).catch(() => {
          throw failure("Editable text is unavailable for this request.");
        });
        if (current.cwd !== scope.cwd)
          throw failure("Editable text is unavailable for this request.");
        await auth.assertAuthority();
        if (signal.aborted) throw failure("Editable text save was aborted before commit.");
      };
      const replaceOutcome = yield* replace({
        cwd: scope.cwd,
        relativePath: safe.relativePath,
        expectedRevision: safe.expectedRevision,
        contents: safe.contents,
        shouldAbort: () => signal.aborted,
        beforeCommit,
      }).pipe(Effect.mapError(() => failure("Workspace resource cannot be accessed.")));
      // A definitive error outcome means the commit never landed: report it
      // before the delivery re-checks, which only guard a result the broker
      // would hand out. The broker's own post-return check still runs.
      if (replaceOutcome.outcome === "error")
        return yield* failure(
          replaceOutcome.reason === "aborted"
            ? signal.aborted
              ? "Editable text save was aborted before commit."
              : "Editable text save was not committed: authority or scope changed before commit."
            : replaceOutcome.reason === "oversized"
              ? `Editable text contents exceed the ${EDITABLE_TEXT_MAX_BYTES}-byte editable bound.`
              : `Workspace resource cannot be accessed (${replaceOutcome.reason}).`,
        );
      // Immediately before the result leaves the provider: a revoked session
      // or moved workspace suppresses the outcome the broker would deliver. A
      // rejection after a landed commit is the caller's outcome-unknown case.
      yield* resolve(scope.context).pipe(
        Effect.mapError(() => failure("Editable text is unavailable for this request.")),
      );
      yield* Effect.tryPromise({
        try: () => auth.assertAuthority(),
        catch: () => failure("Editable text authority is no longer authorized."),
      });
      signal.throwIfAborted();
      if (replaceOutcome.outcome === "conflict")
        return { kind: "conflict" as const, relativePath: safe.relativePath };
      // F5: an index-refresh failure after a confirmed commit is logged, not
      // reported as a failed write; the caller rereads on any ambiguity.
      yield* dependencies.entries
        .refresh(scope.cwd)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Workspace index refresh failed after editable save", { cause }),
          ),
        );
      return {
        kind: "saved" as const,
        relativePath: safe.relativePath,
        revision: replaceOutcome.revision,
      };
    }
    return yield* failure("Editable text API method is unavailable.");
  });
  return {
    providerId: "host.text-edits",
    definition: textEditsApi.definition,
    requiresRootAuthority: true,
    invoke: (method, input, context, signal, metadata) =>
      Effect.runPromise(
        invoke(method, input, context, signal, metadata).pipe(
          Effect.provideService(WorkspacePaths, dependencies.paths),
        ),
        { signal },
      ),
  };
}

export const makeTextEditsApiProvider = Effect.fn("TextEditsApi.make")(function* () {
  const environment = yield* ServerEnvironment;
  const paths = yield* WorkspacePaths;
  return createTextEditsApiProvider({
    environmentId: yield* environment.getEnvironmentId,
    projects: yield* ProjectionProjectRepository,
    threads: yield* ProjectionThreadRepository,
    entries: yield* WorkspaceEntries,
    paths,
  });
});
