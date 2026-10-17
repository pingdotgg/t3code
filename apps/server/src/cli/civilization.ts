import {
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  CivilizationCensusCursor,
  CivilizationConfigConflictError,
  CivilizationConfigOverride,
  CivilizationInboxCursor,
  CivilizationMessageId,
  CivilizationNoteId,
  CivilizationNotesCursor,
  EnvironmentHttpApi,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import { FetchHttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const projectFlag = Flag.String("project").pipe(
  Flag.withDescription("Optional project id. Omit for environment-level configuration."),
  Flag.optional,
);
const requiredProjectFlag = Flag.String("project").pipe(Flag.withDescription("Owning project id."));
const threadFlag = Flag.String("thread").pipe(Flag.withDescription("Citizen thread id."));
const expectedRevisionFlag = Flag.Int("expected-revision").pipe(
  Flag.withDescription("Expected environment or project Civilization configuration revision."),
);
const fileFlag = Flag.String("file").pipe(
  Flag.withDescription("Path to a versioned Civilization configuration override JSON file."),
);
const outputFlag = Flag.String("output").pipe(
  Flag.withDescription("Optional output path. Omit to print to stdout."),
  Flag.optional,
);
const expectedCitizenRevisionFlag = Flag.Int("expected-citizen-revision").pipe(
  Flag.withDescription("Expected citizen revision."),
);
const expectedEnvironmentRevisionFlag = Flag.Int("expected-environment-revision").pipe(
  Flag.withDescription("Expected effective environment configuration revision."),
);
const expectedProjectRevisionFlag = Flag.Int("expected-project-revision").pipe(
  Flag.withDescription("Expected effective project configuration revision."),
);
const nameEntryFlag = Flag.String("name-entry").pipe(
  Flag.withDescription("Reassign to this entry in the selected name pool."),
  Flag.optional,
);
const displayNameFlag = Flag.String("name").pipe(
  Flag.withDescription("Set an explicit display name instead of selecting a pool entry."),
  Flag.optional,
);
const profileEntryFlag = Flag.String("profile-entry").pipe(
  Flag.withDescription("Reassign to this entry in the selected profile pool."),
  Flag.optional,
);
const cursorFlag = Flag.String("cursor").pipe(
  Flag.withDescription("Opaque cursor returned by the previous page."),
  Flag.optional,
);
const limitFlag = Flag.Int("limit").pipe(
  Flag.withDescription("Maximum rows requested for this page, bounded by server configuration."),
  Flag.optional,
);
const includeResolvedFlag = Flag.Boolean("include-resolved").pipe(
  Flag.withDescription("Include resolved Civilization notes."),
  Flag.withDefault(false),
);
const noteFlag = Flag.String("note").pipe(Flag.withDescription("Civilization note id."));
const messageFlag = Flag.String("message").pipe(
  Flag.withDescription("Civilization retained mail message id."),
);
const previewTokenFlag = Flag.String("preview-token").pipe(
  Flag.withDescription("Expected purge preview token returned by `t3 civilization purge preview`."),
);
const batchSizeFlag = Flag.Int("batch-size").pipe(
  Flag.withDescription("Optional bounded purge batch size (server-capped)."),
  Flag.optional,
);

const makeClient = (origin: string) => HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
type CivilizationHttpClient = Effect.Success<ReturnType<typeof makeClient>>;
const decodeOverride = Schema.decodeEffect(Schema.fromJsonString(CivilizationConfigOverride));
const isConfigConflict = Schema.is(CivilizationConfigConflictError);

export const civilizationCliErrorMessage = (cause: unknown): string =>
  isConfigConflict(cause)
    ? `Civilization ${cause.scope} configuration revision conflict: expected ${cause.expectedRevision}, current ${cause.currentRevision}.`
    : "Civilization request failed.";

const toProjectId = (value: Option.Option<string>) =>
  Option.match(value, {
    onNone: () => undefined,
    onSome: ProjectId.make,
  });

const failCli = (cause: unknown) => {
  const message = civilizationCliErrorMessage(cause);
  return Effect.fail(new CliError.UserError({ cause, userMessage: message }));
};

const failCliMessage = (message: string) =>
  Effect.fail(new CliError.UserError({ cause: message, userMessage: message }));

const withCivilizationClient = <A, E, R>(
  flags: CliAuthLocationFlags,
  run: (client: CivilizationHttpClient, token: string) => Effect.Effect<A, E, R>,
  scopes: ReadonlyArray<AuthEnvironmentScope> = AuthStandardClientScopes,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtime) || runtime.value.pid <= 0 || !isProcessAlive(runtime.value.pid)) {
      return yield* failCliMessage(
        "No running T3 Code server owns this environment. Start the server before using `t3 civilization`.",
      );
    }

    return yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const client = yield* makeClient(runtime.value.origin);
      return yield* Effect.acquireUseRelease(
        environmentAuth.issueSession({
          scopes,
          label: "t3 civilization cli",
        }),
        (issued) => run(client, issued.token),
        (issued) =>
          environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          EnvironmentAuth.layerRuntime.pipe(Layer.provide(ServerConfig.layer(config))),
          FetchHttpClient.layer,
        ),
      ),
    );
  });

