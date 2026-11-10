import {
  WS_METHODS,
  PullRequestActivity,
  PullRequestDetail as PullRequestDetailSchema,
  PullRequestPreview,
  PullRequestReviewGuideResult,
  PullRequestListResult,
  PullRequestChecks,
  PullRequestDiffResult,
  PullRequestChangeBreakdown,
  PullRequestFilesViewedResult,
  PullRequestLinkedThreadsResult,
  type EnvironmentId,
  type PullRequestActor,
  type PullRequestActionInput,
  type PullRequestListInput,
  type PullRequestListStatsInput,
  type PullRequestListStatsResult,
  type PullRequestUpdateInput,
  type PullRequestDetail,
  type PullRequestDiffInput,
  type PullRequestListEntry,
  type PullRequestRef,
  type PullRequestMergeMethod,
  type PullRequestLabel,
  type PullRequestLabelCandidateList,
  type PullRequestState,
  PullRequestOperationError,
  PullRequestSummary,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { persistPullRequestStats } from "./pullRequestStatsPersistence.ts";
import { persistQuery, type QueryPersistence } from "./queryPersistence.ts";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  type AtomCommand,
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentQueryAtomFamily,
  queryPersistenceKey,
  type QueryAnswerHandler,
} from "./runtime.ts";
import { createPullRequestRouter } from "./pullRequestRouting.ts";
import * as PullRequestDiffLoader from "./pullRequestDiffHttp.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { isStalePullRequestReply } from "../pullRequestReply.ts";
import { parsePullRequestQuery } from "../pullRequestQuery.ts";
import { reuseUnchanged } from "./serverConfigProjection.ts";

export {
  type PullRequestDiffLoadError,
  PullRequestDiffCredentialRejectedError,
} from "./pullRequestDiffHttp.ts";
export * as PullRequestDiffLoader from "./pullRequestDiffHttp.ts";

/** @public Required to name the error in consumers' inferred pull request results. */
export class EnvironmentHttpConnectionNotReadyError extends Schema.TaggedError<EnvironmentHttpConnectionNotReadyError>()(
  "EnvironmentHttpConnectionNotReadyError",
  { message: Schema.String },
) {}

const LINKED_PULL_REQUEST_IDLE_TTL_MS = 5_000;

function normalizePullRequestQuery<A>(
  query: (target: { readonly environmentId: EnvironmentId; readonly input: PullRequestRef }) => A,
) {
  return ({
    environmentId,
    input: { projectId, host, repository, number, allowStale, expectedAccountId },
  }: Parameters<typeof query>[0]) =>
    query({
      environmentId,
      input: {
        projectId,
        ...(host === undefined ? {} : { host }),
        repository,
        number,
        ...(allowStale === undefined ? {} : { allowStale }),
        ...(expectedAccountId === undefined ? {} : { expectedAccountId }),
      },
    });
}

function writableQuery<A, E>(
  source: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  idleTtlMs = 5 * 60_000,
) {
  return Atom.writable(
    (get) => {
      const result = get(source);
      if (result._tag === "Success" && !result.waiting) return result;
      const previous = get.self<AsyncResult.AsyncResult<A, E>>();
      const value = Option.flatMap(previous, AsyncResult.value);
      if (Option.isNone(value)) return result;
      return result._tag === "Failure"
        ? AsyncResult.failureWithPrevious(result.cause, { previous, waiting: result.waiting })
        : AsyncResult.success<A, E>(value.value, result);
    },
    (context, value: AsyncResult.AsyncResult<A, E>) => context.setSelf(value),
    (refresh) => refresh(source),
  ).pipe(Atom.setIdleTTL(idleTtlMs));
}

function writableQueryFamily<A, E>(
  family: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: PullRequestRef;
  }) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) {
  const writable = Atom.family((source: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
    writableQuery(source),
  );
  return normalizePullRequestQuery((target) => writable(family(target)));
}

/** Restart pre-mutation reads before patching so they cannot restore stale values. */
function updateCached<A, E>(
  registry: AtomRegistry.AtomRegistry,
  shown: Atom.Writable<AsyncResult.AsyncResult<A, E>>,
  update: (value: A) => A,
  refresh = false,
) {
  const atom = (uneditedReaders.get(shown) ?? shown) as typeof shown;
  if (refresh || registry.get(atom).waiting) registry.refresh(atom);
  registry.update(atom, AsyncResult.map(update));
}

interface ActionReplyPatch {
  /** The read this reader is waiting on, if any. */
  readonly pendingRead: (registry: AtomRegistry.AtomRegistry) => object | undefined;
  readonly apply: (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    reference: PullRequestRef,
    reply: PullRequestSummary | undefined,
    readsBeforeSend: ReadonlySet<object>,
  ) => Effect.Effect<void>;
}

// Module-wide so readers built by separate factories, such as linked summaries, are patched too.
const actionReplyPatches = new WeakMap<object, ActionReplyPatch>();

/** What a write in flight will change, shown by every reader until the host answers. */
export interface PullRequestPendingEdit {
  readonly reference: PullRequestRef;
  readonly state?: PullRequestState;
  readonly isDraft?: boolean;
  readonly autoMergeEnabled?: boolean;
  readonly title?: string;
  readonly body?: string;
  readonly labels?: {
    readonly applied: boolean;
    readonly labels: ReadonlyArray<PullRequestLabel>;
  };
}

type EditedField = "state" | "isDraft" | "autoMergeEnabled" | "title" | "body";

interface EditableReader {
  readonly environmentId: EnvironmentId;
  readonly concerns: (reference: PullRequestRef) => boolean;
  readonly edit: (value: never, edits: ReadonlyArray<PullRequestPendingEdit>) => unknown;
}

// Module-wide like the reply patches, so separately built readers see the same writes.
export const pullRequestPendingEditsAtom = Atom.family((_environmentId: EnvironmentId | null) =>
  Atom.make<ReadonlyArray<PullRequestPendingEdit>>([]).pipe(Atom.keepAlive),
);
const editableReaders = new WeakMap<object, EditableReader>();
const editedReaders = new WeakMap<object, object>();
const uneditedReaders = new WeakMap<object, object>();

function loadedValue<A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<unknown>) {
  return Option.flatMap(registry.getNodes().get(atom)?.valueOption() ?? Option.none(), (result) =>
    AsyncResult.value(result as AsyncResult.AsyncResult<A, unknown>),
  );
}

