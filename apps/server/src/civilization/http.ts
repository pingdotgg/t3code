import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  CivilizationCensusCursor,
  CivilizationInboxCursor,
  CivilizationNotesCursor,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  type CivilizationProviderCapability,
  type CivilizationStatus,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ConfigService from "./ConfigService.ts";
import * as CitizenService from "./CitizenService.ts";
import * as AdministrationService from "./AdministrationService.ts";
import * as ContextService from "./ContextService.ts";
import * as KnowledgeService from "./KnowledgeService.ts";
import * as MailService from "./MailService.ts";
import * as OperationsService from "./OperationsService.ts";

const withCivilizationStorageErrors = <A, R>(
  effect: Effect.Effect<A, ConfigService.CivilizationConfigServiceError, R>,
) =>
  effect.pipe(
    Effect.catchTags({
      SqlError: (cause) => failEnvironmentInternal("internal_error", cause),
    }),
  );

export const civilizationStatusWithCapabilities = (
  status: CivilizationStatus,
  providerCapabilities: ReadonlyArray<CivilizationProviderCapability>,
): CivilizationStatus => {
  const degraded =
    status.status !== "disabled" &&
    providerCapabilities.some((capability) => capability.support === "unsupported");
  return {
    ...status,
    ...(degraded
      ? {
          status: "degraded" as const,
          detail: [status.detail, "One or more registered provider adapters are unavailable."]
            .filter((detail): detail is string => detail !== undefined)
            .join(" "),
        }
      : {}),
    providerCapabilities: [...providerCapabilities],
  };
};

const resumeAdoption = (
  citizens: CitizenService.CivilizationCitizenService["Service"],
  projectId?: ProjectId,
) =>
  citizens.adoptExisting(projectId === undefined ? undefined : { projectId }).pipe(
    Effect.tap((summary) =>
      summary.adopted === 0
        ? Effect.void
        : Effect.logInfo("Civilization adoption applied", {
            projectId: projectId ?? "environment",
            ...summary,
          }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Civilization adoption will be resumed later", {
        projectId: projectId ?? "environment",
        cause,
      }),
    ),
  );

