import {
  CivilizationAgentAccessError,
  type CivilizationCensusCursor,
  type CivilizationContextInspectionCursor,
  type CivilizationContextInspectionId,
  type CivilizationContextInspectionOutcome,
  CivilizationCitizenNotFoundError,
  type CivilizationCitizenReassignmentRequest,
  type CivilizationCitizenTitleRequest,
  CivilizationConfigConflictError,
  CivilizationConfigInvalidError,
  type CivilizationConfigOverride,
  type CivilizationInboxCursor,
  CivilizationKnowledgeConflictError,
  CivilizationMailConflictError,
  CivilizationMailInvalidError,
  CivilizationMailNotFoundError,
  type CivilizationMessageId,
  type CivilizationNoteId,
  CivilizationNoteNotFoundError,
  type CivilizationNotesCursor,
  CivilizationOperationInvalidError,
  CivilizationPurgeConflictError,
  type CivilizationPurgeApplyRequest,
  CivilizationUnavailableError,
  type ProjectId,
  type ProviderInstanceId,
  type RunAttemptId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const DEFAULT_CIVILIZATION_READ_TIMEOUT_MS = 8_000;
const DEFAULT_CIVILIZATION_WRITE_TIMEOUT_MS = 12_000;
const isConfigConflict = Schema.is(CivilizationConfigConflictError);
const isConfigInvalid = Schema.is(CivilizationConfigInvalidError);
const isCivilizationUnavailable = Schema.is(CivilizationUnavailableError);
const isOperationInvalid = Schema.is(CivilizationOperationInvalidError);
const isCitizenNotFound = Schema.is(CivilizationCitizenNotFoundError);
const isKnowledgeConflict = Schema.is(CivilizationKnowledgeConflictError);
const isNoteNotFound = Schema.is(CivilizationNoteNotFoundError);
const isMailInvalid = Schema.is(CivilizationMailInvalidError);
const isMailConflict = Schema.is(CivilizationMailConflictError);
const isMailNotFound = Schema.is(CivilizationMailNotFoundError);
const isAgentAccess = Schema.is(CivilizationAgentAccessError);
const isPurgeConflict = Schema.is(CivilizationPurgeConflictError);

const unwrapCivilizationConfigError = <E>(error: E) => {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "RemoteEnvironmentAuthFetchError" &&
    "cause" in error
  ) {
    const cause = error.cause;
    if (
      isConfigConflict(cause) ||
      isConfigInvalid(cause) ||
      isCivilizationUnavailable(cause) ||
      isOperationInvalid(cause) ||
      isCitizenNotFound(cause) ||
      isKnowledgeConflict(cause) ||
      isNoteNotFound(cause) ||
      isMailInvalid(cause) ||
      isMailConflict(cause) ||
      isMailNotFound(cause) ||
      isAgentAccess(cause) ||
      isPurgeConflict(cause)
    ) {
      return cause;
    }
  }
  return error;
};

const preserveCivilizationConfigErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(unwrapCivilizationConfigError));

interface CivilizationEnvironmentRequestInput {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
  >;
  readonly timeoutMs?: number;
}

interface CivilizationScopedEnvironmentRequestInput extends CivilizationEnvironmentRequestInput {
  readonly projectId?: ProjectId | undefined;
}

const scopeQuery = (projectId: ProjectId | undefined) =>
  projectId === undefined ? {} : { projectId };

/** Read the current Civilization service status for an environment or project override scope. */
export const fetchEnvironmentCivilizationStatus = Effect.fn(
  "clientRuntime.state.fetchEnvironmentCivilizationStatus",
)(function* (input: CivilizationScopedEnvironmentRequestInput) {
  const endpoint = { query: scopeQuery(input.projectId) };
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "GET",
      url: (urls) => urls.status(endpoint),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_READ_TIMEOUT_MS,
      request: ({ client, headers }) => client.status({ ...endpoint, headers }),
    }),
  );
});