function withEdit<T extends object>(
  value: T,
  edit: PullRequestPendingEdit,
  fields: ReadonlyArray<EditedField>,
): T {
  const held = value as Record<string, unknown>;
  const changed = fields.filter(
    (field) => edit[field] !== undefined && held[field] !== edit[field],
  );
  let next =
    changed.length === 0
      ? held
      : { ...held, ...Object.fromEntries(changed.map((field) => [field, edit[field]])) };
  if (edit.autoMergeEnabled === false && next.autoMergeMethod !== undefined) {
    const { autoMergeMethod: _disarmed, ...withoutAutoMerge } = next;
    next = withoutAutoMerge;
  }
  return next as T;
}

function withLabelEdit<T extends { readonly labels: ReadonlyArray<PullRequestLabel> }>(
  value: T,
  edit: PullRequestPendingEdit,
): T {
  if (edit.labels === undefined) return value;
  const { applied, labels: changed } = edit.labels;
  const names = new Set(changed.map((label) => label.name));
  const labels = applied
    ? [
        ...value.labels,
        ...changed.filter((label) => !value.labels.some((held) => held.name === label.name)),
      ]
    : value.labels.filter((label) => !names.has(label.name));
  return labels.length === value.labels.length ? value : { ...value, labels };
}

function withLabelCandidateEdit(
  value: PullRequestLabelCandidateList,
  edit: PullRequestPendingEdit,
): PullRequestLabelCandidateList {
  if (edit.labels === undefined) return value;
  const { applied, labels } = edit.labels;
  let changed = false;
  const candidates = value.candidates.map((candidate) => {
    if (candidate.isApplied === applied || !labels.some((label) => label.name === candidate.name))
      return candidate;
    changed = true;
    return { ...candidate, isApplied: applied };
  });
  return changed ? { ...value, candidates } : value;
}

/**
 * The reader with every write in flight for its pull request applied. Writes go to the reader
 * underneath, so a refused edit never stays behind in what the host said.
 */
function editedQuery<A, E>(
  inner: Atom.Writable<AsyncResult.AsyncResult<A, E>>,
  reader: Omit<EditableReader, "edit"> & {
    readonly edit: (value: A, edits: ReadonlyArray<PullRequestPendingEdit>) => A;
  },
  idleTtlMs = 5 * 60_000,
): Atom.Writable<AsyncResult.AsyncResult<A, E>> {
  const existing = editedReaders.get(inner);
  if (existing !== undefined) return existing as Atom.Writable<AsyncResult.AsyncResult<A, E>>;
  const shown = Atom.writable(
    (get) => {
      const result = get(inner);
      const edits = get(pullRequestPendingEditsAtom(reader.environmentId)).filter((edit) =>
        reader.concerns(edit.reference),
      );
      const value = AsyncResult.value(result);
      if (edits.length === 0 || Option.isNone(value)) return result;
      const next = reader.edit(value.value, edits);
      return next === value.value ? result : AsyncResult.map(result, () => next);
    },
    (context, value: AsyncResult.AsyncResult<A, E>) => context.set(inner, value),
    (refresh) => refresh(inner),
  ).pipe(Atom.setIdleTTL(idleTtlMs));
  editableReaders.set(inner, reader as EditableReader);
  editedReaders.set(inner, shown);
  uneditedReaders.set(shown, inner);
  return shown;
}

/** Shows the command's edit from the click until it settles, queued behind others or not. */
function showWhileInFlight<Target extends { readonly environmentId: EnvironmentId }, A, E, C>(
  command: C & AtomCommand<Target, A, E>,
  editOf: (registry: AtomRegistry.AtomRegistry, target: Target) => PullRequestPendingEdit | null,
): C {
  return {
    ...command,
    run: async (registry, target) => {
      const edit = editOf(registry, target);
      if (edit === null) return command.run(registry, target);
      const edits = pullRequestPendingEditsAtom(target.environmentId);
      registry.update(edits, (current) => [...current, edit]);
      try {
        return await command.run(registry, target);
      } finally {
        registry.update(edits, (current) => current.filter((entry) => entry !== edit));
      }
    },
  } satisfies AtomCommand<Target, A, E>;
}

/** Keeps an accepted edit in loaded readers once it stops being in flight. */
function settleEdit(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  edit: PullRequestPendingEdit | null,
  readsAfterWrite = false,
) {
  if (edit === null) return;
  for (const atom of registry.getNodes().keys()) {
    const reader = typeof atom === "string" ? undefined : editableReaders.get(atom);
    if (reader?.environmentId !== environmentId || !reader.concerns(edit.reference)) continue;
    const shown = loadedValue<never>(registry, atom as Atom.Atom<unknown>);
    const writable = atom as Atom.Writable<AsyncResult.AsyncResult<never, unknown>>;
    const unchanged = Option.isSome(shown) && reader.edit(shown.value, [edit]) === shown.value;
    if (unchanged) continue;
    // A read still waiting may predate the write, unless the caller started it after the commit.
    if (!readsAfterWrite && registry.get(writable).waiting) registry.refresh(writable);
    if (Option.isNone(shown)) continue;
    registry.update(
      writable,
      AsyncResult.map((value) => reader.edit(value, [edit]) as never),
    );
  }
}

function pullRequestReference(input: PullRequestRef): PullRequestRef {
  const { projectId, host, repository, number, expectedAccountId } = input;
  return {
    projectId,
    ...(host === undefined ? {} : { host }),
    repository,
    number,
    ...(expectedAccountId === undefined ? {} : { expectedAccountId }),
  };
}

/** What an action changes, left out where only the host knows, as a merge where queues are unknown. */
function actionEdit(
  input: PullRequestActionInput,
  mergeQueue: boolean | undefined,
): PullRequestPendingEdit | null {
  if (input.stackNumber !== undefined) return null;
  const reference = pullRequestReference(input);
  switch (input.action) {
    case "merge":
      return mergeQueue === undefined
        ? null
        : mergeQueue
          ? { reference, autoMergeEnabled: true }
          : { reference, state: "merged" };
    case "close":
      return { reference, state: "closed" };
    case "reopen":
      return { reference, state: "open" };
    case "ready":
      return { reference, isDraft: false };
    case "draft":
      return { reference, isDraft: true };
    case "enable-auto-merge":
      return { reference, autoMergeEnabled: true };
    case "disable-auto-merge":
      return { reference, autoMergeEnabled: false };
    default:
      return null;
  }
}

