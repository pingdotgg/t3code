import {
  CivilizationCitizenNotFoundError,
  type CivilizationCitizenReassignmentPreview,
  type CivilizationCitizenReassignmentRequest,
  type CivilizationCitizenSummary,
  type CivilizationLineageStatus,
  type CivilizationRelationshipToParent,
  type CivilizationCitizenTitleRequest,
  type CivilizationCitizenTitleResult,
  type CivilizationEffectiveConfig,
  CivilizationConfigConflictError,
  CivilizationOperationInvalidError,
  CommandId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  getEffectiveCivilizationConfig,
  isValidCivilizationDisplayName,
  normalizeCivilizationName,
} from "./ConfigService.ts";
import { resolveCivilizationAvailableName } from "./PersistenceParticipant.ts";

type CitizenAdministrationRow = {
  readonly thread_id: ThreadId;
  readonly project_id: ProjectId;
  readonly name_entry_id: string;
  readonly name_base: string;
  readonly name_display: string;
  readonly name_key: string;
  readonly name_pool_id: string;
  readonly profile_entry_id: string;
  readonly profile_label: string;
  readonly profile_traits_json: string;
  readonly profile_style_text: string;
  readonly profile_rich_label: string;
  readonly profile_rich_traits_json: string;
  readonly profile_rich_axiom: string;
  readonly profile_rich_voice: string;
  readonly profile_rich_style_text: string;
  readonly profile_pool_id: string;
  readonly title_managed: number;
  readonly preserved_title: string | null;
  readonly last_managed_title: string | null;
  readonly title_topic: string;
  readonly observed_only: number;
  readonly deleted: number;
  readonly revision: number;
};

type CitizenSummaryRow = {
  readonly thread_id: ThreadId;
  readonly project_id: ProjectId;
  readonly name_display: string;
  readonly profile_entry_id: string;
  readonly profile_label: string;
  readonly generation: number;
  readonly lineage_status: CivilizationLineageStatus;
  readonly parent_thread_id: ThreadId | null;
  readonly relationship_to_parent: CivilizationRelationshipToParent;
  readonly observed_only: number;
  readonly epoch: number;
  readonly closed: number;
  readonly deleted: number;
  readonly title_managed: number;
  readonly revision: number;
};