const withCivilizationReadClient = <A, E, R>(
  flags: CliAuthLocationFlags,
  run: (client: CivilizationHttpClient, token: string) => Effect.Effect<A, E, R>,
) => withCivilizationClient(flags, run, [AuthOrchestrationReadScope]);

const authorization = (token: string) => ({ authorization: `Bearer ${token}` });
const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

const readOverride = Effect.fn("civilizationCli.readOverride")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path);
  return yield* decodeOverride(text).pipe(
    Effect.mapError(
      (cause) =>
        new CliError.UserError({ cause: `Invalid Civilization override in ${path}: ${cause}` }),
    ),
  );
});

const statusCommand = Command.make("status", {
  ...projectLocationFlags,
  project: projectFlag,
}).pipe(
  Command.withDescription("Show Civilization status for the environment or one project."),
  Command.withHandler((flags) =>
    withCivilizationReadClient(flags, (client, token) =>
      client.civilization
        .status({
          headers: authorization(token),
          query: { projectId: toProjectId(flags.project) },
        })
        .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
    ),
  ),
);

const capabilitiesCommand = Command.make("capabilities", {
  ...projectLocationFlags,
}).pipe(
  Command.withDescription(
    "Show the actual Civilization support level of each registered provider instance.",
  ),
  Command.withHandler((flags) =>
    withCivilizationReadClient(flags, (client, token) =>
      client.civilization
        .capabilities({ headers: authorization(token) })
        .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
    ),
  ),
);

const configDescribeCommand = Command.make("describe", { ...projectLocationFlags }).pipe(
  Command.withDescription(
    "Describe Civilization configuration inheritance, timing and hard limits.",
  ),
  Command.withHandler((flags) =>
    withCivilizationReadClient(flags, (client, token) =>
      client.civilization
        .configDescribe({ headers: authorization(token) })
        .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
    ),
  ),
);

const configGetCommand = Command.make("get", {
  ...projectLocationFlags,
  project: projectFlag,
}).pipe(
  Command.withDescription("Read effective Civilization configuration, revisions and provenance."),
  Command.withHandler((flags) =>
    withCivilizationReadClient(flags, (client, token) =>
      client.civilization
        .configGet({
          headers: authorization(token),
          query: { projectId: toProjectId(flags.project) },
        })
        .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
    ),
  ),
);

const withOverrideFile = <A, E, R>(
  path: string,
  run: (override: typeof CivilizationConfigOverride.Type) => Effect.Effect<A, E, R>,
) => readOverride(path).pipe(Effect.flatMap(run));

const configValidateCommand = Command.make("validate", {
  ...projectLocationFlags,
  project: projectFlag,
  file: fileFlag,
}).pipe(
  Command.withDescription("Validate a Civilization override without committing it."),
  Command.withHandler((flags) =>
    withOverrideFile(flags.file, (override) =>
      withCivilizationReadClient(flags, (client, token) =>
        client.civilization
          .configValidate({
            headers: authorization(token),
            payload: { projectId: toProjectId(flags.project), override },
          })
          .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
      ),
    ),
  ),
);

