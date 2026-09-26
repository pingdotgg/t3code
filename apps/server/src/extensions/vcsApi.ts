// @effect-diagnostics nodeBuiltinImport:off - the worktree-path containment check is a pure string transform outside a service context.
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  ExtensionOperationError,
  VcsUnsupportedOperationError,
  type VcsDriverKind,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult as NativeVcsStatusResult,
  type VcsStatusStreamEvent as NativeVcsStatusStreamEvent,
} from "@t3tools/contracts";
import {
  VCS_CHANGES_API,
  VCS_REFS_API,
  VCS_REPOSITORY_API,
  VCS_STATUS_API,
  type VcsCapabilitiesResult,
  type VcsChangeEntry,
  type VcsChangesListResult,
  type VcsEmptyResult,
  type VcsFetchResult,
  type VcsListRefsResult,
  type VcsListRemotesResult,
  type VcsOperationsSupport,
  type VcsPushResult,
  type VcsStatusLocal,
  type VcsStatusRemote,
  type VcsStatusResult,
  type VcsStatusStreamEvent,
} from "@t3tools/extension-sdk/catalogue";
import type { ApiStreamEvent } from "@t3tools/extension-sdk/capabilities";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import type {
  HostApiInvocationMetadata,
  HostApiPrincipal,
  HostApiProvider,
} from "@t3tools/extension-runtime";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as NodePath from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";
import { VcsProvisioningService } from "../vcs/VcsProvisioningService.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeExtensionScopeResolver } from "./scope.ts";

/**
 * The contract bounds the adapters enforce again server-side (the broker's
 * ajv pass runs first; these Effect decoders add `onExcessProperty: "error"`).
 */
const MAX_STATUS_FILES = 5_000;
const MAX_REF_NAME = 256;
/** Host-produced ref fields get a wider bound than inputs so a pathological
 *  native ref name cannot brick status/listing (contract: 4 096). */
const MAX_REF_NAME_OUTPUT = 4096;
const MAX_WORKTREE_PATH = 32_768;

const emptyInput = Schema.decodeUnknownSync(Schema.Struct({}), {
  onExcessProperty: "error",
});
const pathSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const pathsSchema = Schema.Array(pathSchema).check(Schema.isMinLength(1), Schema.isMaxLength(100));
const pathsInput = Schema.decodeUnknownSync(Schema.Struct({ paths: pathsSchema }), {
  onExcessProperty: "error",
});
/** `git check-ref-format` essentials — mirrors the contract-side allOf/not rules. */
const VCS_REF_NAME_PATTERN =
  // eslint-disable-next-line no-control-regex -- git refnames legitimately reject control characters.
  /^(?!@$)(?!-)(?!\/)(?!\.)(?!.*\.\.)(?!.*@\{)(?!.*[\x00-\x20~^:?*[\]\\])(?!.*\/\/)(?!.*\/\.)(?!.*[/.]$)(?!.*\.lock(?:\/|$)).+$/u;
const refNameSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_REF_NAME),
  Schema.isPattern(VCS_REF_NAME_PATTERN),
);
const refsListInput = Schema.decodeUnknownSync(
  Schema.Struct({
    query: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
    cursor: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    includeMatchingRemoteRefs: Schema.optional(Schema.Boolean),
    refKind: Schema.optional(Schema.Literals(["all", "local", "remote"])),
    refresh: Schema.optional(Schema.Boolean),
    limit: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
    ),
  }),
  { onExcessProperty: "error" },
);
const refCreateInput = Schema.decodeUnknownSync(
  Schema.Struct({
    refName: refNameSchema,
    switchRef: Schema.optional(Schema.Boolean),
  }),
  { onExcessProperty: "error" },
);
const refNameInput = Schema.decodeUnknownSync(Schema.Struct({ refName: refNameSchema }), {
  onExcessProperty: "error",
});
const commitInput = Schema.decodeUnknownSync(
  Schema.Struct({
    message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000)),
    paths: Schema.optional(pathsSchema),
  }),
  { onExcessProperty: "error" },
);
const initInput = Schema.decodeUnknownSync(
  Schema.Struct({ kind: Schema.optional(Schema.Literals(["git"])) }),
  { onExcessProperty: "error" },
);
const createWorktreeInput = Schema.decodeUnknownSync(
  Schema.Struct({
    refName: refNameSchema,
    newRefName: Schema.optional(refNameSchema),
    baseRefName: Schema.optional(refNameSchema),
    path: Schema.NullOr(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_WORKTREE_PATH)),
    ),
  }),
  { onExcessProperty: "error" },
);
const removeWorktreeInput = Schema.decodeUnknownSync(
  Schema.Struct({
    path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_WORKTREE_PATH)),
    force: Schema.optional(Schema.Boolean),
  }),
  { onExcessProperty: "error" },
);
/** Mirrors the contract-side remote-name bound: no `-` prefix or whitespace/controls. */
const VCS_REMOTE_NAME_PATTERN = /^[^-\s\p{Cc}][^\s\p{Cc}]{0,255}$/u;
const remoteNameSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_REF_NAME),
  Schema.isPattern(VCS_REMOTE_NAME_PATTERN),
);
const fetchInput = Schema.decodeUnknownSync(
  Schema.Struct({ remoteName: Schema.optional(remoteNameSchema) }),
  { onExcessProperty: "error" },
);