/** Read the provider capability matrix reported by the environment. */
export const fetchEnvironmentCivilizationCapabilities = Effect.fn(
  "clientRuntime.state.fetchEnvironmentCivilizationCapabilities",
)(function* (input: CivilizationEnvironmentRequestInput) {
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "GET",
      url: (urls) => urls.capabilities(),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_READ_TIMEOUT_MS,
      request: ({ client, headers }) => client.capabilities({ headers }),
    }),
  );
});

/** Read the server-owned Civilization schema metadata, limits, and application timing. */
export const fetchEnvironmentCivilizationConfigDescription = Effect.fn(
  "clientRuntime.state.fetchEnvironmentCivilizationConfigDescription",
)(function* (input: CivilizationEnvironmentRequestInput) {
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "GET",
      url: (urls) => urls.configDescribe(),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_READ_TIMEOUT_MS,
      request: ({ client, headers }) => client.configDescribe({ headers }),
    }),
  );
});

/** Read the effective Civilization config, revisions, and field provenance for a scope. */
export const fetchEnvironmentCivilizationConfig = Effect.fn(
  "clientRuntime.state.fetchEnvironmentCivilizationConfig",
)(function* (input: CivilizationScopedEnvironmentRequestInput) {
  const endpoint = { query: scopeQuery(input.projectId) };
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "GET",
      url: (urls) => urls.configGet(endpoint),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_READ_TIMEOUT_MS,
      request: ({ client, headers }) => client.configGet({ ...endpoint, headers }),
    }),
  );
});

/** Validate an environment/project Civilization override without committing it. */
export const validateEnvironmentCivilizationConfig = Effect.fn(
  "clientRuntime.state.validateEnvironmentCivilizationConfig",
)(function* (
  input: CivilizationScopedEnvironmentRequestInput & {
    readonly override: CivilizationConfigOverride;
  },
) {
  const payload = {
    ...scopeQuery(input.projectId),
    override: input.override,
  };
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "POST",
      url: (urls) => urls.configValidate(),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_READ_TIMEOUT_MS,
      request: ({ client, headers }) => client.configValidate({ payload, headers }),
    }),
  );
});

/** Diff a candidate override against the current effective Civilization config. */
export const diffEnvironmentCivilizationConfig = Effect.fn(
  "clientRuntime.state.diffEnvironmentCivilizationConfig",
)(function* (
  input: CivilizationScopedEnvironmentRequestInput & {
    readonly override: CivilizationConfigOverride;
  },
) {
  const payload = {
    ...scopeQuery(input.projectId),
    override: input.override,
  };
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "POST",
      url: (urls) => urls.configDiff(),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_READ_TIMEOUT_MS,
      request: ({ client, headers }) => client.configDiff({ payload, headers }),
    }),
  );
});

/** Commit a previously reviewed Civilization override at one exact tier revision. */
export const setEnvironmentCivilizationConfig = Effect.fn(
  "clientRuntime.state.setEnvironmentCivilizationConfig",
)(function* (
  input: CivilizationScopedEnvironmentRequestInput & {
    readonly expectedRevision: number;
    readonly override: CivilizationConfigOverride;
  },
) {
  const payload = {
    ...scopeQuery(input.projectId),
    expectedRevision: input.expectedRevision,
    override: input.override,
  };
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "POST",
      url: (urls) => urls.configSet(),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_WRITE_TIMEOUT_MS,
      request: ({ client, headers }) => client.configSet({ payload, headers }),
    }),
  );
});

/** Remove the selected environment/project override and inherit from the next tier. */
export const resetEnvironmentCivilizationConfig = Effect.fn(
  "clientRuntime.state.resetEnvironmentCivilizationConfig",
)(function* (
  input: CivilizationScopedEnvironmentRequestInput & {
    readonly expectedRevision: number;
  },
) {
  const payload = {
    ...scopeQuery(input.projectId),
    expectedRevision: input.expectedRevision,
  };
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "POST",
      url: (urls) => urls.configReset(),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_WRITE_TIMEOUT_MS,
      request: ({ client, headers }) => client.configReset({ payload, headers }),
    }),
  );
});

