import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveProjectIconModelSelection } from "@t3tools/shared/serverSettings";
import {
  CommandId,
  EventId,
  type ProjectId,
  type ProjectIconColor,
  type ProjectIconOverride,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as EventSink from "./EventSink.ts";
import { planProjectCommand } from "./ProjectCommands.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

export class ProjectIconAutofillService extends Context.Service<
  ProjectIconAutofillService,
  {
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly commandId: CommandId;
      readonly projectId: ProjectId;
    }) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ProjectIconAutofillService") {}

const EXCERPT_CHARS = 2000;
const MAX_TOP_LEVEL_ENTRIES = 60;
const IGNORED_TOP_LEVEL_ENTRIES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".t3",
  ".DS_Store",
]);

const readTextFile = (
  fileSystem: FileSystem.FileSystem,
  path: string,
): Effect.Effect<string | undefined, never, never> =>
  fileSystem.readFileString(path, "utf8").pipe(
    Effect.orElseSucceed(() => null),
    Effect.map((content) => {
      if (content === null) return undefined;
      const trimmed = content.trim().slice(0, EXCERPT_CHARS);
      return trimmed.length === 0 ? undefined : trimmed;
    }),
  );

const readTopLevelEntries = (
  fileSystem: FileSystem.FileSystem,
  workspaceRoot: string,
): Effect.Effect<ReadonlyArray<string>, never, never> =>
  fileSystem.readDirectory(workspaceRoot).pipe(
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
    Effect.map((entries) =>
      entries
        .filter((entry) => !IGNORED_TOP_LEVEL_ENTRIES.has(entry))
        .slice(0, MAX_TOP_LEVEL_ENTRIES),
    ),
  );

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Scratch ("No project") is bootstrapped at <baseDir>/scratch with its icon already
  // set. ManagedProjectFolders would pull the VCS stack into every composing layer, so
  // this mirrors its path comparison directly (title is only "No project" at creation).
  const isScratchProject = (row: {
    readonly title: string;
    readonly workspaceRoot: string;
  }): boolean =>
    row.title === "No project" &&
    path.resolve(row.workspaceRoot) === path.resolve(serverConfig.baseDir, "scratch");

  // ProjectService would pull VCS/workspace-path services into every composing layer;
  // an icon-only update skips its normalization anyway, so this commits straight through
  // the sink (its receipt guard on `${commandId}:project-icon` replays retries safely).
  const writeIcon = Effect.fn("ProjectIconAutofillService.writeIcon")(function* (
    input: { readonly commandId: CommandId; readonly projectId: ProjectId },
    projectIcon: ProjectIconOverride,
  ) {
    const now = yield* DateTime.now;
    const command = {
      type: "project.meta.update" as const,
      commandId: CommandId.make(`${input.commandId}:project-icon`),
      projectId: input.projectId,
      projectIcon,
    };
    const project = Option.getOrUndefined(
      yield* projects
        .get(input.projectId, { includeDeleted: true })
        .pipe(Effect.orElseSucceed(() => Option.none())),
    );
    const planned = planProjectCommand({
      command,
      state: { project, workspaceOwner: undefined },
      eventId: EventId.make(yield* idAllocator.allocate.event({ commandId: command.commandId })),
      now,
    });
    if (Result.isFailure(planned)) return;
    yield* eventSink.commitProjectCommand({
      commandId: command.commandId,
      projectId: command.projectId,
      commandType: command.type,
      acceptedAt: now,
      event: planned.success,
    });
  });

  const run = Effect.fn("ProjectIconAutofillService.execute")(function* (input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
  }) {
    const settings = resolveProjectSettings(yield* serverSettings.getSettings, input.projectId);
    if (settings.settings.projectIconAutoFillEnabled !== true) return;

    const project = yield* projects.get(input.projectId);
    if (Option.isNone(project)) return;
    const row = project.value;
    // Never overwrite a user-set icon; the favicon counts as an icon too.
    if (row.faviconPath !== null || row.projectIcon !== null) return;
    if (isScratchProject(row)) return;

    const shells = yield* threads.listProjectThreads({
      projectId: input.projectId,
      includeSubagents: false,
    });
    const threadTitles = shells
      .map((shell) => shell.title.trim())
      .filter((title) => title.length > 0 && title !== "New thread")
      .slice(0, 3);
    const topLevelEntries = yield* readTopLevelEntries(fileSystem, row.workspaceRoot);
    const readmeExcerpt =
      (yield* readTextFile(fileSystem, `${row.workspaceRoot}/README.md`)) ??
      (yield* readTextFile(fileSystem, `${row.workspaceRoot}/readme.md`));
    const packageJsonExcerpt = yield* readTextFile(fileSystem, `${row.workspaceRoot}/package.json`);
    const result = yield* textGeneration.generateProjectIcon({
      cwd: row.workspaceRoot,
      projectTitle: row.title,
      threadTitles,
      topLevelEntries,
      ...(readmeExcerpt === undefined ? {} : { readmeExcerpt }),
      ...(packageJsonExcerpt === undefined ? {} : { packageJsonExcerpt }),
      // Passing no providers keeps the service dependency-free (like thread titles):
      // a usable override is honored, otherwise textGenerationModelSelection wins, and
      // TextGeneration.generate still falls back at call time when the instance is down.
      modelSelection: resolveProjectIconModelSelection(
        settings.settings,
        undefined,
        input.projectId,
      ),
    });
    // The user may have picked an icon while the model was thinking; re-check before writing.
    const fresh = yield* projects.get(input.projectId);
    if (Option.isNone(fresh)) return;
    if (fresh.value.faviconPath !== null || fresh.value.projectIcon !== null) return;
    const projectIcon: ProjectIconOverride = {
      kind: "lucide",
      name: result.name,
      color: result.color as ProjectIconColor,
    };
    yield* writeIcon(input, projectIcon).pipe(Effect.orElseSucceed(() => undefined));
  });

  const execute: ProjectIconAutofillService["Service"]["execute"] = (input) =>
    run(input).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Project icon autofill failed", {
          projectId: input.projectId,
          threadId: input.threadId,
          cause,
        }),
      ),
    );

  return ProjectIconAutofillService.of({ execute });
});

export const layer = Layer.effect(ProjectIconAutofillService, make);