const configDiffCommand = Command.make("diff", {
  ...projectLocationFlags,
  project: projectFlag,
  file: fileFlag,
}).pipe(
  Command.withDescription("Diff a Civilization override against current effective configuration."),
  Command.withHandler((flags) =>
    withOverrideFile(flags.file, (override) =>
      withCivilizationReadClient(flags, (client, token) =>
        client.civilization
          .configDiff({
            headers: authorization(token),
            payload: { projectId: toProjectId(flags.project), override },
          })
          .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
      ),
    ),
  ),
);

const configSetCommand = Command.make("set", {
  ...projectLocationFlags,
  project: projectFlag,
  file: fileFlag,
  expectedRevision: expectedRevisionFlag,
}).pipe(
  Command.withDescription("Commit a Civilization override at an expected revision."),
  Command.withHandler((flags) =>
    withOverrideFile(flags.file, (override) =>
      withCivilizationClient(flags, (client, token) =>
        client.civilization
          .configSet({
            headers: authorization(token),
            payload: {
              projectId: toProjectId(flags.project),
              expectedRevision: flags.expectedRevision,
              override,
            },
          })
          .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
      ),
    ),
  ),
);

const configResetCommand = Command.make("reset", {
  ...projectLocationFlags,
  project: projectFlag,
  expectedRevision: expectedRevisionFlag,
}).pipe(
  Command.withDescription("Remove a Civilization override at an expected revision."),
  Command.withHandler((flags) =>
    withCivilizationClient(flags, (client, token) =>
      client.civilization
        .configReset({
          headers: authorization(token),
          payload: {
            projectId: toProjectId(flags.project),
            expectedRevision: flags.expectedRevision,
          },
        })
        .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
    ),
  ),
);

const configImportCommand = Command.make("import", {
  ...projectLocationFlags,
  project: projectFlag,
  file: fileFlag,
  expectedRevision: expectedRevisionFlag,
}).pipe(
  Command.withDescription("Import and commit a versioned Civilization override JSON document."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const json = yield* fs.readFileString(flags.file);
      return yield* withCivilizationClient(flags, (client, token) =>
        client.civilization
          .configImport({
            headers: authorization(token),
            payload: {
              projectId: toProjectId(flags.project),
              expectedRevision: flags.expectedRevision,
              json,
            },
          })
          .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
      );
    }),
  ),
);

const configExportCommand = Command.make("export", {
  ...projectLocationFlags,
  project: projectFlag,
  output: outputFlag,
}).pipe(
  Command.withDescription("Export the stored Civilization override through the running server."),
  Command.withHandler((flags) =>
    withCivilizationReadClient(flags, (client, token) =>
      client.civilization
        .configExport({
          headers: authorization(token),
          query: { projectId: toProjectId(flags.project) },
        })
        .pipe(
          Effect.flatMap((result) =>
            Option.match(flags.output, {
              onNone: () => printJson(result),
              onSome: (path) =>
                FileSystem.FileSystem.pipe(
                  Effect.flatMap((fs) => fs.writeFileString(path, result.json)),
                  Effect.andThen(printJson({ output: path, effective: result.effective })),
                ),
            }),
          ),
          Effect.catch(failCli),
        ),
    ),
  ),
);

const configCommand = Command.make("config").pipe(
  Command.withDescription("Inspect and edit Civilization configuration."),
  Command.withSubcommands([
    configDescribeCommand,
    configGetCommand,
    configValidateCommand,
    configDiffCommand,
    configSetCommand,
    configResetCommand,
    configImportCommand,
    configExportCommand,
  ]),
);

const citizenReassignmentFlags = {
  ...projectLocationFlags,
  project: requiredProjectFlag,
  thread: threadFlag,
  expectedCitizenRevision: expectedCitizenRevisionFlag,
  expectedEnvironmentRevision: expectedEnvironmentRevisionFlag,
  expectedProjectRevision: expectedProjectRevisionFlag,
  nameEntry: nameEntryFlag,
  name: displayNameFlag,
  profileEntry: profileEntryFlag,
} as const;