/** Import canonical JSON into one exact Civilization config tier revision. */
export const importEnvironmentCivilizationConfig = Effect.fn(
  "clientRuntime.state.importEnvironmentCivilizationConfig",
)(function* (
  input: CivilizationScopedEnvironmentRequestInput & {
    readonly expectedRevision: number;
    readonly json: string;
  },
) {
  const payload = {
    ...scopeQuery(input.projectId),
    expectedRevision: input.expectedRevision,
    json: input.json,
  };
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "POST",
      url: (urls) => urls.configImport(),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_WRITE_TIMEOUT_MS,
      request: ({ client, headers }) => client.configImport({ payload, headers }),
    }),
  );
});

/** Export the canonical stored override JSON for an environment/project tier. */
export const exportEnvironmentCivilizationConfig = Effect.fn(
  "clientRuntime.state.exportEnvironmentCivilizationConfig",
)(function* (input: CivilizationScopedEnvironmentRequestInput) {
  const endpoint = { query: scopeQuery(input.projectId) };
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "GET",
      url: (urls) => urls.configExport(endpoint),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_READ_TIMEOUT_MS,
      request: ({ client, headers }) => client.configExport({ ...endpoint, headers }),
    }),
  );
});

/** Read one revision-consistent census page. */
export const fetchEnvironmentCivilizationCensusPage = Effect.fn(
  "clientRuntime.state.fetchEnvironmentCivilizationCensusPage",
)(function* (
  input: CivilizationEnvironmentRequestInput & {
    readonly projectId: ProjectId;
    readonly cursor?: CivilizationCensusCursor | undefined;
    readonly limit?: number | undefined;
  },
) {
  const query = {
    projectId: input.projectId,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.limit === undefined ? {} : { limit: String(input.limit) }),
  };
  const endpoint = { query };
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "GET",
      url: (urls) => urls.census(endpoint),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_READ_TIMEOUT_MS,
      request: ({ client, headers }) => client.census({ ...endpoint, headers }),
    }),
  );
});

/** Read one revision-consistent note metadata page without fetching note bodies. */
export const fetchEnvironmentCivilizationNotesPage = Effect.fn(
  "clientRuntime.state.fetchEnvironmentCivilizationNotesPage",
)(function* (
  input: CivilizationEnvironmentRequestInput & {
    readonly projectId: ProjectId;
    readonly cursor?: CivilizationNotesCursor | undefined;
    readonly limit?: number | undefined;
    readonly includeResolved?: boolean | undefined;
  },
) {
  const query = {
    projectId: input.projectId,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.limit === undefined ? {} : { limit: String(input.limit) }),
    ...(input.includeResolved === undefined
      ? {}
      : { includeResolved: (input.includeResolved ? "true" : "false") as "true" | "false" }),
  };
  const endpoint = { query };
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "GET",
      url: (urls) => urls.noteList(endpoint),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_READ_TIMEOUT_MS,
      request: ({ client, headers }) => client.noteList({ ...endpoint, headers }),
    }),
  );
});

/** Read one metadata-only historical Civilization context-inspection page. */
export const fetchEnvironmentCivilizationContextInspectionPage = Effect.fn(
  "clientRuntime.state.fetchEnvironmentCivilizationContextInspectionPage",
)(function* (
  input: CivilizationEnvironmentRequestInput & {
    readonly projectId: ProjectId;
    readonly threadId?: ThreadId | undefined;
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly outcome?: CivilizationContextInspectionOutcome | undefined;
    readonly runId?: RunId | undefined;
    readonly attemptId?: RunAttemptId | undefined;
    readonly providerTurnOrdinal?: number | undefined;
    readonly cursor?: CivilizationContextInspectionCursor | undefined;
    readonly limit?: number | undefined;
  },
) {
  const query = {
    projectId: input.projectId,
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    ...(input.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: input.providerInstanceId }),
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
    ...(input.providerTurnOrdinal === undefined
      ? {}
      : { providerTurnOrdinal: String(input.providerTurnOrdinal) }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.limit === undefined ? {} : { limit: String(input.limit) }),
  };
  const endpoint = { query };
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "GET",
      url: (urls) => urls.contextInspectionList(endpoint),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_READ_TIMEOUT_MS,
      request: ({ client, headers }) => client.contextInspectionList({ ...endpoint, headers }),
    }),
  );
});

