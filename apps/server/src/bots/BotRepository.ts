import {
  Bot,
  BotAvatarColor,
  BotGroup,
  BotGroupId,
  BotGroupMessage,
  BotGroupMessageId,
  BotGroupSenderType,
  BotId,
  BotItem,
  BotItemId,
  BotItemSource,
  BotItemStatus,
  BotItemsStaleDays,
  BotOperationError,
  BotRoutine,
  BotRoutineId,
  BotRoutineRunStatus,
  BotSlug,
  BotTimeOfDay,
  IsoDateTime,
  ModelSelection,
  NonNegativeInt,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
  ScheduledTaskSchedule,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeBotId = Schema.decodeUnknownSync(BotId);
const isBotOperationError = Schema.is(BotOperationError);
const decodeBotSlug = Schema.decodeUnknownSync(BotSlug);
const decodeBotAvatarColor = Schema.decodeUnknownSync(BotAvatarColor);
const decodeProjectId = Schema.decodeUnknownSync(ProjectId);
const decodeProviderInstanceId = Schema.decodeUnknownSync(ProviderInstanceId);
const decodeRuntimeMode = Schema.decodeUnknownSync(RuntimeMode);
const decodeThreadId = Schema.decodeUnknownSync(ThreadId);
const decodeBotTimeOfDay = Schema.decodeUnknownSync(BotTimeOfDay);
const decodeBotItemsStaleDays = Schema.decodeUnknownSync(BotItemsStaleDays);
const decodeIsoDateTime = Schema.decodeUnknownSync(IsoDateTime);
const decodeBotRoutineId = Schema.decodeUnknownSync(BotRoutineId);
const decodeBotRoutineRunStatus = Schema.decodeUnknownSync(BotRoutineRunStatus);
const decodeNonNegativeInt = Schema.decodeUnknownSync(NonNegativeInt);
const decodeBotGroupId = Schema.decodeUnknownSync(BotGroupId);
const decodeBotGroupMessageId = Schema.decodeUnknownSync(BotGroupMessageId);
const decodeBotGroupSenderType = Schema.decodeUnknownSync(BotGroupSenderType);
const decodeBotItemId = Schema.decodeUnknownSync(BotItemId);
const decodeBotItemStatus = Schema.decodeUnknownSync(BotItemStatus);
const decodeBotItemSource = Schema.decodeUnknownSync(BotItemSource);

const ModelSelectionJson = Schema.fromJsonString(ModelSelection);
const ProjectIdsJson = Schema.fromJsonString(Schema.Array(ProjectId));
const BotIdsJson = Schema.fromJsonString(Schema.Array(BotId));
const ScheduleJson = Schema.fromJsonString(ScheduledTaskSchedule);

const encodeModelSelectionJson = Schema.encodeSync(ModelSelectionJson);
const decodeModelSelectionJson = Schema.decodeUnknownSync(ModelSelectionJson);
const encodeProjectIdsJson = Schema.encodeSync(ProjectIdsJson);
const decodeProjectIdsJson = Schema.decodeUnknownSync(ProjectIdsJson);
const encodeBotIdsJson = Schema.encodeSync(BotIdsJson);
const decodeBotIdsJson = Schema.decodeUnknownSync(BotIdsJson);
const encodeScheduleJson = Schema.encodeSync(ScheduleJson);
const decodeScheduleJson = Schema.decodeUnknownSync(ScheduleJson);

interface BotRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly home_path: string;
  readonly project_id: string;
  readonly avatar: string | null;
  readonly avatar_color: string;
  readonly provider_instance_id: string | null;
  readonly model_selection_json: string | null;
  readonly runtime_mode: string;
  readonly paused: number;
  readonly first_run: number;
  readonly skill_projects_json: string;
  readonly chat_thread_id: string | null;
  readonly tidy_up_enabled: number;
  readonly tidy_up_time_of_day: string;
  readonly items_stale_days: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface BotRoutineRow {
  readonly id: string;
  readonly bot_id: string;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: number;
  readonly schedule_json: string;
  readonly precheck_command: string | null;
  readonly last_precheck_hash: string | null;
  readonly is_tidy_up: number;
  readonly next_run_at: string | null;
  readonly last_run_at: string | null;
  readonly last_run_status: string;
  readonly last_run_error: string | null;
  readonly last_run_thread_id: string | null;
  readonly run_count: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface BotGroupRow {
  readonly id: string;
  readonly name: string;
  readonly member_bot_ids_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface BotGroupMessageRow {
  readonly id: string;
  readonly group_id: string;
  readonly sender_type: string;
  readonly sender_bot_id: string | null;
  readonly sender_name: string;
  readonly body: string;
  readonly mentioned_bot_ids_json: string;
  readonly thread_id: string | null;
  readonly created_at: string;
}

interface BotItemRow {
  readonly id: string;
  readonly bot_id: string;
  readonly title: string;
  readonly summary: string;
  readonly status: string;
  readonly source: string;
  readonly thread_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_activity_at: string;
}

function parseItemsStaleDays(raw: string): BotItemsStaleDays {
  if (raw === "never") return "never";
  return decodeBotItemsStaleDays(Number(raw));
}

function decodeBotRow(row: BotRow): Bot {
  return {
    id: decodeBotId(row.id),
    name: row.name,
    slug: decodeBotSlug(row.slug),
    homePath: row.home_path,
    projectId: decodeProjectId(row.project_id),
    avatar: row.avatar,
    avatarColor: decodeBotAvatarColor(row.avatar_color),
    providerInstanceId:
      row.provider_instance_id === null ? null : decodeProviderInstanceId(row.provider_instance_id),
    modelSelection:
      row.model_selection_json === null ? null : decodeModelSelectionJson(row.model_selection_json),
    runtimeMode: decodeRuntimeMode(row.runtime_mode),
    paused: row.paused === 1,
    firstRun: row.first_run === 1,
    skillProjects: decodeProjectIdsJson(row.skill_projects_json),
    chatThreadId: row.chat_thread_id === null ? null : decodeThreadId(row.chat_thread_id),
    tidyUpEnabled: row.tidy_up_enabled === 1,
    tidyUpTimeOfDay: decodeBotTimeOfDay(row.tidy_up_time_of_day),
    itemsStaleDays: parseItemsStaleDays(row.items_stale_days),
    createdAt: decodeIsoDateTime(row.created_at),
    updatedAt: decodeIsoDateTime(row.updated_at),
  };
}

function decodeRoutineRow(row: BotRoutineRow): BotRoutine {
  return {
    id: decodeBotRoutineId(row.id),
    botId: decodeBotId(row.bot_id),
    title: row.title,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    schedule: decodeScheduleJson(row.schedule_json),
    precheckCommand: row.precheck_command,
    lastPrecheckHash: row.last_precheck_hash,
    isTidyUp: row.is_tidy_up === 1,
    nextRunAt: row.next_run_at === null ? null : decodeIsoDateTime(row.next_run_at),
    lastRunAt: row.last_run_at === null ? null : decodeIsoDateTime(row.last_run_at),
    lastRunStatus: decodeBotRoutineRunStatus(row.last_run_status),
    lastRunError: row.last_run_error,
    lastRunThreadId:
      row.last_run_thread_id === null ? null : decodeThreadId(row.last_run_thread_id),
    runCount: decodeNonNegativeInt(row.run_count),
    createdAt: decodeIsoDateTime(row.created_at),
    updatedAt: decodeIsoDateTime(row.updated_at),
  };
}

function decodeGroupRow(row: BotGroupRow): BotGroup {
  return {
    id: decodeBotGroupId(row.id),
    name: row.name,
    memberBotIds: decodeBotIdsJson(row.member_bot_ids_json),
    createdAt: decodeIsoDateTime(row.created_at),
    updatedAt: decodeIsoDateTime(row.updated_at),
  };
}

function decodeGroupMessageRow(row: BotGroupMessageRow): BotGroupMessage {
  return {
    id: decodeBotGroupMessageId(row.id),
    groupId: decodeBotGroupId(row.group_id),
    senderType: decodeBotGroupSenderType(row.sender_type),
    senderBotId: row.sender_bot_id === null ? null : decodeBotId(row.sender_bot_id),
    senderName: row.sender_name,
    body: row.body,
    mentionedBotIds: decodeBotIdsJson(row.mentioned_bot_ids_json),
    threadId: row.thread_id === null ? null : decodeThreadId(row.thread_id),
    createdAt: decodeIsoDateTime(row.created_at),
  };
}

function decodeItemRow(row: BotItemRow): BotItem {
  return {
    id: decodeBotItemId(row.id),
    botId: decodeBotId(row.bot_id),
    title: row.title,
    summary: row.summary,
    status: decodeBotItemStatus(row.status),
    source: decodeBotItemSource(row.source),
    threadId: row.thread_id === null ? null : decodeThreadId(row.thread_id),
    createdAt: decodeIsoDateTime(row.created_at),
    updatedAt: decodeIsoDateTime(row.updated_at),
    lastActivityAt: decodeIsoDateTime(row.last_activity_at),
  };
}

const mapSqlError = (operation: string) => (cause: unknown) =>
  isBotOperationError(cause)
    ? cause
    : new BotOperationError({
        message: `Bot persistence error during ${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
      });

export class BotRepository extends Context.Service<
  BotRepository,
  {
    readonly listBots: () => Effect.Effect<ReadonlyArray<Bot>, BotOperationError>;
    readonly getBot: (botId: BotId) => Effect.Effect<Option.Option<Bot>, BotOperationError>;
    readonly upsertBot: (bot: Bot) => Effect.Effect<Bot, BotOperationError>;
    readonly deleteBot: (botId: BotId) => Effect.Effect<boolean, BotOperationError>;

    readonly listRoutinesByBot: (
      botId: BotId,
    ) => Effect.Effect<ReadonlyArray<BotRoutine>, BotOperationError>;
    readonly getRoutine: (
      routineId: BotRoutineId,
    ) => Effect.Effect<Option.Option<BotRoutine>, BotOperationError>;
    readonly listDueRoutines: (
      nowIso: IsoDateTime,
    ) => Effect.Effect<ReadonlyArray<BotRoutine>, BotOperationError>;
    readonly upsertRoutine: (routine: BotRoutine) => Effect.Effect<BotRoutine, BotOperationError>;
    readonly deleteRoutine: (routineId: BotRoutineId) => Effect.Effect<boolean, BotOperationError>;

    readonly listGroups: () => Effect.Effect<ReadonlyArray<BotGroup>, BotOperationError>;
    readonly getGroup: (
      groupId: BotGroupId,
    ) => Effect.Effect<Option.Option<BotGroup>, BotOperationError>;
    readonly upsertGroup: (group: BotGroup) => Effect.Effect<BotGroup, BotOperationError>;
    readonly deleteGroup: (groupId: BotGroupId) => Effect.Effect<boolean, BotOperationError>;
    readonly listGroupMessages: (
      groupId: BotGroupId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<BotGroupMessage>, BotOperationError>;
    readonly insertGroupMessage: (
      message: BotGroupMessage,
    ) => Effect.Effect<BotGroupMessage, BotOperationError>;

    readonly listItemsByBot: (
      botId: BotId,
      status?: BotItemStatus,
    ) => Effect.Effect<ReadonlyArray<BotItem>, BotOperationError>;
    readonly getItem: (
      itemId: BotItemId,
    ) => Effect.Effect<Option.Option<BotItem>, BotOperationError>;
    readonly upsertItem: (item: BotItem) => Effect.Effect<BotItem, BotOperationError>;
    readonly deleteItem: (itemId: BotItemId) => Effect.Effect<boolean, BotOperationError>;
    readonly markStaleItemsForBot: (
      botId: BotId,
      cutoffIso: IsoDateTime,
      nowIso: IsoDateTime,
    ) => Effect.Effect<number, BotOperationError>;
  }
>()("t3/bots/BotRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      home_path TEXT NOT NULL,
      project_id TEXT NOT NULL,
      avatar TEXT,
      avatar_color TEXT NOT NULL,
      provider_instance_id TEXT,
      model_selection_json TEXT,
      runtime_mode TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,
      first_run INTEGER NOT NULL DEFAULT 0,
      skill_projects_json TEXT NOT NULL DEFAULT '[]',
      chat_thread_id TEXT,
      tidy_up_enabled INTEGER NOT NULL DEFAULT 1,
      tidy_up_time_of_day TEXT NOT NULL DEFAULT '02:00',
      items_stale_days TEXT NOT NULL DEFAULT '5',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_routines (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      schedule_json TEXT NOT NULL,
      precheck_command TEXT,
      last_precheck_hash TEXT,
      is_tidy_up INTEGER NOT NULL DEFAULT 0,
      next_run_at TEXT,
      last_run_at TEXT,
      last_run_status TEXT NOT NULL DEFAULT 'idle',
      last_run_error TEXT,
      last_run_thread_id TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_bot_routines_bot_id ON bot_routines(bot_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_bot_routines_due ON bot_routines(enabled, next_run_at)`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      member_bot_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_group_messages (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES bot_groups(id) ON DELETE CASCADE,
      sender_type TEXT NOT NULL,
      sender_bot_id TEXT,
      sender_name TEXT NOT NULL,
      body TEXT NOT NULL,
      mentioned_bot_ids_json TEXT NOT NULL DEFAULT '[]',
      thread_id TEXT,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_bot_group_messages_group_created
    ON bot_group_messages(group_id, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_items (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_bot_items_bot_status ON bot_items(bot_id, status, last_activity_at)
  `;

  const listBots = Effect.fn("BotRepository.listBots")(
    function* () {
      const rows = yield* sql<BotRow>`SELECT * FROM bots ORDER BY created_at ASC`;
      return rows.map(decodeBotRow);
    },
    Effect.mapError(mapSqlError("listBots")),
  );

  const getBot = Effect.fn("BotRepository.getBot")(
    function* (botId: BotId) {
      const rows = yield* sql<BotRow>`SELECT * FROM bots WHERE id = ${botId}`;
      const first = rows[0];
      return first === undefined ? Option.none() : Option.some(decodeBotRow(first));
    },
    Effect.mapError(mapSqlError("getBot")),
  );

  const upsertBot = Effect.fn("BotRepository.upsertBot")(
    function* (bot: Bot) {
      const modelJson =
        bot.modelSelection === null ? null : encodeModelSelectionJson(bot.modelSelection);
      const skillsJson = encodeProjectIdsJson(bot.skillProjects);
      yield* sql`
        INSERT INTO bots (
          id, name, slug, home_path, project_id, avatar, avatar_color,
          provider_instance_id, model_selection_json, runtime_mode,
          paused, first_run, skill_projects_json, chat_thread_id,
          tidy_up_enabled, tidy_up_time_of_day, items_stale_days,
          created_at, updated_at
        ) VALUES (
          ${bot.id},
          ${bot.name},
          ${bot.slug},
          ${bot.homePath},
          ${bot.projectId},
          ${bot.avatar},
          ${bot.avatarColor},
          ${bot.providerInstanceId},
          ${modelJson},
          ${bot.runtimeMode},
          ${bot.paused ? 1 : 0},
          ${bot.firstRun ? 1 : 0},
          ${skillsJson},
          ${bot.chatThreadId},
          ${bot.tidyUpEnabled ? 1 : 0},
          ${bot.tidyUpTimeOfDay},
          ${String(bot.itemsStaleDays)},
          ${bot.createdAt},
          ${bot.updatedAt}
        )
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          slug = excluded.slug,
          home_path = excluded.home_path,
          project_id = excluded.project_id,
          avatar = excluded.avatar,
          avatar_color = excluded.avatar_color,
          provider_instance_id = excluded.provider_instance_id,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          paused = excluded.paused,
          first_run = excluded.first_run,
          skill_projects_json = excluded.skill_projects_json,
          chat_thread_id = excluded.chat_thread_id,
          tidy_up_enabled = excluded.tidy_up_enabled,
          tidy_up_time_of_day = excluded.tidy_up_time_of_day,
          items_stale_days = excluded.items_stale_days,
          updated_at = excluded.updated_at
      `;
      return bot;
    },
    Effect.mapError(mapSqlError("upsertBot")),
  );

  const deleteBot = Effect.fn("BotRepository.deleteBot")(
    function* (botId: BotId) {
      const existing = yield* getBot(botId);
      if (Option.isNone(existing)) return false;
      yield* sql`DELETE FROM bot_routines WHERE bot_id = ${botId}`;
      yield* sql`DELETE FROM bot_items WHERE bot_id = ${botId}`;
      yield* sql`DELETE FROM bots WHERE id = ${botId}`;
      return true;
    },
    Effect.mapError(mapSqlError("deleteBot")),
  );

  const listRoutinesByBot = Effect.fn("BotRepository.listRoutinesByBot")(
    function* (botId: BotId) {
      const rows = yield* sql<BotRoutineRow>`
        SELECT * FROM bot_routines WHERE bot_id = ${botId} ORDER BY is_tidy_up ASC, created_at ASC
      `;
      return rows.map(decodeRoutineRow);
    },
    Effect.mapError(mapSqlError("listRoutinesByBot")),
  );

  const getRoutine = Effect.fn("BotRepository.getRoutine")(
    function* (routineId: BotRoutineId) {
      const rows = yield* sql<BotRoutineRow>`
        SELECT * FROM bot_routines WHERE id = ${routineId}
      `;
      const first = rows[0];
      return first === undefined ? Option.none() : Option.some(decodeRoutineRow(first));
    },
    Effect.mapError(mapSqlError("getRoutine")),
  );

  const listDueRoutines = Effect.fn("BotRepository.listDueRoutines")(
    function* (nowIso: IsoDateTime) {
      const rows = yield* sql<BotRoutineRow>`
        SELECT r.*
        FROM bot_routines r
        INNER JOIN bots b ON b.id = r.bot_id
        WHERE r.enabled = 1
          AND b.paused = 0
          AND r.next_run_at IS NOT NULL
          AND r.next_run_at <= ${nowIso}
        ORDER BY r.next_run_at ASC
      `;
      return rows.map(decodeRoutineRow);
    },
    Effect.mapError(mapSqlError("listDueRoutines")),
  );

  const upsertRoutine = Effect.fn("BotRepository.upsertRoutine")(
    function* (routine: BotRoutine) {
      const scheduleJson = encodeScheduleJson(routine.schedule);
      yield* sql`
        INSERT INTO bot_routines (
          id, bot_id, title, prompt, enabled, schedule_json,
          precheck_command, last_precheck_hash, is_tidy_up,
          next_run_at, last_run_at, last_run_status, last_run_error,
          last_run_thread_id, run_count, created_at, updated_at
        ) VALUES (
          ${routine.id},
          ${routine.botId},
          ${routine.title},
          ${routine.prompt},
          ${routine.enabled ? 1 : 0},
          ${scheduleJson},
          ${routine.precheckCommand},
          ${routine.lastPrecheckHash},
          ${routine.isTidyUp ? 1 : 0},
          ${routine.nextRunAt},
          ${routine.lastRunAt},
          ${routine.lastRunStatus},
          ${routine.lastRunError},
          ${routine.lastRunThreadId},
          ${routine.runCount},
          ${routine.createdAt},
          ${routine.updatedAt}
        )
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          prompt = excluded.prompt,
          enabled = excluded.enabled,
          schedule_json = excluded.schedule_json,
          precheck_command = excluded.precheck_command,
          last_precheck_hash = excluded.last_precheck_hash,
          is_tidy_up = excluded.is_tidy_up,
          next_run_at = excluded.next_run_at,
          last_run_at = excluded.last_run_at,
          last_run_status = excluded.last_run_status,
          last_run_error = excluded.last_run_error,
          last_run_thread_id = excluded.last_run_thread_id,
          run_count = excluded.run_count,
          updated_at = excluded.updated_at
      `;
      return routine;
    },
    Effect.mapError(mapSqlError("upsertRoutine")),
  );

  const deleteRoutine = Effect.fn("BotRepository.deleteRoutine")(
    function* (routineId: BotRoutineId) {
      const existing = yield* getRoutine(routineId);
      if (Option.isNone(existing)) return false;
      yield* sql`DELETE FROM bot_routines WHERE id = ${routineId}`;
      return true;
    },
    Effect.mapError(mapSqlError("deleteRoutine")),
  );

  const listGroups = Effect.fn("BotRepository.listGroups")(
    function* () {
      const rows = yield* sql<BotGroupRow>`SELECT * FROM bot_groups ORDER BY created_at ASC`;
      return rows.map(decodeGroupRow);
    },
    Effect.mapError(mapSqlError("listGroups")),
  );

  const getGroup = Effect.fn("BotRepository.getGroup")(
    function* (groupId: BotGroupId) {
      const rows = yield* sql<BotGroupRow>`SELECT * FROM bot_groups WHERE id = ${groupId}`;
      const first = rows[0];
      return first === undefined ? Option.none() : Option.some(decodeGroupRow(first));
    },
    Effect.mapError(mapSqlError("getGroup")),
  );

  const upsertGroup = Effect.fn("BotRepository.upsertGroup")(
    function* (group: BotGroup) {
      const membersJson = encodeBotIdsJson(group.memberBotIds);
      yield* sql`
        INSERT INTO bot_groups (id, name, member_bot_ids_json, created_at, updated_at)
        VALUES (
          ${group.id},
          ${group.name},
          ${membersJson},
          ${group.createdAt},
          ${group.updatedAt}
        )
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          member_bot_ids_json = excluded.member_bot_ids_json,
          updated_at = excluded.updated_at
      `;
      return group;
    },
    Effect.mapError(mapSqlError("upsertGroup")),
  );

  const deleteGroup = Effect.fn("BotRepository.deleteGroup")(
    function* (groupId: BotGroupId) {
      const existing = yield* getGroup(groupId);
      if (Option.isNone(existing)) return false;
      yield* sql`DELETE FROM bot_group_messages WHERE group_id = ${groupId}`;
      yield* sql`DELETE FROM bot_groups WHERE id = ${groupId}`;
      return true;
    },
    Effect.mapError(mapSqlError("deleteGroup")),
  );

  const listGroupMessages = Effect.fn("BotRepository.listGroupMessages")(
    function* (groupId: BotGroupId, limit: number) {
      const rows = yield* sql<BotGroupMessageRow>`
        SELECT * FROM (
          SELECT * FROM bot_group_messages
          WHERE group_id = ${groupId}
          ORDER BY created_at DESC
          LIMIT ${limit}
        ) ORDER BY created_at ASC
      `;
      return rows.map(decodeGroupMessageRow);
    },
    Effect.mapError(mapSqlError("listGroupMessages")),
  );

  const insertGroupMessage = Effect.fn("BotRepository.insertGroupMessage")(
    function* (message: BotGroupMessage) {
      const mentionedJson = encodeBotIdsJson(message.mentionedBotIds);
      yield* sql`
        INSERT INTO bot_group_messages (
          id, group_id, sender_type, sender_bot_id, sender_name,
          body, mentioned_bot_ids_json, thread_id, created_at
        ) VALUES (
          ${message.id},
          ${message.groupId},
          ${message.senderType},
          ${message.senderBotId},
          ${message.senderName},
          ${message.body},
          ${mentionedJson},
          ${message.threadId},
          ${message.createdAt}
        )
      `;
      return message;
    },
    Effect.mapError(mapSqlError("insertGroupMessage")),
  );

  const listItemsByBot = Effect.fn("BotRepository.listItemsByBot")(
    function* (botId: BotId, status?: BotItemStatus) {
      const rows =
        status === undefined
          ? yield* sql<BotItemRow>`
              SELECT * FROM bot_items WHERE bot_id = ${botId} ORDER BY last_activity_at DESC
            `
          : yield* sql<BotItemRow>`
              SELECT * FROM bot_items
              WHERE bot_id = ${botId} AND status = ${status}
              ORDER BY last_activity_at DESC
            `;
      return rows.map(decodeItemRow);
    },
    Effect.mapError(mapSqlError("listItemsByBot")),
  );

  const getItem = Effect.fn("BotRepository.getItem")(
    function* (itemId: BotItemId) {
      const rows = yield* sql<BotItemRow>`SELECT * FROM bot_items WHERE id = ${itemId}`;
      const first = rows[0];
      return first === undefined ? Option.none() : Option.some(decodeItemRow(first));
    },
    Effect.mapError(mapSqlError("getItem")),
  );

  const upsertItem = Effect.fn("BotRepository.upsertItem")(
    function* (item: BotItem) {
      yield* sql`
        INSERT INTO bot_items (
          id, bot_id, title, summary, status, source, thread_id,
          created_at, updated_at, last_activity_at
        ) VALUES (
          ${item.id},
          ${item.botId},
          ${item.title},
          ${item.summary},
          ${item.status},
          ${item.source},
          ${item.threadId},
          ${item.createdAt},
          ${item.updatedAt},
          ${item.lastActivityAt}
        )
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          summary = excluded.summary,
          status = excluded.status,
          thread_id = excluded.thread_id,
          updated_at = excluded.updated_at,
          last_activity_at = excluded.last_activity_at
      `;
      return item;
    },
    Effect.mapError(mapSqlError("upsertItem")),
  );

  const deleteItem = Effect.fn("BotRepository.deleteItem")(
    function* (itemId: BotItemId) {
      const existing = yield* getItem(itemId);
      if (Option.isNone(existing)) return false;
      yield* sql`DELETE FROM bot_items WHERE id = ${itemId}`;
      return true;
    },
    Effect.mapError(mapSqlError("deleteItem")),
  );

  const markStaleItemsForBot = Effect.fn("BotRepository.markStaleItemsForBot")(
    function* (botId: BotId, cutoffIso: IsoDateTime, nowIso: IsoDateTime) {
      const rows = yield* sql<{ readonly id: string }>`
        UPDATE bot_items
        SET status = 'stale', updated_at = ${nowIso}
        WHERE bot_id = ${botId}
          AND status IN ('open', 'in_progress')
          AND last_activity_at < ${cutoffIso}
        RETURNING id
      `;
      return rows.length;
    },
    Effect.mapError(mapSqlError("markStaleItemsForBot")),
  );

  return BotRepository.of({
    listBots,
    getBot,
    upsertBot,
    deleteBot,
    listRoutinesByBot,
    getRoutine,
    listDueRoutines,
    upsertRoutine,
    deleteRoutine,
    listGroups,
    getGroup,
    upsertGroup,
    deleteGroup,
    listGroupMessages,
    insertGroupMessage,
    listItemsByBot,
    getItem,
    upsertItem,
    deleteItem,
    markStaleItemsForBot,
  });
});

export const layer = Layer.effect(BotRepository, make);