const reassignmentPayload = (flags: {
  readonly project: string;
  readonly thread: string;
  readonly expectedCitizenRevision: number;
  readonly expectedEnvironmentRevision: number;
  readonly expectedProjectRevision: number;
  readonly nameEntry: Option.Option<string>;
  readonly name: Option.Option<string>;
  readonly profileEntry: Option.Option<string>;
}) => ({
  projectId: ProjectId.make(flags.project),
  threadId: ThreadId.make(flags.thread),
  expectedCitizenRevision: flags.expectedCitizenRevision,
  expectedEnvironmentRevision: flags.expectedEnvironmentRevision,
  expectedProjectRevision: flags.expectedProjectRevision,
  ...(Option.isSome(flags.nameEntry) ? { nameEntryId: flags.nameEntry.value } : {}),
  ...(Option.isSome(flags.name) ? { displayName: flags.name.value } : {}),
  ...(Option.isSome(flags.profileEntry) ? { profileEntryId: flags.profileEntry.value } : {}),
});

const citizenReassignPreviewCommand = Command.make("preview", citizenReassignmentFlags).pipe(
  Command.withDescription("Preview a bounded citizen name/profile reassignment."),
  Command.withHandler((flags) =>
    withCivilizationClient(flags, (client, token) =>
      client.civilization
        .citizenReassignmentPreview({
          headers: authorization(token),
          payload: reassignmentPayload(flags),
        })
        .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
    ),
  ),
);

const citizenReassignApplyCommand = Command.make("apply", citizenReassignmentFlags).pipe(
  Command.withDescription(
    "Apply a previewed citizen name/profile reassignment at expected revisions.",
  ),
  Command.withHandler((flags) =>
    withCivilizationClient(flags, (client, token) =>
      client.civilization
        .citizenReassignmentApply({
          headers: authorization(token),
          payload: reassignmentPayload(flags),
        })
        .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
    ),
  ),
);

const citizenReassignCommand = Command.make("reassign").pipe(
  Command.withDescription("Preview or apply explicit citizen identity changes."),
  Command.withSubcommands([citizenReassignPreviewCommand, citizenReassignApplyCommand]),
);

const citizenTitleFlags = {
  ...projectLocationFlags,
  project: requiredProjectFlag,
  thread: threadFlag,
  expectedCitizenRevision: expectedCitizenRevisionFlag,
} as const;

const titlePayload = (flags: {
  readonly project: string;
  readonly thread: string;
  readonly expectedCitizenRevision: number;
}) => ({
  projectId: ProjectId.make(flags.project),
  threadId: ThreadId.make(flags.thread),
  expectedCitizenRevision: flags.expectedCitizenRevision,
});

const citizenTitleRestoreCommand = Command.make("restore", citizenTitleFlags).pipe(
  Command.withDescription(
    "Restore the preserved pre-Civilization title when it is still safe to do so.",
  ),
  Command.withHandler((flags) =>
    withCivilizationClient(flags, (client, token) =>
      client.civilization
        .citizenTitleRestore({
          headers: authorization(token),
          payload: titlePayload(flags),
        })
        .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
    ),
  ),
);

const citizenTitleReclaimCommand = Command.make("reclaim", citizenTitleFlags).pipe(
  Command.withDescription("Reclaim Civilization ownership of future automatic title generation."),
  Command.withHandler((flags) =>
    withCivilizationClient(flags, (client, token) =>
      client.civilization
        .citizenTitleReclaim({
          headers: authorization(token),
          payload: titlePayload(flags),
        })
        .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
    ),
  ),
);

const citizenTitleCommand = Command.make("title").pipe(
  Command.withDescription("Restore or reclaim Civilization-managed title ownership."),
  Command.withSubcommands([citizenTitleRestoreCommand, citizenTitleReclaimCommand]),
);

const citizenCommand = Command.make("citizen").pipe(
  Command.withDescription("Administer durable Civilization citizen identity and title ownership."),
  Command.withSubcommands([citizenReassignCommand, citizenTitleCommand]),
);

