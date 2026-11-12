import {
  MAX_THREAD_FOLDERS,
  StoredProjectIcon,
  type OrchestrationV2ThreadShell,
  type ThreadFolder,
  ThreadFolderError,
  ThreadFolderRule,
  type ThreadFolderId,
  type ThreadFolderListResult,
  type ThreadFolderMutation,
  type ThreadFolderMutationResult,
  type ThreadId,
} from "@t3tools/contracts";
import {
  inferThreadFolderRule,
  threadFolderIcon,
  pickThreadFolderForRule,
  threadFolderRuleHasConditions,
  threadMatchesFolderRule,
  threadNamesFolder,
} from "@t3tools/shared/threadFolderRule";
import { visibleThreadPullRequests } from "../sourceControl/threadPullRequests.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

export class ThreadFolderService extends Context.Service<
  ThreadFolderService,
  {
    readonly autoFile: (threadId: ThreadId) => Effect.Effect<void, ThreadFolderError>;
    readonly list: () => Effect.Effect<ThreadFolderListResult, ThreadFolderError>;
    readonly subscribeList: () => Stream.Stream<ThreadFolderListResult, ThreadFolderError>;
    /** `inferRules: false` keeps a folder's name from turning on a rule, for callers that may not set one. */
    readonly mutate: (
      mutation: ThreadFolderMutation,
      options?: { readonly inferRules?: boolean },
    ) => Effect.Effect<ThreadFolderMutationResult, ThreadFolderError>;
    readonly smartCandidates: (
      threadId: ThreadId,
    ) => Effect.Effect<
      ReadonlyArray<{ id: ThreadFolderId; name: string; examples: ReadonlyArray<string> }>,
      ThreadFolderError
    >;
    readonly applySmartPick: (
      threadId: ThreadId,
      folderId: string,
    ) => Effect.Effect<void, ThreadFolderError>;
  }
>()("t3/threadFolders/ThreadFolderService") {}

interface FolderRow {
  readonly folder_id: ThreadFolderId;
  readonly name: string;
  readonly icon_json: string | null;
  readonly rule_json: string | null;
  readonly auto_file: number;
  readonly rule_set_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface MemberRow {
  readonly thread_id: ThreadId;
  readonly folder_id: ThreadFolderId;
}

const decodeRule = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadFolderRule));
const encodeRule = Schema.encodeSync(Schema.fromJsonString(ThreadFolderRule));

const decodeIcon = Schema.decodeUnknownOption(Schema.fromJsonString(StoredProjectIcon));
const encodeIcon = Schema.encodeSync(Schema.fromJsonString(StoredProjectIcon));

const MAX_FOLDER_EXAMPLES = 5;

