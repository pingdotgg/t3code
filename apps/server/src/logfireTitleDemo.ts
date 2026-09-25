import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "./config.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "./serverSettings.ts";

const Corpus = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    previous_title: Schema.String,
    baseline_title: Schema.optionalKey(Schema.String),
    messages: Schema.Array(
      Schema.Struct({
        role: Schema.Literals(["user", "assistant"]),
        text: Schema.String,
      }),
    ).check(Schema.isNonEmpty()),
  }),
);

const decodeCorpus = Schema.decodeEffect(Schema.fromJsonString(Corpus));
class TitleDemoSeedError extends Schema.TaggedError<TitleDemoSeedError>()("TitleDemoSeedError", {
  message: Schema.String,
}) {}

/** Opt-in fixtures for the demo branch; imports never run a provider turn. */
export const seedLogfireTitleDemo = Effect.fnUntraced(function* (corpusPath: string) {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const workspaceRoot = path.resolve(path.dirname(corpusPath), "../..");
  // The launcher always uses checkout-local isolated state, even in a main checkout.
  if (path.resolve(config.baseDir) !== path.join(workspaceRoot, ".t3")) {
    return yield* Effect.fail(
      new TitleDemoSeedError({ message: "The title demo requires --home-dir <checkout>/.t3" }),
    );
  }
  const fs = yield* FileSystem.FileSystem;
  const canonicalCwd = yield* fs.realPath(workspaceRoot);
  const canonicalBase = yield* fs.realPath(config.baseDir);
  if (canonicalBase !== path.join(canonicalCwd, ".t3") || config.autoBootstrapProjectFromCwd) {
    return yield* Effect.fail(
      new TitleDemoSeedError({
        message: "The title demo requires an unsymlinked .t3 and auto-bootstrap disabled",
      }),
    );
  }
  for (const target of [config.stateDir, config.dbPath, config.settingsPath]) {
    const relative = path.relative(config.baseDir, target);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      ((yield* fs.exists(target)) &&
        (yield* fs.realPath(target)) !== path.join(canonicalBase, relative))
    ) {
      return yield* Effect.fail(
        new TitleDemoSeedError({
          message: "The title demo state must stay inside the isolated .t3 directory",
        }),
      );
    }
  }
  const corpus = yield* decodeCorpus(yield* fs.readFileString(corpusPath));
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const projectId = ProjectId.make("logfire-title-demo");
  const createdAt = "2026-09-24T12:00:00.000Z";
  const snapshot = yield* query.getShellSnapshot();
  if (!snapshot.projects.some((project) => project.id === projectId)) {
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("logfire-title-demo:project"),
      projectId,
      title: "Title generation demo",
      workspaceRoot,
      createdAt,
    });
  }
  const settings = yield* settingsService.getSettings;
  yield* settingsService.updateSettings({
    projectSettingsOverrides: {
      ...settings.projectSettingsOverrides,
      [projectId]: {
        ...settings.projectSettingsOverrides[projectId],
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-6-luna",
          options: [{ id: "reasoningEffort", value: "low" }],
        },
      },
    },
  });
  for (const item of corpus) {
    const threadId = ThreadId.make(`logfire-title-${item.id}`);
    const existing = yield* query.getThreadDetailById(threadId);
    if (Option.isSome(existing) && existing.value.projectId !== projectId) {
      return yield* Effect.fail(
        new TitleDemoSeedError({
          message: `Demo thread id is already used by another project: ${threadId}`,
        }),
      );
    }
    if (Option.isNone(existing)) {
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId,
        title: item.baseline_title ?? item.previous_title,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
        historyImport: true,
      });
    }
    if (Option.isNone(existing) || existing.value.messages.length === 0) {
      yield* engine.dispatch({
        type: "thread.history.import",
        commandId: CommandId.make(`${threadId}:history`),
        threadId,
        messages: item.messages.map((message, index) => ({
          ...message,
          messageId: MessageId.make(`${threadId}:${index}`),
          createdAt: DateTime.formatIso(
            DateTime.add(DateTime.makeUnsafe(createdAt), { minutes: index }),
          ),
        })),
      });
      yield* engine.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make(`${threadId}:show`),
        threadId,
        reason: "user",
      });
    }
  }
});