const censusCommand = Command.make("census", {
  ...projectLocationFlags,
  project: requiredProjectFlag,
  cursor: cursorFlag,
  limit: limitFlag,
}).pipe(
  Command.withDescription("Inspect one bounded page of the project Civilization census."),
  Command.withHandler((flags) =>
    withCivilizationReadClient(flags, (client, token) =>
      client.civilization
        .census({
          headers: authorization(token),
          query: {
            projectId: ProjectId.make(flags.project),
            ...(Option.isSome(flags.cursor)
              ? { cursor: CivilizationCensusCursor.make(flags.cursor.value) }
              : {}),
            ...(Option.isSome(flags.limit) ? { limit: String(flags.limit.value) } : {}),
          },
        })
        .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
    ),
  ),
);

const noteListCommand = Command.make("list", {
  ...projectLocationFlags,
  project: requiredProjectFlag,
  cursor: cursorFlag,
  limit: limitFlag,
  includeResolved: includeResolvedFlag,
}).pipe(
  Command.withDescription("List bounded Civilization note metadata for a project."),
  Command.withHandler((flags) =>
    withCivilizationReadClient(flags, (client, token) =>
      client.civilization
        .noteList({
          headers: authorization(token),
          query: {
            projectId: ProjectId.make(flags.project),
            includeResolved: flags.includeResolved ? "true" : "false",
            ...(Option.isSome(flags.cursor)
              ? { cursor: CivilizationNotesCursor.make(flags.cursor.value) }
              : {}),
            ...(Option.isSome(flags.limit) ? { limit: String(flags.limit.value) } : {}),
          },
        })
        .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
    ),
  ),
);

const noteReadCommand = Command.make("read", {
  ...projectLocationFlags,
  project: requiredProjectFlag,
  note: noteFlag,
}).pipe(
  Command.withDescription(
    "Read one retained Civilization note body for administrative inspection.",
  ),
  Command.withHandler((flags) =>
    withCivilizationClient(flags, (client, token) =>
      client.civilization
        .noteRead({
          headers: authorization(token),
          params: { noteId: CivilizationNoteId.make(flags.note) },
          query: { projectId: ProjectId.make(flags.project) },
        })
        .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
    ),
  ),
);

const noteCommand = Command.make("note").pipe(
  Command.withDescription(
    "Inspect shared Civilization notes through the running environment server.",
  ),
  Command.withSubcommands([noteListCommand, noteReadCommand]),
);

const inboxListCommand = Command.make("list", {
  ...projectLocationFlags,
  project: requiredProjectFlag,
  cursor: cursorFlag,
  limit: limitFlag,
}).pipe(
  Command.withDescription(
    "List retained Civilization mail metadata for administrative inspection.",
  ),
  Command.withHandler((flags) =>
    withCivilizationClient(flags, (client, token) =>
      client.civilization
        .inboxList({
          headers: authorization(token),
          query: {
            projectId: ProjectId.make(flags.project),
            ...(Option.isSome(flags.cursor)
              ? { cursor: CivilizationInboxCursor.make(flags.cursor.value) }
              : {}),
            ...(Option.isSome(flags.limit) ? { limit: String(flags.limit.value) } : {}),
          },
        })
        .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
    ),
  ),
);

const inboxReadCommand = Command.make("read", {
  ...projectLocationFlags,
  project: requiredProjectFlag,
  message: messageFlag,
}).pipe(
  Command.withDescription(
    "Read one retained Civilization mail body for administrative inspection.",
  ),
  Command.withHandler((flags) =>
    withCivilizationClient(flags, (client, token) =>
      client.civilization
        .inboxRead({
          headers: authorization(token),
          params: { messageId: CivilizationMessageId.make(flags.message) },
          query: { projectId: ProjectId.make(flags.project) },
        })
        .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
    ),
  ),
);

const inboxCommand = Command.make("inbox").pipe(
  Command.withDescription(
    "Inspect retained Civilization mail through the running environment server.",
  ),
  Command.withSubcommands([inboxListCommand, inboxReadCommand]),
);

const dataExportCommand = Command.make("export", {
  ...projectLocationFlags,
  project: requiredProjectFlag,
  output: outputFlag,
}).pipe(
  Command.withDescription(
    "Export a credential-free, inspection-only Civilization project backup through the running server.",
  ),
  Command.withHandler((flags) =>
    withCivilizationClient(flags, (client, token) =>
      client.civilization
        .dataExport({
          headers: authorization(token),
          query: { projectId: ProjectId.make(flags.project) },
        })
        .pipe(
          Effect.flatMap((result) =>
            Option.match(flags.output, {
              onNone: () => printJson(result),
              onSome: (path) =>
                FileSystem.FileSystem.pipe(
                  Effect.flatMap((fs) => fs.writeFileString(path, JSON.stringify(result, null, 2))),
                  Effect.andThen(printJson({ output: path, projectId: result.projectId })),
                ),
            }),
          ),
          Effect.catch(failCli),
        ),
    ),
  ),
);