/** Read one sensitive historical packet only after an explicit operator action. */
export const fetchEnvironmentCivilizationContextInspectionDetail = Effect.fn(
  "clientRuntime.state.fetchEnvironmentCivilizationContextInspectionDetail",
)(function* (
  input: CivilizationEnvironmentRequestInput & {
    readonly projectId: ProjectId;
    readonly inspectionId: CivilizationContextInspectionId;
  },
) {
  const endpoint = {
    params: { inspectionId: input.inspectionId },
    query: { projectId: input.projectId },
  };
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "GET",
      url: (urls) => urls.contextInspectionRead(endpoint),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_READ_TIMEOUT_MS,
      request: ({ client, headers }) => client.contextInspectionRead({ ...endpoint, headers }),
    }),
  );
});

/** Read one sensitive note body on explicit operator action. */
export const fetchEnvironmentCivilizationNoteBody = Effect.fn(
  "clientRuntime.state.fetchEnvironmentCivilizationNoteBody",
)(function* (
  input: CivilizationEnvironmentRequestInput & {
    readonly projectId: ProjectId;
    readonly noteId: CivilizationNoteId;
  },
) {
  const endpoint = { params: { noteId: input.noteId }, query: { projectId: input.projectId } };
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "GET",
      url: (urls) => urls.noteRead(endpoint),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_READ_TIMEOUT_MS,
      request: ({ client, headers }) => client.noteRead({ ...endpoint, headers }),
    }),
  );
});

/** List retained mail metadata only; bodies stay behind inboxRead. */
export const fetchEnvironmentCivilizationRetainedMailPage = Effect.fn(
  "clientRuntime.state.fetchEnvironmentCivilizationRetainedMailPage",
)(function* (
  input: CivilizationEnvironmentRequestInput & {
    readonly projectId: ProjectId;
    readonly cursor?: CivilizationInboxCursor | undefined;
    readonly limit?: number | undefined;
  },
) {
  const query = {
    projectId: input.projectId,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.limit === undefined ? {} : { limit: String(input.limit) }),
  };
  const endpoint = { query };
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "GET",
      url: (urls) => urls.inboxList(endpoint),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_READ_TIMEOUT_MS,
      request: ({ client, headers }) => client.inboxList({ ...endpoint, headers }),
    }),
  );
});

/** Read one retained mail body on explicit operator action. */
export const fetchEnvironmentCivilizationRetainedMailBody = Effect.fn(
  "clientRuntime.state.fetchEnvironmentCivilizationRetainedMailBody",
)(function* (
  input: CivilizationEnvironmentRequestInput & {
    readonly projectId: ProjectId;
    readonly messageId: CivilizationMessageId;
  },
) {
  const endpoint = {
    params: { messageId: input.messageId },
    query: { projectId: input.projectId },
  };
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "GET",
      url: (urls) => urls.inboxRead(endpoint),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_READ_TIMEOUT_MS,
      request: ({ client, headers }) => client.inboxRead({ ...endpoint, headers }),
    }),
  );
});

export const previewEnvironmentCivilizationCitizenReassignment = Effect.fn(
  "clientRuntime.state.previewEnvironmentCivilizationCitizenReassignment",
)(function* (
  input: CivilizationEnvironmentRequestInput & {
    readonly request: CivilizationCitizenReassignmentRequest;
  },
) {
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "POST",
      url: (urls) => urls.citizenReassignmentPreview(),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_READ_TIMEOUT_MS,
      request: ({ client, headers }) =>
        client.citizenReassignmentPreview({ payload: input.request, headers }),
    }),
  );
});