const encodeProfileTraits = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export class CivilizationAdministrationError extends Schema.TaggedError<CivilizationAdministrationError>()(
  "CivilizationAdministrationError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const invalidOperation = (reason: CivilizationOperationInvalidError["reason"], message: string) =>
  new CivilizationOperationInvalidError({
    code: "civilization_invalid_operation",
    reason,
    message,
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const readRow = Effect.fn("CivilizationAdministration.readRow")(function* (threadId: ThreadId) {
    const row = (yield* sql<CitizenAdministrationRow>`
        SELECT thread_id, project_id,
               name_entry_id, name_base, name_display, name_key, name_pool_id,
               profile_entry_id, profile_label, profile_traits_json, profile_style_text,
               profile_rich_label, profile_rich_traits_json, profile_rich_axiom, profile_rich_voice,
               profile_rich_style_text, profile_pool_id,
               title_managed, preserved_title, last_managed_title, title_topic,
               observed_only, deleted, revision
        FROM civilization_citizens
        WHERE thread_id = ${threadId}
        LIMIT 1
      `)[0];
    if (row === undefined) {
      return yield* new CivilizationCitizenNotFoundError({
        code: "civilization_citizen_not_found",
        threadId,
      });
    }
    return row;
  });

  const assertProject = (row: CitizenAdministrationRow, projectId: ProjectId) =>
    row.project_id === projectId
      ? Effect.void
      : Effect.fail(
          new CivilizationCitizenNotFoundError({
            code: "civilization_citizen_not_found",
            threadId: row.thread_id,
          }),
        );

  const assertCitizenRevision = (row: CitizenAdministrationRow, expectedRevision: number) =>
    row.revision === expectedRevision
      ? Effect.void
      : Effect.fail(
          new CivilizationConfigConflictError({
            code: "civilization_conflict",
            scope: "citizen",
            expectedRevision,
            currentRevision: row.revision,
          }),
        );

  const assertMutable = (row: CitizenAdministrationRow) =>
    row.deleted === 0
      ? Effect.void
      : Effect.fail(invalidOperation("citizen_deleted", "Deleted citizens cannot be reassigned."));

  const assertConfigRevisions = (
    effective: CivilizationEffectiveConfig,
    input: Pick<
      CivilizationCitizenReassignmentRequest,
      "expectedEnvironmentRevision" | "expectedProjectRevision"
    >,
  ) =>
    Effect.gen(function* () {
      if (effective.environmentRevision !== input.expectedEnvironmentRevision) {
        return yield* new CivilizationConfigConflictError({
          code: "civilization_conflict",
          scope: "environment",
          expectedRevision: input.expectedEnvironmentRevision,
          currentRevision: effective.environmentRevision,
        });
      }
      if (effective.projectRevision !== input.expectedProjectRevision) {
        return yield* new CivilizationConfigConflictError({
          code: "civilization_conflict",
          scope: "project",
          expectedRevision: input.expectedProjectRevision,
          currentRevision: effective.projectRevision,
        });
      }
    });

  const buildReassignment = Effect.fn("CivilizationAdministration.buildReassignment")(function* (
    input: CivilizationCitizenReassignmentRequest,
  ) {
    const row = yield* readRow(input.threadId);
    yield* assertProject(row, input.projectId);
    yield* assertCitizenRevision(row, input.expectedCitizenRevision);
    yield* assertMutable(row);
    const effective = yield* getEffectiveCivilizationConfig(row.project_id).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    yield* assertConfigRevisions(effective, input);
    if (!effective.config.participation.enabled || effective.config.participation.emergencyOff) {
      return yield* invalidOperation(
        "disabled",
        "Civilization identity changes are unavailable while the feature is disabled.",
      );
    }
    if (input.nameEntryId !== undefined && input.displayName !== undefined) {
      return yield* invalidOperation(
        "invalid_name",
        "Specify either nameEntryId or displayName, not both.",
      );
    }

    const namePool = effective.config.names.pools.find(
      (pool) => pool.id === effective.config.names.selectedPoolId,
    )!;
    let nameEntryId = row.name_entry_id;
    let nameBase = row.name_base;
    let nameDisplay = row.name_display;
    let nameKey = row.name_key;
    let namePoolId = row.name_pool_id;
    if (input.nameEntryId !== undefined) {
      const entry = namePool.entries.find(
        (candidate) => candidate.id === input.nameEntryId && candidate.weight > 0,
      );
      if (entry === undefined) {
        return yield* invalidOperation(
          "unknown_name_entry",
          `Name entry '${input.nameEntryId}' is not available in the selected pool.`,
        );
      }
      const available = yield* resolveCivilizationAvailableName(
        row.project_id,
        entry.displayName,
        row.thread_id,
      );
      nameEntryId = entry.id;
      nameBase = entry.displayName;
      nameDisplay = available.displayName;
      nameKey = available.nameKey;
      namePoolId = namePool.id;
    } else if (input.displayName !== undefined) {
      if (!isValidCivilizationDisplayName(input.displayName)) {
        return yield* invalidOperation(
          "invalid_name",
          "The requested display name is empty, too large, or contains unsafe formatting.",
        );
      }
      const requestedKey = normalizeCivilizationName(input.displayName);
      const conflict = (yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id
          FROM civilization_citizens
          WHERE project_id = ${row.project_id}
            AND name_key = ${requestedKey}
            AND thread_id <> ${row.thread_id}
          LIMIT 1
        `)[0];
      if (conflict !== undefined) {
        return yield* invalidOperation(
          "name_conflict",
          `Display name '${input.displayName}' is already in use in this civilization.`,
        );
      }
      nameDisplay = input.displayName;
      nameKey = requestedKey;
    }

    const profilePool = effective.config.personalities.pools.find(
      (pool) => pool.id === effective.config.personalities.selectedPoolId,
    )!;
    let profileEntryId = row.profile_entry_id;
    let profileLabel = row.profile_label;
    let profileTraitsJson = row.profile_traits_json;
    let profileStyleText = row.profile_style_text;
    let profileRichLabel = row.profile_rich_label;
    let profileRichTraitsJson = row.profile_rich_traits_json;
    let profileRichAxiom = row.profile_rich_axiom;
    let profileRichVoice = row.profile_rich_voice;
    let profileRichStyleText = row.profile_rich_style_text;
    let profilePoolId = row.profile_pool_id;
    if (input.profileEntryId !== undefined) {
      const entry = profilePool.entries.find(
        (candidate) => candidate.id === input.profileEntryId && candidate.weight > 0,
      );
      if (entry === undefined) {
        return yield* invalidOperation(
          "unknown_profile_entry",
          `Profile entry '${input.profileEntryId}' is not available in the selected pool.`,
        );
      }
      profileEntryId = entry.id;
      profileLabel = entry.label;
      profileTraitsJson = encodeProfileTraits(entry.traits);
      profileStyleText = entry.styleText;
      profileRichLabel = entry.rich.label;
      profileRichTraitsJson = encodeProfileTraits(entry.rich.traits);
      profileRichAxiom = entry.rich.axiom;
      profileRichVoice = entry.rich.voice;
      profileRichStyleText = entry.rich.styleText;
      profilePoolId = profilePool.id;
    }

    const changed =
      nameEntryId !== row.name_entry_id ||
      nameDisplay !== row.name_display ||
      profileEntryId !== row.profile_entry_id;
    if (!changed) {
      return yield* invalidOperation(
        "no_changes",
        "The requested reassignment does not change this citizen.",
      );
    }

    const preview: CivilizationCitizenReassignmentPreview = {
      threadId: row.thread_id,
      citizenRevision: row.revision,
      environmentRevision: effective.environmentRevision,
      projectRevision: effective.projectRevision,
      current: {
        nameEntryId: row.name_entry_id,
        name: row.name_display,
        profileEntryId: row.profile_entry_id,
        profileLabel: row.profile_label,
      },
      proposed: {
        nameEntryId,
        name: nameDisplay,
        profileEntryId,
        profileLabel,
      },
    };
    return {
      row,
      preview,
      next: {
        nameEntryId,
        nameBase,
        nameDisplay,
        nameKey,
        namePoolId,
        profileEntryId,
        profileLabel,
        profileTraitsJson,
        profileStyleText,
        profileRichLabel,
        profileRichTraitsJson,
        profileRichAxiom,
        profileRichVoice,
        profileRichStyleText,
        profilePoolId,
      },
      effective,
    } as const;
  });

  const requireCitizen = Effect.fn("CivilizationAdministration.requireCitizen")(function* (
    threadId: ThreadId,
  ) {
    const row = (yield* sql<CitizenSummaryRow>`
        SELECT thread_id, project_id, name_display, profile_entry_id, profile_label,
               generation, lineage_status, parent_thread_id, relationship_to_parent, observed_only,
               epoch, closed, deleted, title_managed, revision
        FROM civilization_citizens
        WHERE thread_id = ${threadId}
        LIMIT 1
      `)[0];
    if (row === undefined) {
      return yield* new CivilizationCitizenNotFoundError({
        code: "civilization_citizen_not_found",
        threadId,
      });
    }
    return {
      threadId: row.thread_id,
      projectId: row.project_id,
      name: row.name_display,
      profileId: row.profile_entry_id,
      profileLabel: row.profile_label,
      generation: row.generation,
      lineageStatus: row.lineage_status,
      parentThreadId: row.parent_thread_id,
      relationshipToParent: row.relationship_to_parent,
      observedOnly: row.observed_only === 1,
      epoch: row.epoch,
      closed: row.closed === 1,
      deleted: row.deleted === 1,
      titleManaged: row.title_managed === 1,
      revision: row.revision,
    } satisfies CivilizationCitizenSummary;
  });

  const previewReassignment = Effect.fn("CivilizationAdministration.previewReassignment")(
    function* (input: CivilizationCitizenReassignmentRequest) {
      return (yield* buildReassignment(input)).preview;
    },
  );

  const applyReassignment = Effect.fn("CivilizationAdministration.applyReassignment")(function* (
    input: CivilizationCitizenReassignmentRequest,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const plan = yield* buildReassignment(input);
        const nextRevision = plan.row.revision + 1;
        yield* sql`
          UPDATE civilization_citizens
          SET name_entry_id = ${plan.next.nameEntryId},
              name_base = ${plan.next.nameBase},
              name_display = ${plan.next.nameDisplay},
              name_key = ${plan.next.nameKey},
              name_pool_id = ${plan.next.namePoolId},
              name_environment_revision = ${plan.effective.environmentRevision},
              name_project_revision = ${plan.effective.projectRevision},
              profile_entry_id = ${plan.next.profileEntryId},
              profile_label = ${plan.next.profileLabel},
              profile_traits_json = ${plan.next.profileTraitsJson},
              profile_style_text = ${plan.next.profileStyleText},
              profile_rich_label = ${plan.next.profileRichLabel},
              profile_rich_traits_json = ${plan.next.profileRichTraitsJson},
              profile_rich_axiom = ${plan.next.profileRichAxiom},
              profile_rich_voice = ${plan.next.profileRichVoice},
              profile_rich_style_text = ${plan.next.profileRichStyleText},
              profile_pool_id = ${plan.next.profilePoolId},
              profile_environment_revision = ${plan.effective.environmentRevision},
              profile_project_revision = ${plan.effective.projectRevision},
              revision = ${nextRevision},
              updated_at = datetime('now')
          WHERE thread_id = ${plan.row.thread_id} AND revision = ${plan.row.revision}
        `;
        return yield* requireCitizen(plan.row.thread_id);
      }),
    );
  });

  const reclaimTitle = Effect.fn("CivilizationAdministration.reclaimTitle")(function* (
    input: CivilizationCitizenTitleRequest,
  ) {
    const projection = yield* threads.getThreadProjection(input.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new CivilizationAdministrationError({
            operation: "get-thread-for-title-reclaim",
            cause,
          }),
      ),
    );
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* readRow(input.threadId);
        yield* assertProject(row, input.projectId);
        yield* assertCitizenRevision(row, input.expectedCitizenRevision);
        yield* assertMutable(row);
        if (row.observed_only === 1) {
          return yield* invalidOperation(
            "observed_agent_read_only",
            "Provider-owned observed agents cannot participate in managed T3 titles.",
          );
        }
        const effective = yield* getEffectiveCivilizationConfig(row.project_id).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        if (
          !effective.config.participation.enabled ||
          effective.config.participation.emergencyOff
        ) {
          return yield* invalidOperation(
            "disabled",
            "Managed titles cannot be reclaimed while Civilization is disabled.",
          );
        }
        if (!effective.config.names.automaticTitles) {
          return yield* invalidOperation(
            "automatic_titles_disabled",
            "Managed titles cannot be reclaimed while automatic titles are disabled.",
          );
        }
        yield* sql`
          UPDATE civilization_citizens
          SET title_managed = 1,
              preserved_title = ${projection.thread.title},
              last_managed_title = NULL,
              title_topic = ${projection.thread.title},
              pending_title_command_id = NULL,
              pending_managed_title = NULL,
              pending_title_topic = NULL,
              revision = revision + 1,
              updated_at = datetime('now')
          WHERE thread_id = ${input.threadId} AND revision = ${row.revision}
        `;
      }),
    );
    const citizen = yield* requireCitizen(input.threadId);
    return {
      citizen,
      changed: true,
      threadTitle: projection.thread.title,
    } satisfies CivilizationCitizenTitleResult;
  });

  const restoreTitle = Effect.fn("CivilizationAdministration.restoreTitle")(function* (
    input: CivilizationCitizenTitleRequest,
  ) {
    const row = yield* readRow(input.threadId);
    yield* assertProject(row, input.projectId);
    yield* assertCitizenRevision(row, input.expectedCitizenRevision);
    yield* assertMutable(row);
    if (row.last_managed_title === null || row.preserved_title === null) {
      return yield* invalidOperation(
        "title_restore_unavailable",
        "This citizen has no prior managed title that can be safely restored.",
      );
    }
    const projection = yield* threads.getThreadProjection(input.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new CivilizationAdministrationError({
            operation: "get-thread-for-title-restore",
            cause,
          }),
      ),
    );
    if (projection.thread.title !== row.last_managed_title) {
      return yield* invalidOperation(
        "title_restore_unavailable",
        "The thread title changed after Civilization last managed it; restore will not overwrite that edit.",
      );
    }

    const restoreError = (cause: unknown) =>
      new CivilizationAdministrationError({ operation: "restore-thread-title", cause });
    yield* threads
      .dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(
          `civilization:title-restore:${input.threadId}:${input.expectedCitizenRevision}`,
        ),
        threadId: input.threadId,
        expectedTitle: row.last_managed_title,
        title: row.preserved_title,
      })
      .pipe(
        Effect.mapError(restoreError),
        Effect.catch((error) =>
          threads.getThreadProjection(input.threadId).pipe(
            Effect.flatMap((latest) =>
              latest.thread.title === row.last_managed_title
                ? Effect.void
                : sql`
                    UPDATE civilization_citizens
                    SET title_managed = 0,
                        preserved_title = ${latest.thread.title},
                        pending_title_command_id = NULL,
                        pending_managed_title = NULL,
                        pending_title_topic = NULL,
                        revision = revision + 1,
                        updated_at = datetime('now')
                    WHERE thread_id = ${input.threadId}
                      AND revision = ${row.revision}
                  `.pipe(Effect.asVoid),
            ),
            Effect.ignore({ log: true }),
            Effect.andThen(Effect.fail(error)),
          ),
        ),
      );

    // The production EventSink participant clears ownership in the same host
    // transaction as the successful metadata update. This conditional update
    // keeps the service correct under narrow test/fallback implementations that
    // do not install that participant, without double-incrementing production.
    yield* sql`
      UPDATE civilization_citizens
      SET title_managed = 0,
          pending_title_command_id = NULL,
          pending_managed_title = NULL,
          pending_title_topic = NULL,
          revision = revision + 1,
          updated_at = datetime('now')
      WHERE thread_id = ${input.threadId}
        AND revision = ${row.revision}
    `;
    const citizen = yield* requireCitizen(input.threadId);
    return {
      citizen,
      changed: true,
      threadTitle: row.preserved_title,
    } satisfies CivilizationCitizenTitleResult;
  });

  return {
    previewReassignment,
    applyReassignment,
    reclaimTitle,
    restoreTitle,
  } as const;
});

export class CivilizationAdministrationService extends Context.Service<
  CivilizationAdministrationService,
  Effect.Success<typeof make>
>()("t3/civilization/AdministrationService/CivilizationAdministrationService") {}

export const layer = Layer.effect(CivilizationAdministrationService, make);