function updateEdit(input: PullRequestUpdateInput): PullRequestPendingEdit | null {
  if (input.title === undefined && input.body === undefined) return null;
  return {
    reference: pullRequestReference(input),
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.body === undefined ? {} : { body: input.body }),
  };
}

function samePullRequest(reader: PullRequestRef, acted: PullRequestRef) {
  return (
    reader.projectId === acted.projectId &&
    // A missing host is not a wildcard: one project can reach the same repository on two hosts.
    reader.host?.toLowerCase() === acted.host?.toLowerCase() &&
    reader.repository.toLowerCase() === acted.repository.toLowerCase() &&
    reader.number === acted.number &&
    reader.expectedAccountId === acted.expectedAccountId
  );
}

export function applyPullRequestSummaryEdits(
  reference: PullRequestRef | null,
  summary: PullRequestSummary | null,
  edits: ReadonlyArray<PullRequestPendingEdit>,
): PullRequestSummary | null {
  if (reference === null || summary === null) return summary;
  return edits.reduce(
    (current, edit) =>
      samePullRequest(reference, edit.reference)
        ? withEdit(current, edit, ["state", "isDraft", "autoMergeEnabled", "title"])
        : current,
    summary,
  );
}

function pickDefined<T extends object, K extends keyof T>(
  source: T,
  keys: ReadonlyArray<K>,
): { [P in K]?: Exclude<T[P], undefined> } {
  const picked: { [P in K]?: T[P] } = {};
  for (const key of keys) if (source[key] !== undefined) picked[key] = source[key];
  return picked as { [P in K]?: Exclude<T[P], undefined> };
}

function listAccepts(input: PullRequestListInput, state: string, isDraft: boolean | undefined) {
  const draft = parsePullRequestQuery(input.query ?? "").filters.draft ?? input.filters?.draft;
  return (
    (input.state === "all" || input.state === state) &&
    (draft !== "only" || isDraft !== false) &&
    (draft !== "hide" || isDraft !== true)
  );
}

/**
 * Listing rows with an action's reply applied, the same array when it changes none, and `refresh`
 * when the reply adds the pull request to a listing, which only a read can place.
 */
export function patchPullRequestListEntries<Entry extends PullRequestListEntry>(
  input: PullRequestListInput,
  entries: ReadonlyArray<Entry>,
  reference: PullRequestRef,
  reply: PullRequestSummary,
): ReadonlyArray<Entry> | "refresh" {
  let found = false;
  let changed = false;
  const patched = entries.flatMap((entry): Entry[] => {
    if (!samePullRequest(entry, reference)) return [entry];
    found = true;
    if (isStalePullRequestReply(entry, reply)) return [entry];
    changed = true;
    const next = {
      ...entry,
      ...pickDefined(reply, [
        "title",
        "url",
        "author",
        "headBranch",
        "baseBranch",
        "state",
        "isDraft",
        "mergeability",
        "updatedAt",
      ]),
    };
    return listAccepts(input, next.state, next.isDraft) ? [next] : [];
  });
  if (!found) {
    return input.cursors === undefined && listAccepts(input, reply.state, reply.isDraft)
      ? "refresh"
      : entries;
  }
  return changed
    ? patched.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    : entries;
}

function editListEntries<Entry extends PullRequestListEntry>(
  input: PullRequestListInput,
  entries: ReadonlyArray<Entry>,
  edits: ReadonlyArray<PullRequestPendingEdit>,
): ReadonlyArray<Entry> {
  let changed = false;
  const edited = entries.flatMap((entry): Entry[] => {
    const next = edits.reduce(
      (current, edit) =>
        samePullRequest(entry, edit.reference)
          ? withLabelEdit(withEdit(current, edit, ["state", "isDraft", "title"]), edit)
          : current,
      entry,
    );
    if (next === entry) return [entry];
    changed = true;
    return listAccepts(input, next.state, next.isDraft) ? [next] : [];
  });
  return changed ? edited : entries;
}

function patchListWithReply(
  input: PullRequestListInput,
  value: PullRequestListResult,
  reference: PullRequestRef,
  reply: PullRequestSummary,
): PullRequestListResult | "refresh" {
  const entries = patchPullRequestListEntries(input, value.entries, reference, reply);
  if (entries === "refresh") return entries;
  return entries === value.entries ? value : { ...value, entries };
}

/**
 * The query atom for one target, writable so an action's reply can replace what it shows. The
 * patch is saved and announced the way an answer would be, so cold starts and snapshots see it.
 */