export const applyEnvironmentCivilizationCitizenReassignment = Effect.fn(
  "clientRuntime.state.applyEnvironmentCivilizationCitizenReassignment",
)(function* (
  input: CivilizationEnvironmentRequestInput & {
    readonly request: CivilizationCitizenReassignmentRequest;
  },
) {
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "POST",
      url: (urls) => urls.citizenReassignmentApply(),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_WRITE_TIMEOUT_MS,
      request: ({ client, headers }) =>
        client.citizenReassignmentApply({ payload: input.request, headers }),
    }),
  );
});

const runEnvironmentCivilizationTitleAction = (
  input: CivilizationEnvironmentRequestInput & {
    readonly request: CivilizationCitizenTitleRequest;
    readonly action: "restore" | "reclaim";
  },
) =>
  preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "POST",
      url: (urls) =>
        input.action === "restore" ? urls.citizenTitleRestore() : urls.citizenTitleReclaim(),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_WRITE_TIMEOUT_MS,
      request: ({ client, headers }) =>
        input.action === "restore"
          ? client.citizenTitleRestore({ payload: input.request, headers })
          : client.citizenTitleReclaim({ payload: input.request, headers }),
    }),
  );

export const restoreEnvironmentCivilizationCitizenTitle = Effect.fn(
  "clientRuntime.state.restoreEnvironmentCivilizationCitizenTitle",
)(function* (
  input: CivilizationEnvironmentRequestInput & {
    readonly request: CivilizationCitizenTitleRequest;
  },
) {
  return yield* runEnvironmentCivilizationTitleAction({ ...input, action: "restore" });
});

export const reclaimEnvironmentCivilizationCitizenTitle = Effect.fn(
  "clientRuntime.state.reclaimEnvironmentCivilizationCitizenTitle",
)(function* (
  input: CivilizationEnvironmentRequestInput & {
    readonly request: CivilizationCitizenTitleRequest;
  },
) {
  return yield* runEnvironmentCivilizationTitleAction({ ...input, action: "reclaim" });
});

/** Fetch a typed project inspection export on explicit operator action. */
export const exportEnvironmentCivilizationProjectData = Effect.fn(
  "clientRuntime.state.exportEnvironmentCivilizationProjectData",
)(function* (
  input: CivilizationEnvironmentRequestInput & {
    readonly projectId: ProjectId;
  },
) {
  const endpoint = { query: { projectId: input.projectId } };
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "GET",
      url: (urls) => urls.dataExport(endpoint),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_WRITE_TIMEOUT_MS,
      request: ({ client, headers }) => client.dataExport({ ...endpoint, headers }),
    }),
  );
});

/** Read the currently applied retention policy for one project. */
export const fetchEnvironmentCivilizationRetentionPolicy = Effect.fn(
  "clientRuntime.state.fetchEnvironmentCivilizationRetentionPolicy",
)(function* (
  input: CivilizationEnvironmentRequestInput & {
    readonly projectId: ProjectId;
  },
) {
  const endpoint = { query: { projectId: input.projectId } };
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "GET",
      url: (urls) => urls.retentionGet(endpoint),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_READ_TIMEOUT_MS,
      request: ({ client, headers }) => client.retentionGet({ ...endpoint, headers }),
    }),
  );
});

/** Preview retention reduction without mutating data. */
export const previewEnvironmentCivilizationRetentionReduction = Effect.fn(
  "clientRuntime.state.previewEnvironmentCivilizationRetentionReduction",
)(function* (
  input: CivilizationEnvironmentRequestInput & {
    readonly projectId: ProjectId;
  },
) {
  const endpoint = { query: { projectId: input.projectId } };
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "GET",
      url: (urls) => urls.retentionPreview(endpoint),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_READ_TIMEOUT_MS,
      request: ({ client, headers }) => client.retentionPreview({ ...endpoint, headers }),
    }),
  );
});

