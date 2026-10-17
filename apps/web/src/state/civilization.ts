import {
  type CivilizationCensusCursor,
  type CivilizationContextInspectionCursor,
  type CivilizationContextInspectionId,
  type CivilizationContextInspectionOutcome,
  type CivilizationCitizenReassignmentRequest,
  type CivilizationCitizenTitleRequest,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  type CivilizationConfigOverride,
  type CivilizationEffectiveConfig,
  type EnvironmentId,
  type CivilizationInboxCursor,
  type CivilizationMessageId,
  type CivilizationNoteId,
  type CivilizationNotesCursor,
} from "@t3tools/contracts";
import {
  fetchCurrentEnvironmentCivilizationCensusPage,
  fetchCurrentEnvironmentCivilizationContextInspectionDetail,
  fetchCurrentEnvironmentCivilizationContextInspectionPage,
  fetchCurrentEnvironmentCivilizationNoteBody,
  fetchCurrentEnvironmentCivilizationNotesPage,
  fetchEnvironmentCivilizationOverview,
  fetchCurrentEnvironmentCivilizationRetainedMailBody,
  fetchCurrentEnvironmentCivilizationRetainedMailPage,
  runEnvironmentCivilizationConfigAction,
  runEnvironmentCivilizationCitizenAction,
  runEnvironmentCivilizationDataAction,
} from "@t3tools/client-runtime/state/civilization";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "./session";
import { useEnvironmentQuery } from "./query";

export function civilizationOverviewQueryKey(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): string {
  return JSON.stringify([environmentId, projectId]);
}

export interface CivilizationOverview {
  readonly status: Effect.Success<
    ReturnType<typeof fetchEnvironmentCivilizationOverview>
  >["status"];
  readonly capabilities: Effect.Success<
    ReturnType<typeof fetchEnvironmentCivilizationOverview>
  >["capabilities"];
  readonly description: Effect.Success<
    ReturnType<typeof fetchEnvironmentCivilizationOverview>
  >["description"];
  readonly effective: Effect.Success<
    ReturnType<typeof fetchEnvironmentCivilizationOverview>
  >["effective"];
}

export interface CivilizationConfigTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
}

export function civilizationConfigExpectedRevision(
  effective: CivilizationEffectiveConfig,
  projectId: ProjectId | null,
): number {
  return projectId === null ? effective.environmentRevision : effective.projectRevision;
}

export type CivilizationImportPreviewCandidate =
  | {
      readonly ok: true;
      readonly bytes: number;
      readonly override: CivilizationConfigOverride;
    }
  | {
      readonly ok: false;
      readonly bytes: number;
      readonly reason: "invalid_json" | "import_too_large";
      readonly message: string;
    };

export function prepareCivilizationImportPreview(
  json: string,
  maxBytes: number,
): CivilizationImportPreviewCandidate {
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > maxBytes) {
    return {
      ok: false,
      bytes,
      reason: "import_too_large",
      message: `import_too_large: import is ${bytes} bytes; server-advertised limit is ${maxBytes} bytes.`,
    };
  }
  try {
    return { ok: true, bytes, override: JSON.parse(json) as CivilizationConfigOverride };
  } catch {
    return {
      ok: false,
      bytes,
      reason: "invalid_json",
      message: "invalid_json: configuration JSON could not be parsed for preview.",
    };
  }
}

export class CivilizationEnvironmentDisconnectedError extends Schema.TaggedError<CivilizationEnvironmentDisconnectedError>()(
  "CivilizationEnvironmentDisconnectedError",
  { environmentId: Schema.String },
) {}

export type CivilizationConfigActionInput = CivilizationConfigTarget &
  (
    | { readonly type: "validate"; readonly override: CivilizationConfigOverride }
    | { readonly type: "diff"; readonly override: CivilizationConfigOverride }
    | {
        readonly type: "set";
        readonly expectedRevision: number;
        readonly override: CivilizationConfigOverride;
      }
    | { readonly type: "reset"; readonly expectedRevision: number }
    | { readonly type: "import"; readonly expectedRevision: number; readonly json: string }
    | { readonly type: "export" }
  );