const parseOptionalPositiveInteger = (value: string | undefined) => {
  if (value === undefined) return { ok: true as const, value: undefined };
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1
    ? { ok: true as const, value: parsed }
    : { ok: false as const };
};

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "civilization",
  Effect.fnUntraced(function* (handlers) {
    const config = yield* ConfigService.CivilizationConfigService;
    const citizens = yield* CitizenService.CivilizationCitizenService;
    const administration = yield* AdministrationService.CivilizationAdministrationService;
    const context = yield* ContextService.CivilizationContextService;
    const knowledge = yield* KnowledgeService.CivilizationKnowledgeService;
    const mail = yield* MailService.CivilizationMailService;
    const operations = yield* OperationsService.CivilizationOperationsService;

    const authorizeRead = (endpoint: string) =>
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest(endpoint);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
      });

    const authorizeSettingsWrite = (endpoint: string) =>
      Effect.gen(function* () {
        yield* annotateEnvironmentRequest(endpoint);
        yield* requireEnvironmentScope(AuthSettingsWriteScope);
      });

    return handlers
      .handle(
        "status",
        Effect.fn("environment.civilization.status")(function* (args) {
          yield* authorizeRead(args.endpoint.name);
          const status = yield* withCivilizationStorageErrors(config.status(args.query.projectId));
          return civilizationStatusWithCapabilities(status, yield* context.listCapabilities());
        }),
      )
      .handle(
        "capabilities",
        Effect.fn("environment.civilization.capabilities")(function* (args) {
          yield* authorizeRead(args.endpoint.name);
          return { providers: yield* context.listCapabilities() };
        }),
      )
      .handle(
        "configDescribe",
        Effect.fn("environment.civilization.configDescribe")(function* (args) {
          yield* authorizeRead(args.endpoint.name);
          return yield* config.describe;
        }),
      )
      .handle(
        "configGet",
        Effect.fn("environment.civilization.configGet")(function* (args) {
          yield* authorizeRead(args.endpoint.name);
          return yield* withCivilizationStorageErrors(config.getEffective(args.query.projectId));
        }),
      )
      .handle(
        "configValidate",
        Effect.fn("environment.civilization.configValidate")(function* (args) {
          yield* authorizeRead(args.endpoint.name);
          const effective = yield* withCivilizationStorageErrors(config.validate(args.payload));
          return { valid: true as const, effective };
        }),
      )
      .handle(
        "configDiff",
        Effect.fn("environment.civilization.configDiff")(function* (args) {
          yield* authorizeRead(args.endpoint.name);
          return yield* withCivilizationStorageErrors(config.diff(args.payload));
        }),
      )
      .handle(
        "configSet",
        Effect.fn("environment.civilization.configSet")(function* (args) {
          yield* authorizeSettingsWrite(args.endpoint.name);
          const result = yield* withCivilizationStorageErrors(config.set(args.payload));
          yield* resumeAdoption(citizens, args.payload.projectId);
          return result;
        }),
      )
      .handle(
        "configReset",
        Effect.fn("environment.civilization.configReset")(function* (args) {
          yield* authorizeSettingsWrite(args.endpoint.name);
          return yield* withCivilizationStorageErrors(config.reset(args.payload));
        }),
      )
      .handle(
        "configImport",
        Effect.fn("environment.civilization.configImport")(function* (args) {
          yield* authorizeSettingsWrite(args.endpoint.name);
          const result = yield* withCivilizationStorageErrors(config.import(args.payload));
          yield* resumeAdoption(citizens, args.payload.projectId);
          return result;
        }),
      )
      .handle(
        "configExport",
        Effect.fn("environment.civilization.configExport")(function* (args) {
          yield* authorizeRead(args.endpoint.name);
          return yield* withCivilizationStorageErrors(config.export(args.query.projectId));
        }),
      )
      .handle(
        "citizenReassignmentPreview",
        Effect.fn("environment.civilization.citizenReassignmentPreview")(function* (args) {
          yield* authorizeSettingsWrite(args.endpoint.name);
          return yield* administration.previewReassignment(args.payload).pipe(
            Effect.catchTags({
              SqlError: (cause) => failEnvironmentInternal("internal_error", cause),
            }),
          );
        }),
      )
      .handle(
        "citizenReassignmentApply",
        Effect.fn("environment.civilization.citizenReassignmentApply")(function* (args) {
          yield* authorizeSettingsWrite(args.endpoint.name);
          return yield* administration.applyReassignment(args.payload).pipe(
            Effect.catchTags({
              SqlError: (cause) => failEnvironmentInternal("internal_error", cause),
            }),
          );
        }),
      )
      .handle(
        "citizenTitleRestore",
        Effect.fn("environment.civilization.citizenTitleRestore")(function* (args) {
          yield* authorizeSettingsWrite(args.endpoint.name);
          return yield* administration.restoreTitle(args.payload).pipe(
            Effect.catchTags({
              SqlError: (cause) => failEnvironmentInternal("internal_error", cause),
              CivilizationAdministrationError: (cause) =>
                failEnvironmentInternal("internal_error", cause),
            }),
          );
        }),
      )
      .handle(
        "citizenTitleReclaim",
        Effect.fn("environment.civilization.citizenTitleReclaim")(function* (args) {
          yield* authorizeSettingsWrite(args.endpoint.name);
          return yield* administration.reclaimTitle(args.payload).pipe(
            Effect.catchTags({
              SqlError: (cause) => failEnvironmentInternal("internal_error", cause),
              CivilizationAdministrationError: (cause) =>
                failEnvironmentInternal("internal_error", cause),
            }),
          );
        }),
      )
      .handle(
        "census",
        Effect.fn("environment.civilization.census")(function* (args) {
          yield* authorizeRead(args.endpoint.name);
          return yield* knowledge
            .listCensus({
              projectId: args.query.projectId,
              cursor: args.query.cursor,
              limit: args.query.limit === undefined ? undefined : Number(args.query.limit),
            })
            .pipe(
              Effect.map((page) => ({
                ...page,
                nextCursor:
                  page.nextCursor === null ? null : CivilizationCensusCursor.make(page.nextCursor),
              })),
              Effect.catchTags({
                SqlError: (cause) => failEnvironmentInternal("internal_error", cause),
                CivilizationKnowledgeInvalidError: (cause) =>
                  Effect.fail(new EnvironmentHttpBadRequestError({ message: cause.message })),
              }),
            );
        }),
      )
      .handle(
        "noteList",
        Effect.fn("environment.civilization.noteList")(function* (args) {
          yield* authorizeRead(args.endpoint.name);
          return yield* knowledge
            .listNotes({
              projectId: args.query.projectId,
              cursor: args.query.cursor,
              limit: args.query.limit === undefined ? undefined : Number(args.query.limit),
              includeResolved: args.query.includeResolved === "true",
            })
            .pipe(
              Effect.map((page) => ({
                ...page,
                nextCursor:
                  page.nextCursor === null ? null : CivilizationNotesCursor.make(page.nextCursor),
              })),
              Effect.catchTags({
                SqlError: (cause) => failEnvironmentInternal("internal_error", cause),
                CivilizationKnowledgeInvalidError: (cause) =>
                  Effect.fail(new EnvironmentHttpBadRequestError({ message: cause.message })),
              }),
            );
        }),
      )
      .handle(
        "noteRead",
        Effect.fn("environment.civilization.noteRead")(function* (args) {
          // Body inspection bypasses the per-agent transfer ceiling, so keep it
          // on the same administrative boundary as other Civilization operator
          // actions. Read-only agents use the MCP note reader, which supplies
          // their actual mode ceiling to KnowledgeService.
          yield* authorizeSettingsWrite(args.endpoint.name);
          return yield* knowledge
            .readNoteBody({ projectId: args.query.projectId, noteId: args.params.noteId })
            .pipe(
              Effect.catchTags({
                SqlError: (cause) => failEnvironmentInternal("internal_error", cause),
                CivilizationKnowledgeInvalidError: (cause) =>
                  Effect.fail(new EnvironmentHttpBadRequestError({ message: cause.message })),
              }),
            );
        }),
      )
      .handle(
        "contextInspectionList",
        Effect.fn("environment.civilization.contextInspectionList")(function* (args) {
          yield* authorizeRead(args.endpoint.name);
          const limitResult = parseOptionalPositiveInteger(args.query.limit);
          if (!limitResult.ok) {
            return yield* new EnvironmentHttpBadRequestError({
              message: "limit must be a positive integer.",
            });
          }
          const providerTurnOrdinalResult = parseOptionalPositiveInteger(
            args.query.providerTurnOrdinal,
          );
          if (!providerTurnOrdinalResult.ok) {
            return yield* new EnvironmentHttpBadRequestError({
              message: "providerTurnOrdinal must be a positive integer.",
            });
          }
          const limit = limitResult.value;
          const providerTurnOrdinal = providerTurnOrdinalResult.value;
          return yield* context
            .listInspections({
              projectId: args.query.projectId,
              ...(args.query.threadId === undefined ? {} : { threadId: args.query.threadId }),
              ...(args.query.providerInstanceId === undefined
                ? {}
                : { providerInstanceId: args.query.providerInstanceId }),
              ...(args.query.outcome === undefined ? {} : { outcome: args.query.outcome }),
              ...(args.query.runId === undefined ? {} : { runId: args.query.runId }),
              ...(args.query.attemptId === undefined ? {} : { attemptId: args.query.attemptId }),
              ...(providerTurnOrdinal === undefined ? {} : { providerTurnOrdinal }),
              ...(args.query.cursor === undefined ? {} : { cursor: args.query.cursor }),
              ...(limit === undefined ? {} : { limit }),
            })
            .pipe(
              Effect.catchTags({
                SqlError: (cause) => failEnvironmentInternal("internal_error", cause),
                CivilizationContextInspectionInvalidError: (cause) =>
                  Effect.fail(new EnvironmentHttpBadRequestError({ message: cause.message })),
              }),
            );
        }),
      )
      .handle(
        "contextInspectionRead",
        Effect.fn("environment.civilization.contextInspectionRead")(function* (args) {
          yield* authorizeSettingsWrite(args.endpoint.name);
          return yield* context
            .readInspection({
              projectId: args.query.projectId,
              inspectionId: args.params.inspectionId,
            })
            .pipe(
              Effect.catchTags({
                SqlError: (cause) => failEnvironmentInternal("internal_error", cause),
              }),
            );
        }),
      )
      .handle(
        "inboxList",
        Effect.fn("environment.civilization.inboxList")(function* (args) {
          yield* authorizeSettingsWrite(args.endpoint.name);
          return yield* mail
            .listAdminMail({
              projectId: args.query.projectId,
              ...(args.query.cursor === undefined ? {} : { cursor: args.query.cursor }),
              ...(args.query.limit === undefined ? {} : { limit: Number(args.query.limit) }),
            })
            .pipe(
              Effect.map((page) => ({
                ...page,
                nextCursor:
                  page.nextCursor === null ? null : CivilizationInboxCursor.make(page.nextCursor),
              })),
              Effect.catchTags({
                SqlError: (cause) => failEnvironmentInternal("internal_error", cause),
              }),
            );
        }),
      )
      .handle(
        "inboxRead",
        Effect.fn("environment.civilization.inboxRead")(function* (args) {
          yield* authorizeSettingsWrite(args.endpoint.name);
          return yield* mail
            .readAdminMessage({
              projectId: args.query.projectId,
              messageId: args.params.messageId,
            })
            .pipe(
              Effect.catchTags({
                SqlError: (cause) => failEnvironmentInternal("internal_error", cause),
              }),
            );
        }),
      )
      .handle(
        "dataExport",
        Effect.fn("environment.civilization.dataExport")(function* (args) {
          yield* authorizeSettingsWrite(args.endpoint.name);
          return yield* operations.exportProjectData(args.query.projectId).pipe(
            Effect.catchTags({
              SqlError: (cause) => failEnvironmentInternal("internal_error", cause),
            }),
          );
        }),
      )
      .handle(
        "purgePreview",
        Effect.fn("environment.civilization.purgePreview")(function* (args) {
          yield* authorizeSettingsWrite(args.endpoint.name);
          return yield* operations.previewPurge(args.query.projectId).pipe(
            Effect.catchTags({
              SqlError: (cause) => failEnvironmentInternal("internal_error", cause),
            }),
          );
        }),
      )
      .handle(
        "purgeApply",
        Effect.fn("environment.civilization.purgeApply")(function* (args) {
          yield* authorizeSettingsWrite(args.endpoint.name);
          return yield* operations.applyPurge(args.payload).pipe(
            Effect.catchTags({
              SqlError: (cause) => failEnvironmentInternal("internal_error", cause),
            }),
          );
        }),
      )
      .handle(
        "retentionGet",
        Effect.fn("environment.civilization.retentionGet")(function* (args) {
          yield* authorizeSettingsWrite(args.endpoint.name);
          return yield* operations.getAppliedRetentionPolicy(args.query.projectId).pipe(
            Effect.catchTags({
              SqlError: (cause) => failEnvironmentInternal("internal_error", cause),
            }),
          );
        }),
      )
      .handle(
        "retentionPreview",
        Effect.fn("environment.civilization.retentionPreview")(function* (args) {
          yield* authorizeSettingsWrite(args.endpoint.name);
          return yield* operations.previewRetentionReduction(args.query.projectId).pipe(
            Effect.catchTags({
              SqlError: (cause) => failEnvironmentInternal("internal_error", cause),
            }),
          );
        }),
      )
      .handle(
        "retentionApply",
        Effect.fn("environment.civilization.retentionApply")(function* (args) {
          yield* authorizeSettingsWrite(args.endpoint.name);
          return yield* operations.applyRetentionReduction(args.payload).pipe(
            Effect.catchTags({
              SqlError: (cause) => failEnvironmentInternal("internal_error", cause),
            }),
          );
        }),
      );
  }),
);