/** Apply exactly one previously previewed retention reduction token. */
export const applyEnvironmentCivilizationRetentionReduction = Effect.fn(
  "clientRuntime.state.applyEnvironmentCivilizationRetentionReduction",
)(function* (
  input: CivilizationEnvironmentRequestInput & {
    readonly projectId: ProjectId;
    readonly expectedPreviewToken: string;
  },
) {
  const payload = {
    projectId: input.projectId,
    expectedPreviewToken: input.expectedPreviewToken,
  };
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "POST",
      url: (urls) => urls.retentionApply(),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_WRITE_TIMEOUT_MS,
      request: ({ client, headers }) => client.retentionApply({ payload, headers }),
    }),
  );
});

/** Preview exact project purge counts and limitations. */
export const previewEnvironmentCivilizationPurge = Effect.fn(
  "clientRuntime.state.previewEnvironmentCivilizationPurge",
)(function* (
  input: CivilizationEnvironmentRequestInput & {
    readonly projectId: ProjectId;
  },
) {
  const endpoint = { query: { projectId: input.projectId } };
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "GET",
      url: (urls) => urls.purgePreview(endpoint),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_READ_TIMEOUT_MS,
      request: ({ client, headers }) => client.purgePreview({ ...endpoint, headers }),
    }),
  );
});

/** Apply one bounded purge batch against an exact preview token. */
export const applyEnvironmentCivilizationPurgeBatch = Effect.fn(
  "clientRuntime.state.applyEnvironmentCivilizationPurgeBatch",
)(function* (
  input: CivilizationEnvironmentRequestInput & {
    readonly request: CivilizationPurgeApplyRequest;
  },
) {
  return yield* preserveCivilizationConfigErrors(
    executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "civilization",
      method: "POST",
      url: (urls) => urls.purgeApply(),
      timeoutMs: input.timeoutMs ?? DEFAULT_CIVILIZATION_WRITE_TIMEOUT_MS,
      request: ({ client, headers }) => client.purgeApply({ payload: input.request, headers }),
    }),
  );
});

const currentCivilizationAuth = Effect.gen(function* () {
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );
  return { signer, remoteAuthorization };
});

export const fetchCurrentEnvironmentCivilizationCensusPage = Effect.fn(
  "clientRuntime.state.fetchCurrentEnvironmentCivilizationCensusPage",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly projectId: ProjectId;
  readonly cursor?: CivilizationCensusCursor | undefined;
  readonly limit?: number | undefined;
}) {
  const auth = yield* currentCivilizationAuth;
  return yield* fetchEnvironmentCivilizationCensusPage({ ...input, ...auth });
});

export const fetchCurrentEnvironmentCivilizationNotesPage = Effect.fn(
  "clientRuntime.state.fetchCurrentEnvironmentCivilizationNotesPage",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly projectId: ProjectId;
  readonly cursor?: CivilizationNotesCursor | undefined;
  readonly limit?: number | undefined;
  readonly includeResolved?: boolean | undefined;
}) {
  const auth = yield* currentCivilizationAuth;
  return yield* fetchEnvironmentCivilizationNotesPage({ ...input, ...auth });
});

export const fetchCurrentEnvironmentCivilizationContextInspectionPage = Effect.fn(
  "clientRuntime.state.fetchCurrentEnvironmentCivilizationContextInspectionPage",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly projectId: ProjectId;
  readonly threadId?: ThreadId | undefined;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly outcome?: CivilizationContextInspectionOutcome | undefined;
  readonly runId?: RunId | undefined;
  readonly attemptId?: RunAttemptId | undefined;
  readonly providerTurnOrdinal?: number | undefined;
  readonly cursor?: CivilizationContextInspectionCursor | undefined;
  readonly limit?: number | undefined;
}) {
  const auth = yield* currentCivilizationAuth;
  return yield* fetchEnvironmentCivilizationContextInspectionPage({ ...input, ...auth });
});