function actionPatchedQuery<Input, A, E>(
  source: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: Input;
  }) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options: {
    readonly label: string;
    readonly persistence?: QueryPersistence<A> | undefined;
    readonly onAnswer?: QueryAnswerHandler<Input, A> | undefined;
    readonly idleTtlMs?: number | undefined;
    readonly concerns: (input: Input, reference: PullRequestRef) => boolean;
    readonly patch: (
      input: Input,
      value: A,
      reference: PullRequestRef,
      reply: PullRequestSummary,
    ) => A | "refresh";
    /** Fields the reply lacks also changed, so the patched value shows while a read fetches them. */
    readonly rereads?: (value: A, reply: PullRequestSummary) => boolean;
    /** Re-read when the host's reply did not carry the pull request. */
    readonly rereadWithoutReply?: boolean;
    /** False for reads the refresh stream does not restart; defaults to true. */
    readonly refreshedByServer?: (input: Input) => boolean;
    /** Shows a write in flight; absent where the reader holds nothing such a write changes. */
    readonly edit?: (input: Input, value: A, edits: ReadonlyArray<PullRequestPendingEdit>) => A;
  },
) {
  const writable = Atom.family((atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
    writableQuery(atom, options.idleTtlMs),
  );
  return (target: { readonly environmentId: EnvironmentId; readonly input: Input }) => {
    const query = source(target);
    const atom = writable(query);
    const edit = options.edit;
    const reader =
      edit === undefined
        ? atom
        : editedQuery(
            atom,
            {
              environmentId: target.environmentId,
              concerns: (reference) => options.concerns(target.input, reference),
              edit: (value, pending) => edit(target.input, value, pending),
            },
            options.idleTtlMs,
          );
    if (actionReplyPatches.has(atom)) return reader;
    const pendingRead = (registry: AtomRegistry.AtomRegistry) => {
      const result = Option.getOrUndefined(
        registry.getNodes().get(query)?.valueOption() ?? Option.none(),
      ) as AsyncResult.AsyncResult<A, E> | undefined;
      return result?.waiting === true ? result : undefined;
    };
    actionReplyPatches.set(atom, {
      pendingRead,
      apply: Effect.fnUntraced(
        function* (registry, environmentId, reference, reply, readsBeforeSend) {
          if (environmentId !== target.environmentId || !options.concerns(target.input, reference))
            return;
          const pending = pendingRead(registry);
          // A read sent before the action may miss its result, and so may one sent before the host
          // committed. The server's post-commit refresh restarts that one, but not a read outside
          // its stream, whose re-read need not even show as waiting, so a mounted one the reply
          // changes restarts here.
          const unrefreshed = options.refreshedByServer?.(target.input) === false;
          const freshRead = pending !== undefined && !unrefreshed && !readsBeforeSend.has(pending);
          const reread = () => (freshRead ? undefined : registry.refresh(atom));
          if (reply === undefined) {
            return options.rereadWithoutReply === true ? reread() : undefined;
          }
          const shown = Option.flatMap(
            registry.getNodes().get(atom)?.valueOption() ?? Option.none(),
            (current: AsyncResult.AsyncResult<A, E>) => AsyncResult.value(current),
          );
          if (Option.isNone(shown)) return reread();
          const patched = options.patch(target.input, shown.value, reference, reply);
          if (patched === "refresh") return reread();
          const lacking = options.rereads?.(shown.value, reply) === true;
          const next = reuseUnchanged(shown.value, patched);
          if (next === shown.value)
            return lacking || (unrefreshed && pending !== undefined) ? reread() : undefined;
          yield* options.onAnswer?.(target, next, registry) ?? Effect.void;
          const mounted = [atom, reader].some(
            (shownBy) => (registry.getNodes().get(shownBy)?.listeners.size ?? 0) > 0,
          );
          if (!freshRead && (pending !== undefined || lacking || (unrefreshed && mounted)))
            registry.refresh(atom);
          registry.update(
            atom,
            AsyncResult.map(() => next),
          );
          if (options.persistence !== undefined) {
            yield* options.persistence.save(
              environmentId,
              queryPersistenceKey(options.label, target.input),
              next,
            );
          }
        },
      ),
    });
    return reader;
  };
}

function makePullRequestRefreshAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:pull-requests:turn-refreshes",
    tag: WS_METHODS.pullRequestsSubscribeRefreshes,
  });
}

const refreshFamiliesByRuntime = new WeakMap<
  object,
  ReturnType<typeof makePullRequestRefreshAtomFamily>
>();

function createPullRequestRefreshAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
): ReturnType<typeof makePullRequestRefreshAtomFamily<R, E>> {
  const existing = refreshFamiliesByRuntime.get(runtime);
  if (existing) return existing as ReturnType<typeof makePullRequestRefreshAtomFamily<R, E>>;
  const refreshes = makePullRequestRefreshAtomFamily(runtime);
  refreshFamiliesByRuntime.set(runtime, refreshes);
  return refreshes;
}

export function createLinkedPullRequestSummaryAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  refreshes = createPullRequestRefreshAtomFamily(runtime),
  onAnswer?: QueryAnswerHandler<PullRequestRef, PullRequestSummary>,
) {
  const routedRequest = createPullRequestRouter();
  const label = "environment-data:pull-requests:linked-summary";
  const persistence = persistQuery(PullRequestSummary);
  return actionPatchedQuery(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label,
      persistence,
      tag: WS_METHODS.pullRequestsSummary,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsSummary, input),
      staleTimeMs: 60_000,
      refreshIntervalMs: 60_000,
      idleTtlMs: LINKED_PULL_REQUEST_IDLE_TTL_MS,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
      isFinal: (summary) => summary.state === "merged",
      ...(onAnswer === undefined ? {} : { onAnswer }),
    }),
    {
      label,
      persistence,
      onAnswer,
      idleTtlMs: LINKED_PULL_REQUEST_IDLE_TTL_MS,
      concerns: samePullRequest,
      // A routed action replies with the destination's project and repository names.
      patch: (_input, value, _reference, reply) =>
        isStalePullRequestReply(value, reply)
          ? value
          : {
              ...value,
              ...reply,
              projectId: value.projectId,
              repository: value.repository,
              number: value.number,
              ...(value.observedAt === undefined ? {} : { observedAt: value.observedAt }),
            },
      edit: (_input, value, edits) =>
        edits.reduce(
          (current, edit) =>
            withEdit(current, edit, ["state", "isDraft", "autoMergeEnabled", "title"]),
          value,
        ),
    },
  );
}

/** Lets a client record what each answer says where it lands, rather than watching the data. */
export interface PullRequestAnswerHandlers {
  readonly list?: QueryAnswerHandler<PullRequestListInput, PullRequestListResult>;
  readonly listStats?: QueryAnswerHandler<PullRequestListStatsInput, PullRequestListStatsResult>;
  readonly detail?: QueryAnswerHandler<PullRequestRef, PullRequestDetail>;
  readonly checks?: QueryAnswerHandler<PullRequestRef, PullRequestChecks | null>;
  readonly reviewGuide?: QueryAnswerHandler<PullRequestRef, PullRequestReviewGuideResult>;
  /** Once per action reply, after the loaded readers show it; unscoped references only. */
  readonly actionReply?: QueryAnswerHandler<PullRequestRef, PullRequestSummary>;
  readonly acceptedEdit?: QueryAnswerHandler<PullRequestRef, PullRequestPendingEdit>;
}