const failure = (operation: string, detail: string) =>
  new ExtensionOperationError({ operation, detail });
const isOperationError = Schema.is(ExtensionOperationError);

/**
 * Tag-preserving error mapping — a `VcsUnsupportedOperationError` (or any
 * tagged failure) surfaces its name so capability honesty is observable, not
 * a generic "failed".
 */
const operationError = (operation: string) => (cause: unknown) => {
  if (isOperationError(cause)) return cause;
  const tag =
    cause !== null &&
    typeof cause === "object" &&
    "_tag" in cause &&
    typeof (cause as { _tag: unknown })._tag === "string"
      ? (cause as { _tag: string })._tag
      : cause instanceof Error
        ? cause.name
        : undefined;
  const message = cause instanceof Error ? cause.message : "VCS operation failed.";
  return failure(operation, `${tag ? `${tag}: ` : ""}${message}`.slice(0, 512));
};

const withinStatusBounds = (local: VcsStatusLocalResult) =>
  (local.refName === null || local.refName.length <= MAX_REF_NAME_OUTPUT) &&
  (local.sourceControlProvider === undefined ||
    (local.sourceControlProvider.name.length <= 256 &&
      local.sourceControlProvider.baseUrl.length <= 2048));

const withinRemoteBounds = (remote: VcsStatusRemoteResult) =>
  remote.pr === null ||
  (remote.pr.title.length <= 512 &&
    remote.pr.url.length <= 2048 &&
    remote.pr.baseRef.length <= MAX_REF_NAME_OUTPUT &&
    remote.pr.headRef.length <= MAX_REF_NAME_OUTPUT &&
    (remote.pr.updatedAt === undefined ||
      remote.pr.updatedAt === null ||
      remote.pr.updatedAt.length <= 64));

/** Adds the declared truncation flag and drops over-bound paths honestly. */
const toPublicLocal = (local: VcsStatusLocalResult): VcsStatusLocal => {
  const inBoundFiles = local.workingTree.files.filter((file) => file.path.length <= 512);
  const files = inBoundFiles.slice(0, MAX_STATUS_FILES);
  return {
    isRepo: local.isRepo,
    ...(local.sourceControlProvider === undefined
      ? {}
      : { sourceControlProvider: local.sourceControlProvider }),
    hasPrimaryRemote: local.hasPrimaryRemote,
    isDefaultRef: local.isDefaultRef,
    refName: local.refName,
    hasWorkingTreeChanges: local.hasWorkingTreeChanges,
    workingTree: {
      files,
      insertions: local.workingTree.insertions,
      deletions: local.workingTree.deletions,
      truncated: files.length < local.workingTree.files.length,
    },
  };
};

const toPublicRemote = (remote: VcsStatusRemoteResult): VcsStatusRemote => ({
  hasUpstream: remote.hasUpstream,
  aheadCount: remote.aheadCount,
  behindCount: remote.behindCount,
  ...(remote.aheadOfDefaultCount === undefined
    ? {}
    : { aheadOfDefaultCount: remote.aheadOfDefaultCount }),
  pr:
    remote.pr === null
      ? null
      : {
          number: remote.pr.number,
          title: remote.pr.title,
          url: remote.pr.url,
          baseRef: remote.pr.baseRef,
          headRef: remote.pr.headRef,
          state: remote.pr.state,
          ...(remote.pr.isDraft === undefined ? {} : { isDraft: remote.pr.isDraft }),
          ...(remote.pr.updatedAt === undefined ? {} : { updatedAt: remote.pr.updatedAt }),
        },
});

const toPublicStatus = (status: NativeVcsStatusResult): VcsStatusResult => ({
  ...toPublicLocal(status),
  ...toPublicRemote(status),
});

const toStreamEvent = (event: NativeVcsStatusStreamEvent): VcsStatusStreamEvent => {
  switch (event._tag) {
    case "snapshot":
      return {
        kind: "snapshot",
        local: toPublicLocal(event.local),
        remote: event.remote === null ? null : toPublicRemote(event.remote),
      };
    case "localUpdated":
      return { kind: "localUpdated", local: toPublicLocal(event.local) };
    case "remoteUpdated":
      return {
        kind: "remoteUpdated",
        remote: event.remote === null ? null : toPublicRemote(event.remote),
      };
  }
};