export const fetchCurrentEnvironmentCivilizationContextInspectionDetail = Effect.fn(
  "clientRuntime.state.fetchCurrentEnvironmentCivilizationContextInspectionDetail",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly projectId: ProjectId;
  readonly inspectionId: CivilizationContextInspectionId;
}) {
  const auth = yield* currentCivilizationAuth;
  return yield* fetchEnvironmentCivilizationContextInspectionDetail({ ...input, ...auth });
});

export const fetchCurrentEnvironmentCivilizationNoteBody = Effect.fn(
  "clientRuntime.state.fetchCurrentEnvironmentCivilizationNoteBody",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly projectId: ProjectId;
  readonly noteId: CivilizationNoteId;
}) {
  const auth = yield* currentCivilizationAuth;
  return yield* fetchEnvironmentCivilizationNoteBody({ ...input, ...auth });
});

export const fetchCurrentEnvironmentCivilizationRetainedMailPage = Effect.fn(
  "clientRuntime.state.fetchCurrentEnvironmentCivilizationRetainedMailPage",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly projectId: ProjectId;
  readonly cursor?: CivilizationInboxCursor | undefined;
  readonly limit?: number | undefined;
}) {
  const auth = yield* currentCivilizationAuth;
  return yield* fetchEnvironmentCivilizationRetainedMailPage({ ...input, ...auth });
});

export const fetchCurrentEnvironmentCivilizationRetainedMailBody = Effect.fn(
  "clientRuntime.state.fetchCurrentEnvironmentCivilizationRetainedMailBody",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly projectId: ProjectId;
  readonly messageId: CivilizationMessageId;
}) {
  const auth = yield* currentCivilizationAuth;
  return yield* fetchEnvironmentCivilizationRetainedMailBody({ ...input, ...auth });
});

export type EnvironmentCivilizationDataAction =
  | { readonly type: "export"; readonly projectId: ProjectId }
  | { readonly type: "retentionGet"; readonly projectId: ProjectId }
  | { readonly type: "retentionPreview"; readonly projectId: ProjectId }
  | {
      readonly type: "retentionApply";
      readonly projectId: ProjectId;
      readonly expectedPreviewToken: string;
    }
  | { readonly type: "purgePreview"; readonly projectId: ProjectId }
  | { readonly type: "purgeApply"; readonly request: CivilizationPurgeApplyRequest };

export const runEnvironmentCivilizationDataAction = Effect.fn(
  "clientRuntime.state.runEnvironmentCivilizationDataAction",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly action: EnvironmentCivilizationDataAction;
}) {
  const auth = yield* currentCivilizationAuth;
  switch (input.action.type) {
    case "export":
      return yield* exportEnvironmentCivilizationProjectData({
        prepared: input.prepared,
        ...auth,
        projectId: input.action.projectId,
      });
    case "retentionGet":
      return yield* fetchEnvironmentCivilizationRetentionPolicy({
        prepared: input.prepared,
        ...auth,
        projectId: input.action.projectId,
      });
    case "retentionPreview":
      return yield* previewEnvironmentCivilizationRetentionReduction({
        prepared: input.prepared,
        ...auth,
        projectId: input.action.projectId,
      });
    case "retentionApply":
      return yield* applyEnvironmentCivilizationRetentionReduction({
        prepared: input.prepared,
        ...auth,
        projectId: input.action.projectId,
        expectedPreviewToken: input.action.expectedPreviewToken,
      });
    case "purgePreview":
      return yield* previewEnvironmentCivilizationPurge({
        prepared: input.prepared,
        ...auth,
        projectId: input.action.projectId,
      });
    case "purgeApply":
      return yield* applyEnvironmentCivilizationPurgeBatch({
        prepared: input.prepared,
        ...auth,
        request: input.action.request,
      });
  }
});