const civilizationOverviewAtom = Atom.family((serializedKey: string) => {
  const [environmentId, rawProjectId] = JSON.parse(serializedKey) as [string, string | null];
  const projectId = rawProjectId === null ? null : ProjectId.make(rawProjectId);
  return connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId as EnvironmentId)),
      );
      if (prepared === null) return Effect.never;
      return fetchEnvironmentCivilizationOverview({
        prepared,
        ...(projectId === null ? {} : { projectId }),
      });
    })
    .pipe(
      Atom.setIdleTTL(60_000),
      Atom.withLabel(
        `civilization-overview:${environmentId}:${projectId === null ? "environment" : projectId}`,
      ),
    );
});

export function useCivilizationOverview(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
) {
  const atom =
    environmentId === null
      ? null
      : civilizationOverviewAtom(civilizationOverviewQueryKey(environmentId, projectId));
  return useEnvironmentQuery(atom);
}

export function refreshCivilizationOverview(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): void {
  appAtomRegistry.refresh(
    civilizationOverviewAtom(civilizationOverviewQueryKey(environmentId, projectId)),
  );
}

export function civilizationConfigTargetsKey(
  targets: ReadonlyArray<CivilizationConfigTarget>,
): string {
  return JSON.stringify(
    targets
      .map((target) => [target.environmentId, target.projectId])
      .toSorted((a, b) => `${a[0]}:${a[1] ?? ""}`.localeCompare(`${b[0]}:${b[1] ?? ""}`)),
  );
}

const civilizationConfigTargetsAtom = Atom.family((serializedKey: string) => {
  const rawTargets = JSON.parse(serializedKey) as ReadonlyArray<readonly [string, string | null]>;
  return connectionAtomRuntime
    .atom((get) =>
      Effect.forEach(
        rawTargets,
        ([rawEnvironmentId, rawProjectId]) => {
          const environmentId = rawEnvironmentId as EnvironmentId;
          const projectId = rawProjectId === null ? null : ProjectId.make(rawProjectId);
          const prepared = Option.getOrNull(
            get(environmentSession.preparedConnectionValueAtom(environmentId)),
          );
          if (prepared === null) return Effect.never;
          return fetchEnvironmentCivilizationOverview({
            prepared,
            ...(projectId === null ? {} : { projectId }),
          }).pipe(Effect.map((overview) => ({ environmentId, projectId, overview })));
        },
        { concurrency: "unbounded" },
      ),
    )
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`civilization-config-targets:${serializedKey}`));
});

export function useCivilizationConfigTargets(targets: ReadonlyArray<CivilizationConfigTarget>) {
  const atom =
    targets.length === 0
      ? null
      : civilizationConfigTargetsAtom(civilizationConfigTargetsKey(targets));
  return useEnvironmentQuery(atom);
}

export const civilizationConfigAction = connectionAtomRuntime.fn<CivilizationConfigActionInput>()(
  (input, get) =>
    Effect.gen(function* () {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(input.environmentId)),
      );
      if (prepared === null) {
        return yield* new CivilizationEnvironmentDisconnectedError({
          environmentId: input.environmentId,
        });
      }
      return yield* runEnvironmentCivilizationConfigAction({
        prepared,
        ...(input.projectId === null ? {} : { projectId: input.projectId }),
        action: input,
      });
    }),
  { concurrent: false },
);

export interface CivilizationContextInspectionFilters {
  readonly threadId?: ThreadId | undefined;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly outcome?: CivilizationContextInspectionOutcome | undefined;
  readonly runId?: RunId | undefined;
  readonly attemptId?: RunAttemptId | undefined;
  readonly providerTurnOrdinal?: number | undefined;
}

export function civilizationContextInspectionQueryKey(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  filters: CivilizationContextInspectionFilters,
  cursor: CivilizationContextInspectionCursor | null,
  limit: number,
): string {
  return JSON.stringify([
    environmentId,
    projectId,
    filters.threadId ?? null,
    filters.providerInstanceId ?? null,
    filters.outcome ?? null,
    filters.runId ?? null,
    filters.attemptId ?? null,
    filters.providerTurnOrdinal ?? null,
    cursor,
    limit,
  ]);
}

function civilizationProjectPageKey(
  parts: ReadonlyArray<string | number | boolean | null>,
): string {
  return JSON.stringify(parts);
}