const folderError = (message: string, options?: { folderId?: ThreadFolderId; cause?: unknown }) =>
  new ThreadFolderError({
    message,
    ...(options?.folderId === undefined ? {} : { folderId: options.folderId }),
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const textGeneration = yield* TextGeneration.TextGeneration;
  // Notifications re-emit the full list; slow subscribers need only the newest dirty signal.
  const changes = yield* PubSub.sliding<void>(1);
  const writes = yield* Semaphore.make(1);

  const readFolders = Effect.gen(function* () {
    const rows = yield* sql<FolderRow>`
      SELECT folder_id, name, icon_json, rule_json, auto_file, rule_set_at, created_at, updated_at
      FROM thread_folders
      ORDER BY sort_key ASC, created_at ASC, rowid ASC
    `;
    const members = yield* sql<MemberRow>`
      SELECT members.thread_id, members.folder_id
      FROM thread_folder_members AS members
      JOIN orchestration_v2_projection_threads AS threads
        ON threads.thread_id = members.thread_id AND threads.deleted_at IS NULL
      ORDER BY members.added_at ASC, members.rowid ASC
    `;
    const threadIdsByFolder = new Map<ThreadFolderId, Array<ThreadId>>();
    for (const member of members) {
      const list = threadIdsByFolder.get(member.folder_id) ?? [];
      list.push(member.thread_id);
      threadIdsByFolder.set(member.folder_id, list);
    }
    return rows.map((row): ThreadFolder => ({
      id: row.folder_id,
      name: row.name,
      icon: row.icon_json === null ? null : Option.getOrNull(decodeIcon(row.icon_json)),
      rule: row.rule_json === null ? null : Option.getOrNull(decodeRule(row.rule_json)),
      autoFile: row.auto_file !== 0,
      ruleSetAt: row.rule_set_at,
      threadIds: threadIdsByFolder.get(row.folder_id) ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  });

  const list: ThreadFolderService["Service"]["list"] = () =>
    readFolders.pipe(
      NodeSqliteClient.readOnly,
      Effect.map((folders) => ({ folders })),
      Effect.mapError((cause) => folderError("Could not list thread folders.", { cause })),
    );

  const subscribeList: ThreadFolderService["Service"]["subscribeList"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading to buffer concurrent changes.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(list()),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
        );
      }),
    );

  const requireLiveThreads = Effect.fn("ThreadFolderService.requireLiveThreads")(function* (
    threadIds: ReadonlyArray<ThreadId>,
  ) {
    for (const threadId of new Set(threadIds)) {
      const shell = yield* threads
        .getThreadShell(threadId)
        .pipe(
          Effect.mapError((cause) => folderError(`Could not read thread ${threadId}.`, { cause })),
        );
      if (shell === null || shell.deletedAt !== null) {
        return yield* folderError(`Thread ${threadId} does not exist.`);
      }
    }
  });

  const requireFolder = Effect.fn("ThreadFolderService.requireFolder")(function* (
    folderId: ThreadFolderId,
  ) {
    const rows = yield* sql<{ readonly folder_id: string }>`
      SELECT folder_id FROM thread_folders WHERE folder_id = ${folderId}
    `;
    if (rows.length === 0) {
      return yield* folderError(`Folder ${folderId} does not exist.`, { folderId });
    }
  });

  const placeThreads = Effect.fn("ThreadFolderService.placeThreads")(function* (
    threadIds: ReadonlyArray<ThreadId>,
    folderId: ThreadFolderId | null,
    now: string,
    explicit = true,
  ) {
    if (explicit) {
      yield* Effect.forEach(
        new Set(threadIds),
        (threadId) =>
          sql`INSERT OR IGNORE INTO thread_folder_explicit_moves (thread_id) VALUES (${threadId})`,
        { discard: true },
      );
    }
    yield* Effect.forEach(
      new Set(threadIds),
      (threadId) =>
        folderId === null
          ? sql`DELETE FROM thread_folder_members WHERE thread_id = ${threadId}`
          : sql`
              INSERT INTO thread_folder_members (thread_id, folder_id, added_at)
              VALUES (${threadId}, ${folderId}, ${now})
              ON CONFLICT (thread_id) DO UPDATE SET
                folder_id = excluded.folder_id,
                added_at = excluded.added_at
              WHERE thread_folder_members.folder_id <> excluded.folder_id
            `,
      { discard: true },
    );
  });

  const subjectOf = (shell: OrchestrationV2ThreadShell) => ({
    ...shell,
    hasPullRequest: visibleThreadPullRequests(shell.pullRequests ?? []).length > 0,
  });

  // The conditions every thread must meet; topic, branches, and worktrees each add threads.
  const matchesSmartConditions = (rule: ThreadFolderRule, shell: OrchestrationV2ThreadShell) => {
    const { smart: _smart, branches: _branches, worktrees: _worktrees, ...conditions } = rule;
    return (
      !threadFolderRuleHasConditions(conditions) ||
      threadMatchesFolderRule(conditions, subjectOf(shell))
    );
  };

  // Titles of threads people filed by hand teach the model what a folder means.
  const handFiledExamples = Effect.fn("ThreadFolderService.handFiledExamples")(function* (
    folderId: ThreadFolderId,
  ) {
    const rows = yield* sql<{ readonly title: string }>`
      SELECT threads.title FROM thread_folder_members AS members
      JOIN thread_folder_explicit_moves AS moves ON moves.thread_id = members.thread_id
      JOIN orchestration_v2_projection_threads AS threads
        ON threads.thread_id = members.thread_id AND threads.deleted_at IS NULL
      WHERE members.folder_id = ${folderId}
      ORDER BY members.added_at DESC
      LIMIT ${MAX_FOLDER_EXAMPLES}
    `;
    return rows.map((row) => row.title);
  });

  const relatedRule = Effect.fn("ThreadFolderService.relatedRule")(function* (
    folder: ThreadFolder,
  ) {
    if (folder.rule !== null) return folder.rule;
    const members = yield* Effect.forEach(folder.threadIds, (threadId) =>
      threads
        .getThreadShell(threadId)
        .pipe(
          Effect.mapError((cause) => folderError(`Could not read thread ${threadId}.`, { cause })),
        ),
    );
    return (
      inferThreadFolderRule(
        folder.name,
        members.filter((shell) => shell !== null),
      ) ?? { smart: true }
    );
  });

  const adoptNamedRule = Effect.fn("ThreadFolderService.adoptNamedRule")(function* (
    folderId: ThreadFolderId,
    now: string,
  ) {
    const folder = (yield* readFolders).find((entry) => entry.id === folderId);
    if (folder === undefined || folder.rule !== null) return;
    const rule = yield* relatedRule(folder);
    if (rule.smart) return;
    yield* sql`
      UPDATE thread_folders
      SET rule_json = ${encodeRule(rule)}, auto_file = 1, rule_set_at = ${now}, updated_at = ${now}
      WHERE folder_id = ${folderId}
    `;
  });

  // Someone asked for these, so threads once moved by hand count too.
  const batchCandidates = Effect.fn("ThreadFolderService.batchCandidates")(function* (
    rule: ThreadFolderRule,
  ) {
    const folders = yield* readFolders;
    const excluded = new Set(folders.flatMap((entry) => entry.threadIds));
    const snapshot = yield* threads
      .getShellSnapshot({ location: "active" })
      .pipe(Effect.mapError((cause) => folderError("Could not read threads.", { cause })));
    return snapshot.threads.filter(
      (shell) =>
        !excluded.has(shell.id) &&
        shell.deletedAt === null &&
        shell.archivedAt === null &&
        shell.settledOverride !== "settled" &&
        shell.lineage.relationshipToParent !== "subagent" &&
        matchesSmartConditions(rule, shell),
    );
  });

  const apply = Effect.fn("ThreadFolderService.apply")(function* (
    mutation: ThreadFolderMutation,
    now: string,
    smart?: {
      readonly matches: ReadonlySet<string>;
      readonly folder: Pick<ThreadFolder, "name" | "ruleSetAt">;
    },
    inferRules = true,
  ) {
    const adopt = (folderId: ThreadFolderId) =>
      inferRules ? adoptNamedRule(folderId, now) : Effect.void;
    switch (mutation.type) {
      case "folder.create": {
        // Retrying a create with the same id is a no-op, so client retries are safe.
        const replayed = yield* sql`
          SELECT 1 FROM thread_folders WHERE folder_id = ${mutation.folderId}
        `;
        if (replayed.length > 0) return;
        const existing = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM thread_folders
        `;
        if ((existing[0]?.count ?? 0) >= MAX_THREAD_FOLDERS) {
          return yield* folderError(
            `An environment can have at most ${MAX_THREAD_FOLDERS} folders.`,
          );
        }
        const rule = mutation.rule ?? null;
        if (rule !== null && !threadFolderRuleHasConditions(rule)) {
          return yield* folderError("A folder rule needs at least one condition.");
        }
        if (mutation.autoFile === true && rule === null) {
          return yield* folderError("Auto-file needs a folder rule.");
        }
        const positions = yield* sql<{ position: number }>`
          SELECT COALESCE(MIN(sort_key), 0) - 1 AS position FROM thread_folders
        `;
        yield* requireLiveThreads(mutation.threadIds ?? []);
        yield* sql`
          INSERT INTO thread_folders (folder_id, name, icon_json, sort_key, rule_json, auto_file, rule_set_at, created_at, updated_at)
          VALUES (
            ${mutation.folderId},
            ${mutation.name},
            ${mutation.icon === null ? null : encodeIcon(mutation.icon ?? threadFolderIcon(mutation.name))},
            ${positions[0]!.position},
            ${rule === null ? null : encodeRule(rule)},
            ${Number(mutation.autoFile ?? false)},
            ${rule === null ? null : now},
            ${now},
            ${now}
          )
        `;
        yield* placeThreads(mutation.threadIds ?? [], mutation.folderId, now);
        if (mutation.autoFile !== false) yield* adopt(mutation.folderId);
        return;
      }
      case "folder.update": {
        yield* requireFolder(mutation.folderId);
        const current = (yield* readFolders).find((folder) => folder.id === mutation.folderId)!;
        const rule = mutation.rule === undefined ? current.rule : mutation.rule;
        if (rule !== null && !threadFolderRuleHasConditions(rule)) {
          return yield* folderError("A folder rule needs at least one condition.");
        }
        // Auto-file is opt-in per folder; editing a rule keeps the folder's choice.
        const autoFile = mutation.rule === null ? false : (mutation.autoFile ?? current.autoFile);
        if (autoFile && rule === null) {
          return yield* folderError("Auto-file needs a folder rule.");
        }
        if (mutation.rule !== undefined || mutation.autoFile !== undefined) {
          yield* sql`
            UPDATE thread_folders SET
              rule_json = ${rule === null ? null : encodeRule(rule)},
              auto_file = ${Number(autoFile)},
              rule_set_at = ${mutation.rule === undefined ? current.ruleSetAt : rule === null ? null : now},
              updated_at = ${now}
            WHERE folder_id = ${mutation.folderId}
          `;
        }
        if (mutation.name !== undefined) {
          yield* sql`
            UPDATE thread_folders SET name = ${mutation.name}, updated_at = ${now}
            WHERE folder_id = ${mutation.folderId}
          `;
          // An icon still picked from the old name follows the new one.
          if (
            mutation.icon === undefined &&
            current.icon !== null &&
            encodeIcon(current.icon) === encodeIcon(threadFolderIcon(current.name))
          ) {
            yield* sql`
              UPDATE thread_folders SET icon_json = ${encodeIcon(threadFolderIcon(mutation.name))}
              WHERE folder_id = ${mutation.folderId}
            `;
          }
        }
        if (mutation.icon !== undefined) {
          yield* sql`
            UPDATE thread_folders
            SET icon_json = ${mutation.icon === null ? null : encodeIcon(mutation.icon)},
              updated_at = ${now}
            WHERE folder_id = ${mutation.folderId}
          `;
        }
        if (
          mutation.name !== undefined &&
          mutation.rule === undefined &&
          mutation.autoFile !== false
        )
          yield* adopt(mutation.folderId);
        return;
      }
      case "folder.reorder": {
        yield* requireFolder(mutation.folderId);
        if (mutation.beforeFolderId !== null) yield* requireFolder(mutation.beforeFolderId);
        if (mutation.folderId === mutation.beforeFolderId) return;
        const folders = yield* readFolders;
        const ids = folders.map((folder) => folder.id).filter((id) => id !== mutation.folderId);
        const index =
          mutation.beforeFolderId === null ? ids.length : ids.indexOf(mutation.beforeFolderId);
        ids.splice(index, 0, mutation.folderId);
        for (const [position, id] of ids.entries()) {
          yield* sql`UPDATE thread_folders SET sort_key = ${position} WHERE folder_id = ${id}`;
        }
        return;
      }
      case "folder.applyRule": {
        yield* requireFolder(mutation.folderId);
        yield* adopt(mutation.folderId);
        const folder = (yield* readFolders).find((entry) => entry.id === mutation.folderId)!;
        const rule = yield* relatedRule(folder);
        if (
          (rule.smart && smart === undefined) ||
          (smart !== undefined &&
            (smart.folder.name !== folder.name || smart.folder.ruleSetAt !== folder.ruleSetAt))
        ) {
          return yield* folderError("The folder changed while threads were sorted. Try again.", {
            folderId: mutation.folderId,
          });
        }
        const matching = (yield* batchCandidates(rule)).filter(
          (shell) =>
            threadMatchesFolderRule(rule, subjectOf(shell)) || smart?.matches.has(shell.id),
        );
        return yield* placeThreads(
          matching.map((shell) => shell.id),
          mutation.folderId,
          now,
          false,
        );
      }
      case "folder.delete":
        yield* sql`
          INSERT OR IGNORE INTO thread_folder_explicit_moves (thread_id)
          SELECT thread_id FROM thread_folder_members WHERE folder_id = ${mutation.folderId}
        `;
        // Members cascade, so the threads simply leave the folder.
        yield* sql`DELETE FROM thread_folders WHERE folder_id = ${mutation.folderId}`;
        return;
      case "folder.move":
        if (mutation.folderId !== null) yield* requireFolder(mutation.folderId);
        yield* requireLiveThreads(mutation.threadIds);
        yield* placeThreads(mutation.threadIds, mutation.folderId, now);
        if (mutation.folderId !== null) yield* adopt(mutation.folderId);
        return;
    }
  });

  const mutate: ThreadFolderService["Service"]["mutate"] = Effect.fn("ThreadFolderService.mutate")(
    function* (mutation, options) {
      let smart: Parameters<typeof apply>[2];
      if (mutation.type === "folder.applyRule") {
        const folder = (yield* list()).folders.find((entry) => entry.id === mutation.folderId);
        const rule = folder === undefined ? null : yield* relatedRule(folder);
        if (folder !== undefined && rule?.smart) {
          const candidates = yield* batchCandidates(rule).pipe(
            Effect.mapError((cause) => folderError("Could not read threads.", { cause })),
          );
          const projectNames = new Map(
            (yield* projects
              .listShells()
              .pipe(
                Effect.mapError((cause) => folderError("Could not read projects.", { cause })),
              )).map((project) => [project.id, project.title]),
          );
          const settings = yield* serverSettings.getSettings.pipe(
            Effect.mapError((cause) => folderError("Could not read settings.", { cause })),
          );
          // Threads whose project, branch, worktree, or title names the folder need no model call.
          const named = candidates.filter((shell) =>
            threadNamesFolder(folder.name, {
              ...shell,
              projectName: projectNames.get(shell.projectId) ?? null,
            }),
          );
          const namedIds = new Set(named.map((shell) => shell.id));
          const samples = candidates.filter(
            (shell) => !namedIds.has(shell.id) && !threadMatchesFolderRule(rule, subjectOf(shell)),
          );
          const examples = yield* handFiledExamples(folder.id).pipe(
            Effect.mapError((cause) => folderError("Could not read folder.", { cause })),
          );
          const results = yield* Effect.forEach(
            Arr.chunksOf(samples, 50),
            (batch) =>
              textGeneration
                .classifyThreadFolder({
                  cwd: serverConfig.cwd,
                  folderName: folder.name,
                  examples,
                  threads: batch.map((shell) => ({
                    id: shell.id,
                    title: shell.title,
                    branch: shell.branch,
                    worktreeName: shell.worktreePath?.split(/[\\/]/).findLast(Boolean) ?? null,
                    hasPullRequest: visibleThreadPullRequests(shell.pullRequests ?? []).length > 0,
                    projectName: projectNames.get(shell.projectId) ?? null,
                  })),
                  modelSelection: settings.textGenerationModelSelection,
                })
                .pipe(
                  Effect.mapError((cause) => folderError("Could not classify threads.", { cause })),
                ),
            { concurrency: 8 },
          );
          smart = {
            matches: new Set([...namedIds, ...results.flatMap((result) => result.threadIds)]),
            folder: { name: folder.name, ruleSetAt: folder.ruleSetAt },
          };
        }
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* writes.withPermit(
        sql.withTransaction(apply(mutation, now, smart, options?.inferRules)).pipe(
          Effect.catchTags({
            SqlError: (cause) =>
              Effect.fail(folderError("Could not save the thread folder.", { cause })),
          }),
        ),
      );
      yield* PubSub.publish(changes, undefined);
      return yield* list();
    },
  );

  const autoFile = Effect.fn("ThreadFolderService.autoFile")(function* (threadId: ThreadId) {
    const changed = yield* writes.withPermit(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const enabled = yield* sql`SELECT 1 FROM thread_folders WHERE auto_file = 1 LIMIT 1`;
            if (enabled.length === 0) return false;
            const shell = yield* threads
              .getThreadShell(threadId)
              .pipe(
                Effect.mapError((cause) =>
                  folderError("Could not read thread for auto-file.", { cause }),
                ),
              );
            if (
              shell === null ||
              shell.deletedAt !== null ||
              shell.archivedAt !== null ||
              shell.settledOverride === "settled" ||
              shell.lineage.relationshipToParent === "subagent"
            )
              return false;
            const explicit = yield* sql`
              SELECT 1 FROM thread_folder_explicit_moves WHERE thread_id = ${threadId}
            `;
            if (explicit.length > 0) return false;
            const folders = yield* readFolders;
            const subject = {
              ...shell,
              hasPullRequest: visibleThreadPullRequests(shell.pullRequests ?? []).length > 0,
            };
            const createdAt = DateTime.toEpochMillis(shell.createdAt);
            const ruleCovers = (folder: ThreadFolder) =>
              folder.ruleSetAt !== null && createdAt > Date.parse(folder.ruleSetAt);
            const current = folders.find((folder) => folder.threadIds.includes(threadId));
            // An auto-filed thread moves only when the rule that filed it stops matching.
            if (
              current !== undefined &&
              !(
                !current.rule?.smart &&
                current.autoFile &&
                current.rule !== null &&
                !threadMatchesFolderRule(current.rule, subject)
              )
            ) {
              return false;
            }
            const folder = pickThreadFolderForRule(folders.filter(ruleCovers), subject);
            if (folder === null && current === undefined) return false;
            yield* placeThreads(
              [threadId],
              folder?.id ?? null,
              DateTime.formatIso(yield* DateTime.now),
              false,
            );
            return true;
          }),
        )
        .pipe(
          Effect.catchTags({
            SqlError: (cause) => Effect.fail(folderError("Could not auto-file thread.", { cause })),
          }),
        ),
    );
    if (changed) yield* PubSub.publish(changes, undefined);
  });

  const smartCandidates = Effect.fn("ThreadFolderService.smartCandidates")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError((cause) => folderError("Could not read thread.", { cause })));
    if (
      shell === null ||
      shell.deletedAt !== null ||
      shell.archivedAt !== null ||
      shell.settledOverride === "settled" ||
      shell.lineage.relationshipToParent === "subagent"
    )
      return [];
    const excluded =
      yield* sql`SELECT 1 FROM thread_folder_explicit_moves WHERE thread_id = ${threadId}
      UNION ALL SELECT 1 FROM thread_folder_members WHERE thread_id = ${threadId}`.pipe(
        Effect.mapError((cause) => folderError("Could not read placement.", { cause })),
      );
    if (excluded.length) return [];
    const smart = (yield* list()).folders.filter(
      (folder) =>
        folder.autoFile &&
        folder.rule?.smart &&
        matchesSmartConditions(folder.rule, shell) &&
        folder.ruleSetAt !== null &&
        DateTime.toEpochMillis(shell.createdAt) > Date.parse(folder.ruleSetAt),
    );
    return yield* Effect.forEach(smart, (folder) =>
      handFiledExamples(folder.id).pipe(
        Effect.map((examples) => ({ id: folder.id, name: folder.name, examples })),
        Effect.mapError((cause) => folderError("Could not read folder.", { cause })),
      ),
    );
  });

  const applySmartPick = Effect.fn("ThreadFolderService.applySmartPick")(function* (
    threadId: ThreadId,
    folderId: string,
  ) {
    yield* writes.withPermit(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const candidate = (yield* smartCandidates(threadId)).find(
              (folder) => folder.id === folderId,
            );
            if (candidate)
              yield* placeThreads(
                [threadId],
                candidate.id,
                DateTime.formatIso(yield* DateTime.now),
                false,
              );
          }),
        )
        .pipe(Effect.mapError((cause) => folderError("Could not file thread.", { cause }))),
    );
    yield* PubSub.publish(changes, undefined);
  });

  return ThreadFolderService.of({
    list,
    subscribeList,
    mutate,
    autoFile,
    smartCandidates,
    applySmartPick,
  });
});

export const layer = Layer.effect(ThreadFolderService, make);