export type EnvironmentCivilizationCitizenAction =
  | {
      readonly type: "reassignmentPreview";
      readonly request: CivilizationCitizenReassignmentRequest;
    }
  | { readonly type: "reassignmentApply"; readonly request: CivilizationCitizenReassignmentRequest }
  | { readonly type: "titleRestore"; readonly request: CivilizationCitizenTitleRequest }
  | { readonly type: "titleReclaim"; readonly request: CivilizationCitizenTitleRequest };

export const runEnvironmentCivilizationCitizenAction = Effect.fn(
  "clientRuntime.state.runEnvironmentCivilizationCitizenAction",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly action: EnvironmentCivilizationCitizenAction;
}) {
  const auth = yield* currentCivilizationAuth;
  switch (input.action.type) {
    case "reassignmentPreview":
      return yield* previewEnvironmentCivilizationCitizenReassignment({
        prepared: input.prepared,
        ...auth,
        request: input.action.request,
      });
    case "reassignmentApply":
      return yield* applyEnvironmentCivilizationCitizenReassignment({
        prepared: input.prepared,
        ...auth,
        request: input.action.request,
      });
    case "titleRestore":
      return yield* restoreEnvironmentCivilizationCitizenTitle({
        prepared: input.prepared,
        ...auth,
        request: input.action.request,
      });
    case "titleReclaim":
      return yield* reclaimEnvironmentCivilizationCitizenTitle({
        prepared: input.prepared,
        ...auth,
        request: input.action.request,
      });
  }
});

export type EnvironmentCivilizationConfigAction =
  | { readonly type: "validate"; readonly override: CivilizationConfigOverride }
  | { readonly type: "diff"; readonly override: CivilizationConfigOverride }
  | {
      readonly type: "set";
      readonly expectedRevision: number;
      readonly override: CivilizationConfigOverride;
    }
  | { readonly type: "reset"; readonly expectedRevision: number }
  | { readonly type: "import"; readonly expectedRevision: number; readonly json: string }
  | { readonly type: "export" };

/** Web-oriented config command that resolves the current relay authorization services at execution time. */
export const runEnvironmentCivilizationConfigAction = Effect.fn(
  "clientRuntime.state.runEnvironmentCivilizationConfigAction",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly projectId?: ProjectId | undefined;
  readonly action: EnvironmentCivilizationConfigAction;
  readonly timeoutMs?: number;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );
  const auth = {
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  };
  switch (input.action.type) {
    case "validate":
      return yield* validateEnvironmentCivilizationConfig({
        ...auth,
        override: input.action.override,
      });
    case "diff":
      return yield* diffEnvironmentCivilizationConfig({ ...auth, override: input.action.override });
    case "set":
      return yield* setEnvironmentCivilizationConfig({
        ...auth,
        expectedRevision: input.action.expectedRevision,
        override: input.action.override,
      });
    case "reset":
      return yield* resetEnvironmentCivilizationConfig({
        ...auth,
        expectedRevision: input.action.expectedRevision,
      });
    case "import":
      return yield* importEnvironmentCivilizationConfig({
        ...auth,
        expectedRevision: input.action.expectedRevision,
        json: input.action.json,
      });
    case "export":
      return yield* exportEnvironmentCivilizationConfig(auth);
  }
});

/**
 * UI-oriented read bundle. Resolves the current relay auth services from the
 * client runtime so web state only supplies the prepared environment and scope.
 */
export const fetchEnvironmentCivilizationOverview = Effect.fn(
  "clientRuntime.state.fetchEnvironmentCivilizationOverview",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly projectId?: ProjectId | undefined;
  readonly timeoutMs?: number;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );
  const scoped = {
    ...input,
    signer,
    remoteAuthorization,
  };
  const unscoped = {
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  };
  const [status, capabilities, description, effective] = yield* Effect.all(
    [
      fetchEnvironmentCivilizationStatus(scoped),
      fetchEnvironmentCivilizationCapabilities(unscoped),
      fetchEnvironmentCivilizationConfigDescription(unscoped),
      fetchEnvironmentCivilizationConfig(scoped),
    ] as const,
    { concurrency: "unbounded" },
  );
  return { status, capabilities, description, effective };
});