const civilizationCensusPageAtom = Atom.family((serializedKey: string) => {
  const [rawEnvironmentId, rawProjectId, rawCursor, rawLimit] = JSON.parse(serializedKey) as [
    string,
    string,
    string | null,
    number,
  ];
  const environmentId = rawEnvironmentId as EnvironmentId;
  const projectId = ProjectId.make(rawProjectId);
  return connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return fetchCurrentEnvironmentCivilizationCensusPage({
        prepared,
        projectId,
        ...(rawCursor === null ? {} : { cursor: rawCursor as CivilizationCensusCursor }),
        limit: rawLimit,
      });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`civilization-census:${serializedKey}`));
});

export function useCivilizationCensusPage(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  cursor: CivilizationCensusCursor | null,
  limit: number,
) {
  const atom =
    environmentId === null || projectId === null
      ? null
      : civilizationCensusPageAtom(
          civilizationProjectPageKey([environmentId, projectId, cursor, limit]),
        );
  return useEnvironmentQuery(atom);
}

const civilizationNotesPageAtom = Atom.family((serializedKey: string) => {
  const [rawEnvironmentId, rawProjectId, rawCursor, rawLimit, includeResolved] = JSON.parse(
    serializedKey,
  ) as [string, string, string | null, number, boolean];
  const environmentId = rawEnvironmentId as EnvironmentId;
  const projectId = ProjectId.make(rawProjectId);
  return connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return fetchCurrentEnvironmentCivilizationNotesPage({
        prepared,
        projectId,
        ...(rawCursor === null ? {} : { cursor: rawCursor as CivilizationNotesCursor }),
        limit: rawLimit,
        includeResolved,
      });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`civilization-notes:${serializedKey}`));
});

export function useCivilizationNotesPage(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  cursor: CivilizationNotesCursor | null,
  limit: number,
  includeResolved: boolean,
) {
  const atom =
    environmentId === null || projectId === null
      ? null
      : civilizationNotesPageAtom(
          civilizationProjectPageKey([environmentId, projectId, cursor, limit, includeResolved]),
        );
  return useEnvironmentQuery(atom);
}

const civilizationContextInspectionPageAtom = Atom.family((serializedKey: string) => {
  const [
    rawEnvironmentId,
    rawProjectId,
    rawThreadId,
    rawProviderInstanceId,
    rawOutcome,
    rawRunId,
    rawAttemptId,
    rawProviderTurnOrdinal,
    rawCursor,
    rawLimit,
  ] = JSON.parse(serializedKey) as [
    string,
    string,
    string | null,
    string | null,
    CivilizationContextInspectionOutcome | null,
    string | null,
    string | null,
    number | null,
    string | null,
    number,
  ];
  const environmentId = rawEnvironmentId as EnvironmentId;
  const projectId = ProjectId.make(rawProjectId);
  return connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return fetchCurrentEnvironmentCivilizationContextInspectionPage({
        prepared,
        projectId,
        ...(rawThreadId === null ? {} : { threadId: ThreadId.make(rawThreadId) }),
        ...(rawProviderInstanceId === null
          ? {}
          : { providerInstanceId: ProviderInstanceId.make(rawProviderInstanceId) }),
        ...(rawOutcome === null ? {} : { outcome: rawOutcome }),
        ...(rawRunId === null ? {} : { runId: RunId.make(rawRunId) }),
        ...(rawAttemptId === null ? {} : { attemptId: RunAttemptId.make(rawAttemptId) }),
        ...(rawProviderTurnOrdinal === null ? {} : { providerTurnOrdinal: rawProviderTurnOrdinal }),
        ...(rawCursor === null ? {} : { cursor: rawCursor as CivilizationContextInspectionCursor }),
        limit: rawLimit,
      });
    })
    .pipe(
      Atom.setIdleTTL(60_000),
      Atom.withLabel(`civilization-context-inspections:${serializedKey}`),
    );
});

export function useCivilizationContextInspectionPage(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  filters: CivilizationContextInspectionFilters,
  cursor: CivilizationContextInspectionCursor | null,
  limit: number,
) {
  const { attemptId, outcome, providerInstanceId, providerTurnOrdinal, runId, threadId } = filters;
  const atom =
    environmentId === null || projectId === null
      ? null
      : civilizationContextInspectionPageAtom(
          civilizationContextInspectionQueryKey(
            environmentId,
            projectId,
            { attemptId, outcome, providerInstanceId, providerTurnOrdinal, runId, threadId },
            cursor,
            limit,
          ),
        );
  return useEnvironmentQuery(atom);
}