export function createPullRequestStackAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  refreshes = createPullRequestRefreshAtomFamily(runtime),
) {
  const routedRequest = createPullRequestRouter();
  return createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:pull-requests:stack",
    tag: WS_METHODS.pullRequestsStack,
    execute: (input) => routedRequest(WS_METHODS.pullRequestsStack, input),
    staleTimeMs: 60_000,
    idleTtlMs: LINKED_PULL_REQUEST_IDLE_TTL_MS,
    refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
  });
}

export function pullRequestDetailToVcsStatus(
  detail: PullRequestDetail | PullRequestSummary,
): NonNullable<VcsStatusResult["pr"]> {
  return {
    number: detail.number,
    title: detail.title,
    url: detail.url,
    baseRef: detail.baseBranch,
    headRef: detail.headBranch,
    state: detail.state,
    ...(detail.isDraft === true ? { isDraft: true } : {}),
    updatedAt: detail.updatedAt,
  };
}

export function createPullRequestEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | PullRequestDiffLoader.PullRequestDiffLoader | R,
    E
  >,
  onAnswer: PullRequestAnswerHandlers = {},
) {
  const refreshes = createPullRequestRefreshAtomFamily(runtime);
  const commandScheduler = createAtomCommandScheduler();
  const routedRequest = createPullRequestRouter();
  const serialPerEnvironment = {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;
  const activity = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:activity",
      persistence: persistQuery(PullRequestActivity),
      tag: WS_METHODS.pullRequestsActivity,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsActivity, input),
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
  );
  const detailAnswerAtoms = Atom.family((_key: string) =>
    Atom.make<{ readonly value: PullRequestDetail; readonly version: number } | null>(null).pipe(
      Atom.setIdleTTL(5 * 60_000),
    ),
  );
  const detailAnswers = normalizePullRequestQuery((target) =>
    detailAnswerAtoms(JSON.stringify(target)),
  );
  const detailLabel = "environment-data:pull-requests:detail";
  const detailPersistence = persistQuery(PullRequestDetailSchema);
  const detail = normalizePullRequestQuery(
    actionPatchedQuery(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: detailLabel,
        persistence: detailPersistence,
        tag: WS_METHODS.pullRequestsDetail,
        execute: (input) => routedRequest(WS_METHODS.pullRequestsDetail, input),
        staleTimeMs: 60_000,
        refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
        onAnswer: (target, value, registry) =>
          Effect.sync(() => {
            // Cache reads bypass onAnswer, and server freshness stays separate from local readbacks.
            registry.update(detailAnswers(target), (previous) => ({
              value,
              version: (previous?.version ?? 0) + 1,
            }));
          }).pipe(Effect.andThen(() => onAnswer.detail?.(target, value, registry) ?? Effect.void)),
      }),
      {
        label: detailLabel,
        persistence: detailPersistence,
        onAnswer: onAnswer.detail,
        concerns: samePullRequest,
        rereadWithoutReply: true,
        // Reopening or a new head changes branch data and permissions the reply lacks.
        rereads: (value, reply) =>
          !isStalePullRequestReply(value, reply) &&
          ((value.state === "closed" && reply.state === "open") ||
            (reply.headSha !== undefined && reply.headSha !== value.headSha)),
        patch: (_input, value, _reference, reply) => {
          if (isStalePullRequestReply(value, reply)) return value;
          const patched = {
            ...value,
            ...pickDefined(reply, [
              "title",
              "url",
              "author",
              "state",
              "isDraft",
              "mergeability",
              "additions",
              "deletions",
              "changedFiles",
              "headBranch",
              "baseBranch",
              "updatedAt",
              "mergedAt",
              "closedAt",
              "autoMergeEnabled",
              "autoMergeMethod",
            ]),
          };
          if (reply.autoMergeEnabled !== false) return patched;
          const { autoMergeMethod: _disarmed, ...withoutAutoMerge } = patched;
          return withoutAutoMerge;
        },
        edit: (_input, value, edits) =>
          edits.reduce(
            (current, edit) =>
              withLabelEdit(
                withEdit(current, edit, ["state", "isDraft", "autoMergeEnabled", "title", "body"]),
                edit,
              ),
            value,
          ),
      },
    ),
  );
  // Pages read the strict detail and other surfaces the default one; patch whichever is loaded
  // without starting a read of the other.
  const loadedDetails = (
    registry: AtomRegistry.AtomRegistry,
    target: { readonly environmentId: EnvironmentId; readonly input: PullRequestRef },
  ) =>
    [
      detail({ ...target, input: { ...target.input, allowStale: undefined } }),
      detail({ ...target, input: { ...target.input, allowStale: false } }),
    ].filter((atom) => registry.getNodes().has(atom));
  const loadedMergeQueue = (
    registry: AtomRegistry.AtomRegistry,
    target: { readonly environmentId: EnvironmentId; readonly input: PullRequestRef },
  ) =>
    loadedDetails(registry, target)
      .map((atom) => Option.getOrUndefined(loadedValue<PullRequestDetail>(registry, atom)))
      .find((shown) => shown?.mergeQueue !== undefined)?.mergeQueue;
  const detailReadVersions = Atom.family((source: ReturnType<typeof detail>) =>
    Atom.family((answer: ReturnType<typeof detailAnswers>) =>
      Atom.make((get) => {
        const result = get(source);
        const latest = get(answer);
        return result._tag === "Success" && !result.waiting && result.value === latest?.value
          ? latest.version
          : Option.getOrElse(get.self<number>(), () => 0);
      }).pipe(Atom.setIdleTTL(5 * 60_000)),
    ),
  );
  const detailReadVersion = normalizePullRequestQuery((target) =>
    detailReadVersions(detail(target))(detailAnswers(target)),
  );
  const previewPersistence = persistQuery(PullRequestPreview);
  const previewQuery = (label: string) =>
    normalizePullRequestQuery(
      actionPatchedQuery(
        createEnvironmentRpcQueryAtomFamily(runtime, {
          label,
          persistence: previewPersistence,
          tag: WS_METHODS.pullRequestsPreview,
          execute: (input) => routedRequest(WS_METHODS.pullRequestsPreview, input),
          staleTimeMs: 60_000,
          refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
        }),
        {
          label,
          persistence: previewPersistence,
          concerns: samePullRequest,
          rereadWithoutReply: true,
          // Servers before action replies send unstamped previews, which only a read can order.
          patch: (_input, value, _reference, reply) =>
            value.updatedAt === undefined && value.observedAt === undefined
              ? "refresh"
              : isStalePullRequestReply(value, reply)
                ? value
                : {
                    ...value,
                    ...pickDefined(reply, [
                      "title",
                      "url",
                      "author",
                      "state",
                      "isDraft",
                      "updatedAt",
                      "observedAt",
                    ]),
                  },
          edit: (_input, value, edits) =>
            edits.reduce(
              (current, edit) => withEdit(current, edit, ["state", "isDraft", "title"]),
              value,
            ),
        },
      ),
    );
  const preview = previewQuery("environment-data:pull-requests:preview");
  // Hover cards read their own atoms, so a pending or failed hover read never decides where a
  // click on the same link goes.
  const previewCard = previewQuery("environment-data:pull-requests:preview-card");
  const labelCandidateQueries = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:label-candidates",
      tag: WS_METHODS.pullRequestsLabelCandidates,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsLabelCandidates, input),
      staleTimeMs: 60_000,
    }),
  );
  const labelCandidates = normalizePullRequestQuery((target) =>
    editedQuery(labelCandidateQueries(target), {
      environmentId: target.environmentId,
      concerns: (reference) => samePullRequest(target.input, reference),
      edit: (value, edits) => edits.reduce(withLabelCandidateEdit, value),
    }),
  );
  const labelEdit = (
    registry: AtomRegistry.AtomRegistry,
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: PullRequestRef & {
        readonly labels: ReadonlyArray<string>;
        readonly applied: boolean;
      };
    },
  ): PullRequestPendingEdit => {
    const candidates = Option.getOrUndefined(
      loadedValue<PullRequestLabelCandidateList>(registry, labelCandidates(target)),
    )?.candidates;
    return {
      reference: pullRequestReference(target.input),
      labels: {
        applied: target.input.applied,
        labels: target.input.labels.map((name) => ({
          name,
          color: candidates?.find((candidate) => candidate.name === name)?.color ?? null,
        })),
      },
    };
  };
  const reviewGuide = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:review-guide",
      persistence: persistQuery(PullRequestReviewGuideResult),
      tag: WS_METHODS.pullRequestsReviewGuide,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsReviewGuide, input),
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
      ...(onAnswer.reviewGuide === undefined ? {} : { onAnswer: onAnswer.reviewGuide }),
    }),
  );
  const reviewerCandidates = writableQueryFamily(
    createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:reviewer-candidates",
      tag: WS_METHODS.pullRequestsReviewerCandidates,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsReviewerCandidates, input),
      staleTimeMs: 60_000,
    }),
  );
  // Asked only when the menu's first page is not everybody, so a query cannot be answered from it.
  const reviewerSearch = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:pull-requests:reviewer-search",
    tag: WS_METHODS.pullRequestsReviewerCandidates,
    execute: (input) => routedRequest(WS_METHODS.pullRequestsReviewerCandidates, input),
    staleTimeMs: 60_000,
  });
  const loadDiff = Effect.fn("PullRequests.loadDiff")(function* (input: PullRequestDiffInput) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const loader = yield* PullRequestDiffLoader.PullRequestDiffLoader;
    const prepared = yield* SubscriptionRef.get(supervisor.prepared);
    if (Option.isNone(prepared)) {
      return yield* new EnvironmentHttpConnectionNotReadyError({
        message: "The environment HTTP connection is not ready.",
      });
    }
    return yield* loader.load(prepared.value, input);
  });

  const runAction = Effect.fn("PullRequests.runAction")(function* (
    input: PullRequestActionInput & {
      readonly resolveMergeMethod?: (detail: PullRequestDetail) => PullRequestMergeMethod;
    },
  ) {
    const { resolveMergeMethod, ...actionInput } = input;
    let preparedInput = actionInput;
    if (actionInput.action === "merge" && resolveMergeMethod !== undefined) {
      const { projectId, host, repository, number } = actionInput;
      const reference = { projectId, host, repository, number, allowStale: false };
      const detail = yield* routedRequest(WS_METHODS.pullRequestsDetail, reference);
      if (
        detail.state !== "open" ||
        detail.isDraft ||
        !detail.capabilities.actions.includes("merge") ||
        !detail.viewerPermissions.actions.includes("merge")
      ) {
        return yield* new PullRequestOperationError({
          operation: "runAction",
          detail: "This pull request cannot be merged.",
        });
      }
      if (detail.capabilities.stackActions) {
        const stack = yield* routedRequest(WS_METHODS.pullRequestsStack, reference);
        if (stack !== null) {
          return yield* new PullRequestOperationError({
            operation: "runAction",
            detail: "Open this pull request to merge its stack.",
          });
        }
      }
      const mergeMethod = yield* Effect.try({
        try: () => resolveMergeMethod(detail),
        catch: (cause) =>
          new PullRequestOperationError({
            operation: "runAction",
            detail: cause instanceof Error ? cause.message : "Could not choose a merge method.",
          }),
      });
      preparedInput = { ...actionInput, mergeMethod };
    }
    return yield* routedRequest(WS_METHODS.pullRequestsRunAction, {
      ...preparedInput,
      replyWithSummary: true,
    });
  });
  const actionReplyReaders = (registry: AtomRegistry.AtomRegistry) =>
    Array.from(registry.getNodes().keys()).flatMap((atom) => {
      const patch = typeof atom === "string" ? undefined : actionReplyPatches.get(atom);
      return patch === undefined ? [] : [patch];
    });
  const readsInFlight = (registry: AtomRegistry.AtomRegistry): ReadonlySet<object> =>
    new Set(actionReplyReaders(registry).flatMap((reader) => reader.pendingRead(registry) ?? []));
  const applyActionReply = Effect.fn("PullRequests.applyActionReply")(function* (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    reference: PullRequestRef,
    reply: PullRequestSummary | undefined,
    readsBeforeSend: ReadonlySet<object>,
  ) {
    for (const reader of actionReplyReaders(registry)) {
      yield* reader.apply(registry, environmentId, reference, reply, readsBeforeSend);
    }
    if (reply !== undefined && reference.expectedAccountId === undefined) {
      yield* (
        onAnswer.actionReply?.({ environmentId, input: reference }, reply, registry) ?? Effect.void
      );
    }
  });
  const checksLabel = "environment-data:pull-requests:checks";
  const checksPersistence = persistQuery(Schema.NullOr(PullRequestChecks));
  // Panels take the state from the newest of detail and checks, so checks show writes too.
  const checks = normalizePullRequestQuery(
    actionPatchedQuery(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: checksLabel,
        persistence: checksPersistence,
        tag: WS_METHODS.pullRequestsChecks,
        execute: (input) => routedRequest(WS_METHODS.pullRequestsChecks, input),
        staleTimeMs: 45_000,
        refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
        ...(onAnswer.checks === undefined ? {} : { onAnswer: onAnswer.checks }),
      }),
      {
        label: checksLabel,
        persistence: checksPersistence,
        onAnswer: onAnswer.checks,
        concerns: samePullRequest,
        patch: (_input, value, _reference, reply) =>
          value === null || value.state === reply.state || isStalePullRequestReply(value, reply)
            ? value
            : { ...value, state: reply.state },
        edit: (_input, value, edits) => {
          const state = edits.findLast((edit) => edit.state !== undefined)?.state;
          return value === null || state === undefined || value.state === state
            ? value
            : { ...value, state };
        },
      },
    ),
  );
  const listLabel = "environment-data:pull-requests:list";
  const listPersistence = persistQuery(PullRequestListResult);

  return {
    refreshes,
    linkedThreads: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:linked-threads",
      persistence: persistQuery(PullRequestLinkedThreadsResult),
      tag: WS_METHODS.pullRequestsLinkedThreads,
      staleTimeMs: 0,
      refreshIntervalMs: 10_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
    // For callers that open a thread from the answer: a persisted one reads as final before
    // the connection is known, and a kept one can predate the thread.
    linkedThreadsUncached: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:linked-threads-uncached",
      tag: WS_METHODS.pullRequestsLinkedThreads,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    list: actionPatchedQuery(
      createEnvironmentRpcQueryAtomFamily(runtime, {
        label: listLabel,
        persistence: listPersistence,
        tag: WS_METHODS.pullRequestsList,
        staleTimeMs: 30_000,
        refreshTrigger: ({ environmentId, input }) =>
          input.cursors === undefined ? refreshes({ environmentId, input: {} }) : undefined,
        ...(onAnswer.list === undefined ? {} : { onAnswer: onAnswer.list }),
      }),
      {
        label: listLabel,
        persistence: listPersistence,
        onAnswer: onAnswer.list,
        // Rows carry no account scope, so a reply read through another account leaves them alone.
        concerns: (input, reference) =>
          reference.expectedAccountId === undefined &&
          (input.projectId === undefined || input.projectId === reference.projectId) &&
          (input.projectIds === undefined || input.projectIds.includes(reference.projectId)) &&
          (input.host === undefined ||
            reference.host === undefined ||
            input.host.toLowerCase() === reference.host.toLowerCase()),
        refreshedByServer: (input) => input.cursors === undefined,
        patch: patchListWithReply,
        edit: (input, value, edit) => {
          const entries = editListEntries(input, value.entries, edit);
          return entries === value.entries ? value : { ...value, entries };
        },
      },
    ),
    /**
     * Its own query because the listing is quicker without them — measured over twelve
     * repositories, ~4.0s against ~7.1s — so the rows arrive first and their stats a moment
     * later.
     */
    listStats: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:list-stats",
      persistence: persistPullRequestStats(),
      tag: WS_METHODS.pullRequestsListStats,
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
      ...(onAnswer.listStats === undefined ? {} : { onAnswer: onAnswer.listStats }),
    }),
    filterOptions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:filter-options",
      tag: WS_METHODS.pullRequestsFilterOptions,
      staleTimeMs: 5 * 60_000,
    }),
    detail,
    detailReadVersion,
    preview,
    previewCard,
    checks,
    activity,
    threadComments: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:thread-comments",
      tag: WS_METHODS.pullRequestsThreadComments,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsThreadComments, input),
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.cursor]),
      },
    }),
    diff: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:diff",
      persistence: persistQuery(PullRequestDiffResult),
      staleTimeMs: 60_000,
      execute: loadDiff,
    }),
    diffFileContents: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:diff-file-contents",
      tag: WS_METHODS.pullRequestsDiffFileContents,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsDiffFileContents, input),
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.projectId,
            input.host?.toLowerCase() ?? null,
            input.repository,
            input.number,
            input.commit ?? null,
            input.changeType,
            input.oldPath,
            input.newPath,
          ]),
      },
    }),
    filesViewed: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:files-viewed",
      persistence: persistQuery(PullRequestFilesViewedResult),
      tag: WS_METHODS.pullRequestsFilesViewed,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsFilesViewed, input),
      staleTimeMs: 15_000,
    }),
    changeBreakdown: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:change-breakdown",
      persistence: persistQuery(PullRequestChangeBreakdown),
      tag: WS_METHODS.pullRequestsChangeBreakdown,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsChangeBreakdown, input),
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId }) => refreshes({ environmentId, input: {} }),
    }),
    /**
     * One write in flight per change request: the host applies these in order, and a reader
     * ticking down a file list faster than the round trip would otherwise race their own presses.
     */
    setFilesViewed: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:set-files-viewed",
      tag: WS_METHODS.pullRequestsSetFilesViewed,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsSetFilesViewed, input),
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.repository, input.number]),
      },
    }),
    runAction: showWhileInFlight(
      createEnvironmentRpcCommand(runtime, {
        tag: WS_METHODS.pullRequestsRunAction,
        label: "environment-data:pull-requests:run-action",
        // Preparation belongs to the write's lane. Refreshable queries would restart it after
        // every preceding action, and preparing outside the lane could reorder the clicks.
        execute: runAction,
        onStart: (_target, registry) => readsInFlight(registry),
        // Loaded readers show the reply, or re-read when the host's reply lacked the pull request.
        onSuccess: ({ environmentId, input }, registry, reply, readsBeforeSend) =>
          applyActionReply(
            registry,
            environmentId,
            pullRequestReference(input),
            reply,
            readsBeforeSend ?? new Set(),
          ).pipe(
            // The re-read a bare reply starts would otherwise show the old state until it answers.
            Effect.andThen(
              Effect.sync(() => {
                if (reply === undefined)
                  settleEdit(
                    registry,
                    environmentId,
                    actionEdit(input, loadedMergeQueue(registry, { environmentId, input })),
                    true,
                  );
              }),
            ),
          ),
        scheduler: commandScheduler,
        concurrency: serialPerEnvironment,
      }),
      (registry, target) => actionEdit(target.input, loadedMergeQueue(registry, target)),
    ),
    update: showWhileInFlight(
      createEnvironmentRpcCommand(runtime, {
        label: "environment-data:pull-requests:update",
        tag: WS_METHODS.pullRequestsUpdate,
        execute: (input) => routedRequest(WS_METHODS.pullRequestsUpdate, input),
        onSuccess: (target, registry) => {
          const edit = updateEdit(target.input);
          return Effect.sync(() => settleEdit(registry, target.environmentId, edit)).pipe(
            Effect.andThen(() =>
              edit === null
                ? Effect.void
                : (onAnswer.acceptedEdit?.(target, edit, registry) ?? Effect.void),
            ),
          );
        },
        scheduler: commandScheduler,
        concurrency: serialPerEnvironment,
      }),
      (_registry, { input }) => updateEdit(input),
    ),
    comment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:comment",
      tag: WS_METHODS.pullRequestsComment,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsComment, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    updateComment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:update-comment",
      tag: WS_METHODS.pullRequestsUpdateComment,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsUpdateComment, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: ({ environmentId, input: { projectId, host, repository, number } }, registry) =>
        Effect.sync(() =>
          registry.refresh(
            activity({
              environmentId,
              input: { projectId, ...(host === undefined ? {} : { host }), repository, number },
            }),
          ),
        ),
    }),
    submitReview: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:submit-review",
      tag: WS_METHODS.pullRequestsSubmitReview,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsSubmitReview, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    replyToThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:reply-to-thread",
      tag: WS_METHODS.pullRequestsReplyToThread,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsReplyToThread, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    reviewerCandidates,
    /** The host's search for reviewers past the first page, keyed by what was typed. */
    reviewerSearch,
    requestReviewers: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:request-reviewers",
      tag: WS_METHODS.pullRequestsRequestReviewers,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsRequestReviewers, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          const { reviewers, requested } = target.input;
          const candidatesAtom = reviewerCandidates(target);
          const candidates = AsyncResult.getOrElse(registry.get(candidatesAtom), () => null);
          const selected =
            candidates?.candidates.filter((candidate) =>
              reviewers.some(
                (reviewer) => reviewer.id === candidate.id && reviewer.kind === candidate.kind,
              ),
            ) ?? [];
          const missingIdentities = selected.length < reviewers.length;
          // Somebody found only by the host's search is not in the loaded list yet; the host
          // puts requested reviewers first, so reading it again brings them in.
          updateCached(
            registry,
            candidatesAtom,
            (value) => ({
              ...value,
              candidates: value.candidates.map((candidate) =>
                selected.includes(candidate) ? { ...candidate, isRequested: requested } : candidate,
              ),
            }),
            missingIdentities,
          );
          const selectedLogins = new Set(
            selected.map((candidate) => candidate.login.toLowerCase()),
          );
          const updateReviewers = (
            actors: ReadonlyArray<PullRequestActor>,
            keep = (_actor: PullRequestActor) => false,
          ) =>
            requested
              ? [
                  ...actors,
                  ...selected
                    .filter(
                      (candidate) =>
                        !actors.some(
                          (actor) => actor.login.toLowerCase() === candidate.login.toLowerCase(),
                        ),
                    )
                    .map(({ login, name, avatarUrl }) => ({ login, name, avatarUrl })),
                ]
              : actors.filter(
                  (actor) => !selectedLogins.has(actor.login.toLowerCase()) || keep(actor),
                );
          for (const atom of loadedDetails(registry, target)) {
            updateCached(
              registry,
              atom,
              (value) => ({
                ...value,
                reviewers: updateReviewers(value.reviewers),
              }),
              missingIdentities,
            );
          }
          updateCached(
            registry,
            activity(target),
            (value) => ({
              ...value,
              reviewers:
                value.reviewers === undefined
                  ? undefined
                  : updateReviewers(value.reviewers, (actor) =>
                      value.comments.some(
                        (comment) =>
                          (comment.kind === "review" || comment.kind === "review-comment") &&
                          comment.author?.login.toLowerCase() === actor.login.toLowerCase(),
                      ),
                    ),
            }),
            missingIdentities,
          );
        }),
    }),
    reviewGuide,
    generateReviewGuide: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:generate-review-guide",
      tag: WS_METHODS.pullRequestsGenerateReviewGuide,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsGenerateReviewGuide, input),
      onSuccess: (target, registry, result) =>
        Effect.sync(() => {
          updateCached(registry, reviewGuide(target), () => result, true);
        }),
    }),
    labelCandidates,
    setLabels: showWhileInFlight(
      createEnvironmentRpcCommand(runtime, {
        label: "environment-data:pull-requests:set-labels",
        tag: WS_METHODS.pullRequestsSetLabels,
        execute: (input) => routedRequest(WS_METHODS.pullRequestsSetLabels, input),
        scheduler: commandScheduler,
        concurrency: serialPerEnvironment,
        onSuccess: (target, registry) =>
          Effect.sync(() =>
            settleEdit(registry, target.environmentId, labelEdit(registry, target)),
          ),
      }),
      labelEdit,
    ),
    setThreadResolution: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:set-thread-resolution",
      tag: WS_METHODS.pullRequestsSetThreadResolution,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsSetThreadResolution, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    setReaction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:set-reaction",
      tag: WS_METHODS.pullRequestsSetReaction,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsSetReaction, input),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    /**
     * A separate request rather than a flag on a read, so only a person's refresh spends
     * host requests while every silent re-read shares the cache.
     */
    invalidate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:invalidate",
      tag: WS_METHODS.pullRequestsInvalidate,
      execute: (input) => routedRequest(WS_METHODS.pullRequestsInvalidate, input),
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          if (input.reference !== undefined) {
            registry.refresh(preview({ environmentId, input: input.reference }));
            registry.refresh(previewCard({ environmentId, input: input.reference }));
          }
        }),
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}