/** Parse `git status --porcelain=v1 -z` records into per-path index state. */
export function parsePorcelainStatus(stdout: string, truncated = false): VcsChangeEntry[] {
  const records = stdout.split("\0");
  // A truncated capture can end mid-record with no terminating NUL; the final
  // fragment is not trustworthy enough to report as a path.
  if (truncated && !stdout.endsWith("\0")) records.pop();
  const entries: VcsChangeEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4) continue;
    const x = record[0]!;
    const y = record[1]!;
    const filePath = record.slice(3);
    if (x === "!") continue;
    // With -z a rename/copy record is `XY <new>` followed by a separate
    // NUL-terminated origin record; the destination path is the live one.
    // Rename/copy may appear in either column (worktree renames land in Y).
    if (x === "R" || x === "C" || y === "R" || y === "C") index += 1;
    if (x === "?" && y === "?") {
      entries.push({
        path: filePath,
        staged: false,
        unstaged: false,
        untracked: true,
        conflicted: false,
      });
      continue;
    }
    const conflicted =
      x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
    entries.push({
      path: filePath,
      staged: !conflicted && x !== " " && x !== "?",
      unstaged: !conflicted && y !== " " && y !== "?",
      untracked: false,
      conflicted,
    });
  }
  return entries;
}

/** Projects the native refs payload to the bounded public shape. */
const toPublicListRefs = (result: {
  readonly refs: ReadonlyArray<{
    readonly name: string;
    readonly isRemote?: boolean | undefined;
    readonly remoteName?: string | undefined;
    readonly current: boolean;
    readonly isDefault: boolean;
    readonly worktreePath: string | null;
  }>;
  readonly isRepo: boolean;
  readonly hasPrimaryRemote: boolean;
  readonly nextCursor: number | null;
  readonly totalCount: number;
}): VcsListRefsResult => ({
  refs: result.refs.map((ref) => ({
    name: ref.name,
    ...(ref.isRemote === undefined ? {} : { isRemote: ref.isRemote }),
    ...(ref.remoteName === undefined ? {} : { remoteName: ref.remoteName }),
    current: ref.current,
    isDefault: ref.isDefault,
    worktreePath: ref.worktreePath,
  })),
  isRepo: result.isRepo,
  hasPrimaryRemote: result.hasPrimaryRemote,
  nextCursor: result.nextCursor,
  totalCount: result.totalCount,
});

const unsupported = (operation: string, kind: VcsDriverKind, detail: string) =>
  new VcsUnsupportedOperationError({ operation, kind, detail });

/**
 * Remote URLs can carry `user:password@` userinfo; the wire shape never
 * transports credentials, so a URL with a password loses its userinfo
 * verbatim. Scp-style and path remotes are not URLs, and username-only
 * userinfo (ssh `git@host`) carries no secret — both pass through untouched.
 * A malformed URL still loses a `scheme:userinfo@` prefix — unvalidated
 * text must not transport credentials either. Control characters are
 * non-printable: they are stripped before matching so they cannot
 * interrupt the prefix, and separators may be `/`, `\`, mixed, or absent.
 */