const civilizationRetainedMailPageAtom = Atom.family((serializedKey: string) => {
  const [rawEnvironmentId, rawProjectId, rawCursor, rawLimit] = JSON.parse(serializedKey) as [
    string,
    string,
    string | null,
    number,
  ];
  const environmentId = rawEnvironmentId as EnvironmentId;
  const projectId = ProjectId.make(rawProjectId);
  return connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return fetchCurrentEnvironmentCivilizationRetainedMailPage({
        prepared,
        projectId,
        ...(rawCursor === null ? {} : { cursor: rawCursor as CivilizationInboxCursor }),
        limit: rawLimit,
      });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`civilization-retained-mail:${serializedKey}`));
});

export function useCivilizationRetainedMailPage(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  cursor: CivilizationInboxCursor | null,
  limit: number,
) {
  const atom =
    environmentId === null || projectId === null
      ? null
      : civilizationRetainedMailPageAtom(
          civilizationProjectPageKey([environmentId, projectId, cursor, limit]),
        );
  return useEnvironmentQuery(atom);
}

export type CivilizationSensitiveReadInput =
  | {
      readonly type: "noteBody";
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly noteId: CivilizationNoteId;
    }
  | {
      readonly type: "mailBody";
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly messageId: CivilizationMessageId;
    }
  | {
      readonly type: "contextInspection";
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly inspectionId: CivilizationContextInspectionId;
    };

export const civilizationSensitiveReadAction =
  connectionAtomRuntime.fn<CivilizationSensitiveReadInput>()(
    (input, get) =>
      Effect.gen(function* () {
        const prepared = Option.getOrNull(
          get(environmentSession.preparedConnectionValueAtom(input.environmentId)),
        );
        if (prepared === null) {
          return yield* new CivilizationEnvironmentDisconnectedError({
            environmentId: input.environmentId,
          });
        }
        if (input.type === "noteBody") {
          return yield* fetchCurrentEnvironmentCivilizationNoteBody({
            prepared,
            projectId: input.projectId,
            noteId: input.noteId,
          });
        }
        if (input.type === "mailBody") {
          return yield* fetchCurrentEnvironmentCivilizationRetainedMailBody({
            prepared,
            projectId: input.projectId,
            messageId: input.messageId,
          });
        }
        return yield* fetchCurrentEnvironmentCivilizationContextInspectionDetail({
          prepared,
          projectId: input.projectId,
          inspectionId: input.inspectionId,
        });
      }),
    { concurrent: false },
  );

export type CivilizationProjectReadInput =
  | {
      readonly type: "censusPage";
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly cursor: CivilizationCensusCursor;
      readonly limit: number;
    }
  | {
      readonly type: "notesPage";
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly cursor: CivilizationNotesCursor;
      readonly limit: number;
      readonly includeResolved: boolean;
    }
  | {
      readonly type: "mailPage";
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly cursor: CivilizationInboxCursor;
      readonly limit: number;
    };

export const civilizationProjectReadAction =
  connectionAtomRuntime.fn<CivilizationProjectReadInput>()(
    (input, get) =>
      Effect.gen(function* () {
        const prepared = Option.getOrNull(
          get(environmentSession.preparedConnectionValueAtom(input.environmentId)),
        );
        if (prepared === null) {
          return yield* new CivilizationEnvironmentDisconnectedError({
            environmentId: input.environmentId,
          });
        }
        switch (input.type) {
          case "censusPage":
            return yield* fetchCurrentEnvironmentCivilizationCensusPage({
              prepared,
              projectId: input.projectId,
              cursor: input.cursor,
              limit: input.limit,
            });
          case "notesPage":
            return yield* fetchCurrentEnvironmentCivilizationNotesPage({
              prepared,
              projectId: input.projectId,
              cursor: input.cursor,
              limit: input.limit,
              includeResolved: input.includeResolved,
            });
          case "mailPage":
            return yield* fetchCurrentEnvironmentCivilizationRetainedMailPage({
              prepared,
              projectId: input.projectId,
              cursor: input.cursor,
              limit: input.limit,
            });
        }
      }),
    { concurrent: false },
  );