const purgePreviewCommand = Command.make("preview", {
  ...projectLocationFlags,
  project: requiredProjectFlag,
}).pipe(
  Command.withDescription(
    "Preview exact Civilization feature rows/body bytes before a project purge.",
  ),
  Command.withHandler((flags) =>
    withCivilizationClient(flags, (client, token) =>
      client.civilization
        .purgePreview({
          headers: authorization(token),
          query: { projectId: ProjectId.make(flags.project) },
        })
        .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
    ),
  ),
);

const purgeApplyCommand = Command.make("apply", {
  ...projectLocationFlags,
  project: requiredProjectFlag,
  previewToken: previewTokenFlag,
  batchSize: batchSizeFlag,
}).pipe(
  Command.withDescription(
    "Apply or resume a bounded Civilization purge using the exact approved preview token.",
  ),
  Command.withHandler((flags) =>
    withCivilizationClient(flags, (client, token) =>
      client.civilization
        .purgeApply({
          headers: authorization(token),
          payload: {
            projectId: ProjectId.make(flags.project),
            expectedPreviewToken: flags.previewToken,
            ...(Option.isSome(flags.batchSize) ? { batchSize: flags.batchSize.value } : {}),
          },
        })
        .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
    ),
  ),
);

const purgeCommand = Command.make("purge").pipe(
  Command.withDescription("Preview and apply bounded deletion of Civilization-owned project data."),
  Command.withSubcommands([purgePreviewCommand, purgeApplyCommand]),
);

const retentionGetCommand = Command.make("get", {
  ...projectLocationFlags,
  project: requiredProjectFlag,
}).pipe(
  Command.withDescription("Inspect the currently applied Civilization retention horizons."),
  Command.withHandler((flags) =>
    withCivilizationClient(flags, (client, token) =>
      client.civilization
        .retentionGet({
          headers: authorization(token),
          query: { projectId: ProjectId.make(flags.project) },
        })
        .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
    ),
  ),
);

const retentionPreviewCommand = Command.make("preview", {
  ...projectLocationFlags,
  project: requiredProjectFlag,
}).pipe(
  Command.withDescription("Preview data newly eligible under a configured retention reduction."),
  Command.withHandler((flags) =>
    withCivilizationClient(flags, (client, token) =>
      client.civilization
        .retentionPreview({
          headers: authorization(token),
          query: { projectId: ProjectId.make(flags.project) },
        })
        .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
    ),
  ),
);

const retentionApplyCommand = Command.make("apply", {
  ...projectLocationFlags,
  project: requiredProjectFlag,
  previewToken: previewTokenFlag,
}).pipe(
  Command.withDescription("Apply an approved retention reduction using its exact preview token."),
  Command.withHandler((flags) =>
    withCivilizationClient(flags, (client, token) =>
      client.civilization
        .retentionApply({
          headers: authorization(token),
          payload: {
            projectId: ProjectId.make(flags.project),
            expectedPreviewToken: flags.previewToken,
          },
        })
        .pipe(Effect.flatMap(printJson), Effect.catch(failCli)),
    ),
  ),
);

const retentionCommand = Command.make("retention").pipe(
  Command.withDescription("Inspect, preview, and apply Civilization retention policy changes."),
  Command.withSubcommands([retentionGetCommand, retentionPreviewCommand, retentionApplyCommand]),
);

export const civilizationCommand = Command.make("civilization").pipe(
  Command.withDescription("Administer the optional T3 Civilization backend."),
  Command.withSubcommands([
    statusCommand,
    capabilitiesCommand,
    configCommand,
    censusCommand,
    noteCommand,
    inboxCommand,
    citizenCommand,
    dataExportCommand,
    purgeCommand,
    retentionCommand,
  ]),
);