const MALFORMED_URL_USERINFO = /^(\s*[a-zA-Z][a-zA-Z0-9+.-]*:[/\\\s]*)[^/?#\\\s]*@/;
const CONTROL_CHARS = /[\p{Cc}]/gu;
const redactRemoteUrl = (value: string): string => {
  try {
    const url = new URL(value);
    if (url.password === "") return value;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value.replace(CONTROL_CHARS, "").replace(MALFORMED_URL_USERINFO, "$1");
  }
};

const operationsSupport = (
  handle: {
    readonly kind: VcsDriverKind;
    readonly driver: {
      readonly capabilities: { readonly supportsWorktrees: boolean };
      readonly getDiffPreview?: unknown;
    };
  } | null,
): VcsOperationsSupport => {
  const git = handle?.kind === "git";
  const worktrees = git && handle.driver.capabilities.supportsWorktrees;
  return {
    "status.get": git,
    "status.refresh": git,
    "status.subscribe": git,
    "refs.list": git,
    "refs.create": git,
    "refs.switch": git,
    "changes.list": git,
    "changes.stage": git,
    "changes.unstage": git,
    "changes.commit": git,
    // ReviewService falls back to the git driver path and otherwise honors a
    // driver's own `getDiffPreview` hook; file-contents expansion is git-only.
    "diff.getPreview": handle !== null && (git || handle.driver.getDiffPreview !== undefined),
    "diff.getFileContents": git,
    "repository.pull": git,
    // Provisioning is registered-driver work, not repository state.
    "repository.init": true,
    "repository.createWorktree": worktrees,
    "repository.removeWorktree": worktrees,
    "repository.push": git,
    "repository.fetch": git,
    // listRemotes is a required VcsDriver method — any detected driver serves it.
    "repository.listRemotes": handle !== null,
  };
};
const NO_OPERATIONS = operationsSupport(null);

interface ScopeDependencies {
  readonly environmentId: string;
  readonly projects: Parameters<typeof makeExtensionScopeResolver>[0]["projects"];
  readonly threads: Parameters<typeof makeExtensionScopeResolver>[0]["threads"];
}

interface VcsApiDependencies extends ScopeDependencies {
  readonly vcsStatus: Pick<
    VcsStatusBroadcaster["Service"],
    "getStatus" | "refreshStatus" | "streamStatus"
  >;
  readonly gitWorkflow: Pick<
    GitWorkflowService["Service"],
    | "listRefs"
    | "createRef"
    | "switchRef"
    | "pullCurrentBranch"
    | "fetchRemote"
    | "createWorktree"
    | "removeWorktree"
  >;
  readonly git: Pick<
    GitVcsDriver["Service"],
    "execute" | "prepareCommitContext" | "commit" | "pushCurrentBranch"
  >;
  readonly vcsRegistry: Pick<VcsDriverRegistry["Service"], "detect" | "resolve">;
  readonly vcsProvisioning: Pick<VcsProvisioningService["Service"], "initRepository">;
  readonly worktreesDir: string;
  readonly automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>;
}

type Scope = Effect.Success<ReturnType<ReturnType<typeof makeExtensionScopeResolver>>>;
type MethodHandler = (call: {
  readonly input: unknown;
  readonly context: ViewContext;
  readonly signal: AbortSignal;
  readonly metadata: HostApiInvocationMetadata;
}) => Effect.Effect<Json, ExtensionOperationError>;

export function createVcsApiProviders(dependencies: VcsApiDependencies): HostApiProvider[] {
  const resolve = makeExtensionScopeResolver(dependencies);
  const authorized = (
    principal: HostApiPrincipal | undefined,
    scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
  ) =>
    principal !== undefined &&
    principal.environmentId === dependencies.environmentId &&
    principal.scopes.includes(scope);

  /**
   * Worktree paths must resolve inside the host-owned worktrees directory —
   * a caller-supplied absolute path could otherwise materialize a checkout
   * anywhere on disk, and a `-`-prefixed path would inject `git worktree`
   * options. Mirrors the ReviewService workspace-bound check.
   */
  const resolveWorktreePath = (
    operation: string,
    input: string,
  ): Effect.Effect<string, ExtensionOperationError> => {
    const resolved = NodePath.resolve(dependencies.worktreesDir, input);
    const relative = NodePath.relative(dependencies.worktreesDir, resolved);
    if (relative === "" || relative.startsWith("..") || NodePath.isAbsolute(relative)) {
      return Effect.fail(
        new ExtensionOperationError({
          operation,
          detail: "Worktree path must resolve inside the host worktrees directory.",
        }),
      );
    }
    return Effect.succeed(resolved);
  };

  /**
   * Capability gate for git-only operations. Mutations and the porcelain
   * changes feed never degrade to an empty result: undetected or non-git
   * drivers fail with a named VcsUnsupportedOperationError.
   */
  const requireGit = Effect.fn("VcsApi.requireGit")(function* (operation: string, cwd: string) {
    const handle = yield* dependencies.vcsRegistry
      .resolve({ cwd })
      .pipe(Effect.mapError(operationError(operation)));
    if (handle.kind !== "git") {
      return yield* unsupported(
        operation,
        handle.kind,
        `The ${operation} operation currently supports Git repositories only; detected ${handle.kind}.`,
      );
    }
    return handle;
  });

  /** Mirrors ws.ts `refreshGitStatus`: detached so callers never wait on it. */
  const refreshAfterMutation = (cwd: string) =>
    dependencies.vcsStatus
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  const runMethod = <Input, Output extends Json>(args: {
    readonly operation: string;
    readonly requiredScope:
      | typeof AuthOrchestrationReadScope
      | typeof AuthOrchestrationOperateScope;
    readonly decode: (input: unknown) => Input;
    readonly run: (safe: Input, scope: Scope) => Effect.Effect<Output, Error>;
    readonly refreshAfter?: boolean;
  }): MethodHandler =>
    Effect.fn("VcsApi.invoke")(function* ({ input, context, signal, metadata }) {
      signal.throwIfAborted();
      if (!authorized(metadata.principal, args.requiredScope)) {
        return yield* failure(args.operation, "VCS authority is unavailable.");
      }
      const safe = yield* Effect.try({
        try: () => args.decode(input),
        catch: () => failure(args.operation, "Invalid VCS request input."),
      });
      const scope = yield* resolve(context);
      const result = yield* args
        .run(safe, scope)
        .pipe(Effect.mapError(operationError(args.operation)));
      if (args.refreshAfter) yield* refreshAfterMutation(scope.cwd);
      yield* Effect.tryPromise({
        try: () => metadata.assertAuthority?.() ?? Promise.resolve(),
        catch: () => failure(args.operation, "VCS authority was revoked."),
      });
      yield* resolve(scope.context);
      signal.throwIfAborted();
      return result;
    });

  const statusResult = Effect.fn("VcsApi.statusResult")(function* (
    operation: string,
    read: Effect.Effect<NativeVcsStatusResult, Error>,
  ) {
    const status = yield* read;
    if (!withinStatusBounds(status) || !withinRemoteBounds(status)) {
      return yield* failure(operation, "VCS status exceeds the public bounds.");
    }
    return toPublicStatus(status);
  });

  const invokeProvider =
    (operations: Record<string, MethodHandler>) =>
    (
      method: string,
      input: unknown,
      context: ViewContext,
      signal: AbortSignal,
      metadata: HostApiInvocationMetadata,
    ) => {
      const handler = operations[method];
      if (!handler)
        return Effect.runPromise(
          Effect.fail(failure(`vcs.${method}`, "VCS API method is unavailable.")),
          { signal },
        );
      return Effect.runPromise(handler({ input, context, signal, metadata }), { signal });
    };

  const statusApi: HostApiProvider = {
    providerId: "t3.host-vcs-status",
    definition: VCS_STATUS_API,
    requiresRootAuthority: true,
    invoke: invokeProvider({
      get: runMethod({
        operation: "vcs.status.get",
        requiredScope: AuthOrchestrationReadScope,
        decode: emptyInput,
        run: (_safe, scope) =>
          statusResult("vcs.status.get", dependencies.vcsStatus.getStatus({ cwd: scope.cwd })),
      }),
      refresh: runMethod({
        operation: "vcs.status.refresh",
        requiredScope: AuthOrchestrationReadScope,
        decode: emptyInput,
        run: (_safe, scope) =>
          statusResult("vcs.status.refresh", dependencies.vcsStatus.refreshStatus(scope.cwd)),
      }),
    }),
    subscribe: (name, input, context, signal, metadata, resumeCursor) => {
      if (name !== "subscribe")
        throw failure("vcs.status.subscribe", "VCS status stream is unavailable.");
      if (resumeCursor !== undefined)
        throw failure("vcs.status.subscribe", "VCS status stream resume is unsupported.");
      try {
        emptyInput(input);
      } catch {
        throw failure("vcs.status.subscribe", "Invalid VCS status subscription request.");
      }
      if (!authorized(metadata.principal, AuthOrchestrationReadScope))
        throw failure("vcs.status.subscribe", "VCS authority is unavailable.");

      const maxQueuedEvents = 64;
      const queue: ApiStreamEvent[] = [];
      let finished = false;
      let aborted = signal.aborted;
      let wake: (() => void) | null = null;
      let cleanup: (() => void) | null = null;
      let setup: Promise<void> | null = null;
      let setupFailure: unknown = null;
      const controller = new AbortController();
      const runSignal = AbortSignal.any([signal, controller.signal]);
      let removeAbortListener: (() => void) | null = null;

      const finish = () => {
        finished = true;
        cleanup?.();
        cleanup = null;
        removeAbortListener?.();
        removeAbortListener = null;
        wake?.();
        wake = null;
      };
      const pushClosed = (reason: "overflow" | "status-error") => {
        queue.length = 0;
        queue.push({
          type: "closed",
          value: { kind: "closed", reason } satisfies VcsStatusStreamEvent,
        });
        finish();
      };
      const push = (event: ApiStreamEvent) => {
        if (finished || aborted) return;
        if (queue.length >= maxQueuedEvents) {
          pushClosed("overflow");
        } else {
          queue.push(event);
        }
        wake?.();
        wake = null;
      };
      const offer = (event: NativeVcsStatusStreamEvent) => {
        try {
          if (event._tag !== "remoteUpdated" && !withinStatusBounds(event.local)) {
            pushClosed("status-error");
            return;
          }
          if (
            event._tag !== "localUpdated" &&
            event.remote !== null &&
            !withinRemoteBounds(event.remote)
          ) {
            pushClosed("status-error");
            return;
          }
          const value = toStreamEvent(event);
          push({ type: value.kind === "snapshot" ? "snapshot" : "data", value });
        } catch {
          pushClosed("status-error");
        }
      };
      const abort = () => {
        aborted = true;
        controller.abort();
        queue.length = 0;
        finish();
        wake?.();
        wake = null;
      };
      signal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", abort);

      const iterable: AsyncIterable<ApiStreamEvent> = {
        [Symbol.asyncIterator]() {
          let returned = false;
          // Only an external cancel poisons the iterator; an internal
          // controller.abort() on stream completion must still let queued
          // events drain before `done`.
          const failIfAborted = () => {
            if (aborted)
              throw runSignal.reason ?? failure("vcs.status.subscribe", "Stream cancelled.");
          };
          const finishIterator = async () => {
            controller.abort();
            finish();
          };
          return {
            async next() {
              if (returned) return { done: true, value: undefined };
              failIfAborted();
              setup ??= (async () => {
                try {
                  const scope = await Effect.runPromise(resolve(context), {
                    signal: runSignal,
                  });
                  await metadata.assertAuthority?.();
                  const stream = dependencies.vcsStatus.streamStatus(
                    { cwd: scope.cwd },
                    {
                      automaticRemoteRefreshInterval: dependencies.automaticRemoteRefreshInterval,
                    },
                  );
                  cleanup = () => controller.abort();
                  Effect.runPromise(
                    Stream.runForEach(stream, (event) => Effect.sync(() => offer(event))),
                    { signal: runSignal },
                  ).then(
                    () => finish(),
                    () => pushClosed("status-error"),
                  );
                } catch (error) {
                  setupFailure = error;
                  finish();
                  throw error;
                }
              })();
              try {
                await setup;
                if (setupFailure !== null) throw setupFailure;
                failIfAborted();
                // The native stream callback may finish this observer while next() waits.
                // eslint-disable-next-line no-unmodified-loop-condition
                while (queue.length === 0 && !finished) {
                  await new Promise<void>((resolveWait) => {
                    wake = resolveWait;
                  });
                  failIfAborted();
                }
                failIfAborted();
                const value = queue.shift();
                if (!value) {
                  await finishIterator();
                  returned = true;
                  return { done: true, value: undefined };
                }
                return { done: false, value };
              } catch (error) {
                await finishIterator();
                returned = true;
                throw error;
              }
            },
            async return() {
              returned = true;
              abort();
              await finishIterator();
              return { done: true, value: undefined };
            },
          };
        },
      };
      return iterable;
    },
  };

  const refsApi: HostApiProvider = {
    providerId: "t3.host-vcs-refs",
    definition: VCS_REFS_API,
    requiresRootAuthority: true,
    invoke: invokeProvider({
      list: runMethod({
        operation: "vcs.refs.list",
        requiredScope: AuthOrchestrationReadScope,
        decode: refsListInput,
        run: (safe, scope) =>
          dependencies.gitWorkflow
            // Contract allows `query: ""` (cleared search field); normalize to absent.
            .listRefs({ cwd: scope.cwd, ...safe, query: safe.query || undefined })
            .pipe(Effect.map(toPublicListRefs)),
      }),
      create: runMethod({
        operation: "vcs.refs.create",
        requiredScope: AuthOrchestrationOperateScope,
        decode: refCreateInput,
        refreshAfter: true,
        run: Effect.fn("vcs.refs.create")(function* (safe, scope) {
          yield* requireGit("vcs.refs.create", scope.cwd);
          return yield* dependencies.gitWorkflow.createRef({ cwd: scope.cwd, ...safe });
        }),
      }),
      switch: runMethod({
        operation: "vcs.refs.switch",
        requiredScope: AuthOrchestrationOperateScope,
        decode: refNameInput,
        refreshAfter: true,
        run: Effect.fn("vcs.refs.switch")(function* (safe, scope) {
          yield* requireGit("vcs.refs.switch", scope.cwd);
          return yield* dependencies.gitWorkflow.switchRef({ cwd: scope.cwd, ...safe });
        }),
      }),
    }),
  };

  const changesApi: HostApiProvider = {
    providerId: "t3.host-vcs-changes",
    definition: VCS_CHANGES_API,
    requiresRootAuthority: true,
    invoke: invokeProvider({
      list: runMethod({
        operation: "vcs.changes.list",
        requiredScope: AuthOrchestrationReadScope,
        decode: emptyInput,
        run: Effect.fn("vcs.changes.list")(function* (_safe, scope) {
          const handle = yield* dependencies.vcsRegistry.detect({ cwd: scope.cwd });
          if (!handle) {
            return {
              isRepo: false,
              entries: [],
              truncated: false,
            } satisfies VcsChangesListResult;
          }
          if (handle.kind !== "git") {
            return yield* unsupported(
              "vcs.changes.list",
              handle.kind,
              `Per-path index state currently requires a Git repository; detected ${handle.kind}.`,
            );
          }
          const result = yield* dependencies.git.execute({
            operation: "vcs.changes.list",
            cwd: scope.cwd,
            args: ["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
          });
          const parsed = parsePorcelainStatus(result.stdout, result.stdoutTruncated);
          const inBound = parsed.filter((entry) => entry.path.length <= 512);
          const entries = inBound.slice(0, MAX_STATUS_FILES);
          return {
            isRepo: true,
            entries,
            truncated:
              result.stdoutTruncated ||
              entries.length < parsed.length ||
              inBound.length < parsed.length,
          } satisfies VcsChangesListResult;
        }),
      }),
      stage: runMethod({
        operation: "vcs.changes.stage",
        requiredScope: AuthOrchestrationOperateScope,
        decode: pathsInput,
        refreshAfter: true,
        run: Effect.fn("vcs.changes.stage")(function* (safe, scope) {
          yield* requireGit("vcs.changes.stage", scope.cwd);
          yield* dependencies.git.execute({
            operation: "vcs.changes.stage",
            cwd: scope.cwd,
            args: ["--literal-pathspecs", "add", "-A", "--", ...safe.paths],
          });
          return { paths: safe.paths };
        }),
      }),
      unstage: runMethod({
        operation: "vcs.changes.unstage",
        requiredScope: AuthOrchestrationOperateScope,
        decode: pathsInput,
        refreshAfter: true,
        run: Effect.fn("vcs.changes.unstage")(function* (safe, scope) {
          yield* requireGit("vcs.changes.unstage", scope.cwd);
          yield* dependencies.git.execute({
            operation: "vcs.changes.unstage",
            cwd: scope.cwd,
            args: ["--literal-pathspecs", "reset", "-q", "--", ...safe.paths],
          });
          return { paths: safe.paths };
        }),
      }),
      commit: runMethod({
        operation: "vcs.changes.commit",
        requiredScope: AuthOrchestrationOperateScope,
        decode: commitInput,
        refreshAfter: true,
        run: Effect.fn("vcs.changes.commit")(function* (safe, scope) {
          yield* requireGit("vcs.changes.commit", scope.cwd);
          const prepared = yield* dependencies.git.prepareCommitContext(
            scope.cwd,
            safe.paths === undefined ? undefined : [...safe.paths],
          );
          if (prepared === null) {
            return yield* failure(
              "vcs.changes.commit",
              "No staged changes to commit in the scoped workspace.",
            );
          }
          const { commitSha } = yield* dependencies.git.commit(scope.cwd, safe.message, "");
          const ref = yield* dependencies.git.execute({
            operation: "vcs.changes.commit.refName",
            cwd: scope.cwd,
            args: ["rev-parse", "--abbrev-ref", "HEAD"],
          });
          const refName = ref.stdout.trim();
          return { commitSha, refName: refName === "HEAD" ? null : refName };
        }),
      }),
    }),
  };

  const repositoryApi: HostApiProvider = {
    providerId: "t3.host-vcs-repository",
    definition: VCS_REPOSITORY_API,
    requiresRootAuthority: true,
    invoke: invokeProvider({
      getCapabilities: runMethod({
        operation: "vcs.repository.getCapabilities",
        requiredScope: AuthOrchestrationReadScope,
        decode: emptyInput,
        run: (_safe, scope) =>
          dependencies.vcsRegistry.detect({ cwd: scope.cwd }).pipe(
            Effect.map((handle): VcsCapabilitiesResult =>
              handle === null
                ? {
                    detected: false,
                    kind: null,
                    detail: null,
                    driver: null,
                    operations: NO_OPERATIONS,
                  }
                : {
                    detected: true,
                    kind: handle.kind,
                    detail: null,
                    driver: handle.driver.capabilities,
                    operations: operationsSupport(handle),
                  },
            ),
            Effect.catch((cause) =>
              Effect.succeed({
                detected: false,
                kind: null,
                detail: (cause instanceof Error ? cause.message : "VCS detection failed.").slice(
                  0,
                  512,
                ),
                driver: null,
                operations: NO_OPERATIONS,
              } satisfies VcsCapabilitiesResult),
            ),
          ),
      }),
      pull: runMethod({
        operation: "vcs.repository.pull",
        requiredScope: AuthOrchestrationOperateScope,
        decode: emptyInput,
        refreshAfter: true,
        run: Effect.fn("vcs.repository.pull")(function* (_safe, scope) {
          yield* requireGit("vcs.repository.pull", scope.cwd);
          return yield* dependencies.gitWorkflow.pullCurrentBranch(scope.cwd);
        }),
      }),
      push: runMethod({
        operation: "vcs.repository.push",
        requiredScope: AuthOrchestrationOperateScope,
        decode: emptyInput,
        refreshAfter: true,
        run: Effect.fn("vcs.repository.push")(function* (_safe, scope) {
          yield* requireGit("vcs.repository.push", scope.cwd);
          const result = yield* dependencies.git.pushCurrentBranch(scope.cwd, null);
          return {
            status: result.status,
            refName: result.branch,
            upstreamRef: result.upstreamBranch ?? null,
            setUpstream: result.setUpstream ?? false,
          } satisfies VcsPushResult;
        }),
      }),
      fetch: runMethod({
        operation: "vcs.repository.fetch",
        requiredScope: AuthOrchestrationOperateScope,
        decode: fetchInput,
        refreshAfter: true,
        run: Effect.fn("vcs.repository.fetch")(function* (safe, scope) {
          const handle = yield* requireGit("vcs.repository.fetch", scope.cwd);
          const remoteNames =
            safe.remoteName === undefined
              ? (yield* handle.driver.listRemotes(scope.cwd)).remotes.map((remote) => remote.name)
              : [safe.remoteName];
          if (remoteNames.length === 0) {
            return yield* failure(
              "vcs.repository.fetch",
              "No remotes are configured in the scoped workspace.",
            );
          }
          yield* Effect.forEach(remoteNames, (remoteName) =>
            dependencies.gitWorkflow.fetchRemote({ cwd: scope.cwd, remoteName }),
          );
          return { remotes: remoteNames } satisfies VcsFetchResult;
        }),
      }),
      listRemotes: runMethod({
        operation: "vcs.repository.listRemotes",
        requiredScope: AuthOrchestrationReadScope,
        decode: emptyInput,
        run: Effect.fn("vcs.repository.listRemotes")(function* (_safe, scope) {
          const handle = yield* dependencies.vcsRegistry.detect({ cwd: scope.cwd });
          if (!handle) {
            return { isRepo: false, remotes: [] } satisfies VcsListRemotesResult;
          }
          const result = yield* handle.driver.listRemotes(scope.cwd);
          const remotes = result.remotes
            .map((remote) => ({
              name: remote.name,
              url: redactRemoteUrl(remote.url),
              pushUrl: Option.isNone(remote.pushUrl) ? null : redactRemoteUrl(remote.pushUrl.value),
              isPrimary: remote.isPrimary,
            }))
            .filter(
              (remote) =>
                remote.name.length <= MAX_REF_NAME &&
                remote.url.length <= 2048 &&
                (remote.pushUrl === null || remote.pushUrl.length <= 2048),
            )
            .slice(0, 64);
          return { isRepo: true, remotes } satisfies VcsListRemotesResult;
        }),
      }),
      init: runMethod({
        operation: "vcs.repository.init",
        requiredScope: AuthOrchestrationOperateScope,
        decode: initInput,
        refreshAfter: true,
        run: (safe, scope) =>
          dependencies.vcsProvisioning
            .initRepository({ cwd: scope.cwd, ...safe })
            .pipe(Effect.map((): VcsEmptyResult => ({}))),
      }),
      createWorktree: runMethod({
        operation: "vcs.repository.createWorktree",
        requiredScope: AuthOrchestrationOperateScope,
        decode: createWorktreeInput,
        refreshAfter: true,
        run: Effect.fn("vcs.repository.createWorktree")(function* (safe, scope) {
          const handle = yield* requireGit("vcs.repository.createWorktree", scope.cwd);
          if (!handle.driver.capabilities.supportsWorktrees) {
            return yield* unsupported(
              "vcs.repository.createWorktree",
              handle.kind,
              "The detected VCS driver does not support worktrees.",
            );
          }
          const worktreePath =
            safe.path === null
              ? null
              : yield* resolveWorktreePath("vcs.repository.createWorktree", safe.path);
          return yield* dependencies.gitWorkflow.createWorktree({
            cwd: scope.cwd,
            ...safe,
            path: worktreePath,
          });
        }),
      }),
      removeWorktree: runMethod({
        operation: "vcs.repository.removeWorktree",
        requiredScope: AuthOrchestrationOperateScope,
        decode: removeWorktreeInput,
        refreshAfter: true,
        run: Effect.fn("vcs.repository.removeWorktree")(function* (safe, scope) {
          const handle = yield* requireGit("vcs.repository.removeWorktree", scope.cwd);
          if (!handle.driver.capabilities.supportsWorktrees) {
            return yield* unsupported(
              "vcs.repository.removeWorktree",
              handle.kind,
              "The detected VCS driver does not support worktrees.",
            );
          }
          const worktreePath = yield* resolveWorktreePath(
            "vcs.repository.removeWorktree",
            safe.path,
          );
          yield* dependencies.gitWorkflow.removeWorktree({
            cwd: scope.cwd,
            ...safe,
            path: worktreePath,
          });
          return {} satisfies VcsEmptyResult;
        }),
      }),
    }),
  };

  return [statusApi, refsApi, changesApi, repositoryApi];
}

export const makeVcsApiProviders = Effect.fn("VcsApi.make")(function* () {
  const environment = yield* ServerEnvironment;
  const serverSettings = yield* ServerSettingsService;
  const automaticRemoteRefreshInterval = serverSettings.getSettings.pipe(
    Effect.map(
      (settings) => resolveServerBackgroundActivitySettings(settings).automaticGitFetchInterval,
    ),
    Effect.catch((cause) =>
      Effect.logWarning("Failed to read automatic Git fetch interval setting", {
        detail: cause.message,
      }).pipe(Effect.as(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
    ),
  );
  return createVcsApiProviders({
    environmentId: yield* environment.getEnvironmentId,
    projects: yield* ProjectionProjectRepository,
    threads: yield* ProjectionThreadRepository,
    vcsStatus: yield* VcsStatusBroadcaster,
    gitWorkflow: yield* GitWorkflowService,
    git: yield* GitVcsDriver,
    vcsRegistry: yield* VcsDriverRegistry,
    vcsProvisioning: yield* VcsProvisioningService,
    worktreesDir: (yield* ServerConfig).worktreesDir,
    automaticRemoteRefreshInterval,
  });
});