export type CivilizationCitizenActionInput = {
  readonly environmentId: EnvironmentId;
} & (
  | {
      readonly type: "reassignmentPreview";
      readonly request: CivilizationCitizenReassignmentRequest;
    }
  | { readonly type: "reassignmentApply"; readonly request: CivilizationCitizenReassignmentRequest }
  | { readonly type: "titleRestore"; readonly request: CivilizationCitizenTitleRequest }
  | { readonly type: "titleReclaim"; readonly request: CivilizationCitizenTitleRequest }
);

export const civilizationCitizenAction = connectionAtomRuntime.fn<CivilizationCitizenActionInput>()(
  (input, get) =>
    Effect.gen(function* () {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(input.environmentId)),
      );
      if (prepared === null) {
        return yield* new CivilizationEnvironmentDisconnectedError({
          environmentId: input.environmentId,
        });
      }
      return yield* runEnvironmentCivilizationCitizenAction({ prepared, action: input });
    }),
  { concurrent: false },
);

export type CivilizationDataActionInput = {
  readonly environmentId: EnvironmentId;
} & (
  | { readonly type: "export"; readonly projectId: ProjectId }
  | { readonly type: "retentionGet"; readonly projectId: ProjectId }
  | { readonly type: "retentionPreview"; readonly projectId: ProjectId }
  | {
      readonly type: "retentionApply";
      readonly projectId: ProjectId;
      readonly expectedPreviewToken: string;
    }
  | { readonly type: "purgePreview"; readonly projectId: ProjectId }
  | {
      readonly type: "purgeApply";
      readonly projectId: ProjectId;
      readonly expectedPreviewToken: string;
      readonly batchSize?: number | undefined;
    }
);

export const civilizationDataAction = connectionAtomRuntime.fn<CivilizationDataActionInput>()(
  (input, get) =>
    Effect.gen(function* () {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(input.environmentId)),
      );
      if (prepared === null) {
        return yield* new CivilizationEnvironmentDisconnectedError({
          environmentId: input.environmentId,
        });
      }
      if (input.type === "purgeApply") {
        return yield* runEnvironmentCivilizationDataAction({
          prepared,
          action: {
            type: "purgeApply",
            request: {
              projectId: input.projectId,
              expectedPreviewToken: input.expectedPreviewToken,
              ...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
            },
          },
        });
      }
      return yield* runEnvironmentCivilizationDataAction({ prepared, action: input });
    }),
  { concurrent: false },
);

export interface CivilizationFanoutTarget<A> {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly value: A;
}

export interface CivilizationFanoutResult<A, E> {
  readonly applied: ReadonlyArray<{
    readonly target: CivilizationFanoutTarget<A>;
    readonly result: unknown;
  }>;
  readonly failed: { readonly target: CivilizationFanoutTarget<A>; readonly error: E } | null;
}

export type CivilizationRevisionPageState<A> =
  | { readonly status: "ready"; readonly revision: number; readonly items: ReadonlyArray<A> }
  | { readonly status: "stale"; readonly revision: number; readonly items: ReadonlyArray<A> };

/**
 * Keyset pages are appendable only while the server revision remains stable.
 * A revision change invalidates the cursor chain; callers must restart from the
 * first page rather than mixing snapshots.
 */
export function mergeCivilizationRevisionPage<A>(
  current: CivilizationRevisionPageState<A> | null,
  page: { readonly revision: number; readonly items: ReadonlyArray<A> },
): CivilizationRevisionPageState<A> {
  if (current === null) return { status: "ready", revision: page.revision, items: page.items };
  if (current.revision !== page.revision) {
    return { status: "stale", revision: page.revision, items: page.items };
  }
  return { status: "ready", revision: current.revision, items: [...current.items, ...page.items] };
}

/** Sequential by design: independent environment commits stop at the first failure. */
export async function applyCivilizationConfigFanout<A, E>(
  targets: ReadonlyArray<CivilizationFanoutTarget<A>>,
  commit: (target: CivilizationFanoutTarget<A>) => Promise<unknown>,
): Promise<CivilizationFanoutResult<A, E>> {
  const applied: Array<{ readonly target: CivilizationFanoutTarget<A>; readonly result: unknown }> =
    [];
  for (const target of targets) {
    try {
      applied.push({ target, result: await commit(target) });
    } catch (error) {
      return { applied, failed: { target, error: error as E } };
    }
  }
  return { applied, failed: null };
}
