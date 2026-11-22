import {
  BotAccess,
  BotError,
  BotList,
  BotProfile,
  BotProfileFields,
  type BotState,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

type ProfileFields = Omit<BotProfile, "threadId" | "projectId" | "state" | "revision" | "access">;
type ProfileRow = {
  readonly threadId: string;
  readonly projectId: string;
  readonly state: string;
  readonly revision: number;
  readonly profile: string;
  readonly accessJson: string | null;
};

export class BotStore extends Context.Service<
  BotStore,
  {
    readonly find: (threadId: ThreadId) => Effect.Effect<BotProfile | undefined, BotError>;
    readonly subscribe: () => Stream.Stream<ReadonlyArray<BotProfile>, BotError>;
    readonly create: (input: BotProfile) => Effect.Effect<BotProfile, BotError>;
    readonly update: (
      threadId: ThreadId,
      expectedRevision: number,
      profile: ProfileFields,
    ) => Effect.Effect<BotProfile, BotError>;
    readonly setState: (threadId: ThreadId, state: BotState) => Effect.Effect<BotProfile, BotError>;
    readonly setAccess: (threadId: ThreadId, access: BotAccess) => Effect.Effect<void, BotError>;
    readonly history: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<BotProfile>, BotError>;
  }
>()("t3/bots/BotStore") {}

const accessJson = Schema.fromJsonString(BotAccess);
const decodeAccess = Schema.decodeEffect(accessJson);
const encodeAccess = Schema.encodeEffect(accessJson);
const defaultAccess: BotAccess = { writeSources: [], handoffProjects: [] };
const profileJson = Schema.fromJsonString(BotProfileFields);
const decodeBotList = Schema.decodeUnknownEffect(BotList);
const decodeProfile = Schema.decodeEffect(profileJson);
const encodeProfile = Schema.encodeEffect(profileJson);
const isBotError = Schema.is(BotError);
const unavailable = (cause: unknown) => new BotError({ reason: "unavailable", cause });
const mapStoreError = (cause: unknown) => (isBotError(cause) ? cause : unavailable(cause));

const decodeRows = Effect.fn("BotStore.decodeRows")(function* (rows: ReadonlyArray<ProfileRow>) {
  const profiles = yield* Effect.forEach(rows, ({ profile, accessJson, ...row }) =>
    Effect.all([
      decodeProfile(profile),
      accessJson === null ? Effect.succeed(defaultAccess) : decodeAccess(accessJson),
    ]).pipe(Effect.map(([fields, access]) => ({ ...fields, ...row, access }))),
  );
  return yield* decodeBotList(profiles);
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.sliding<void>(1);
  const notify = PubSub.publish(changes, undefined);

  const select = sql`
    SELECT bot.thread_id AS "threadId", bot.project_id AS "projectId", bot.state,
           version.revision, version.profile, bot.access_json AS "accessJson"
    FROM bot_profiles AS bot
    INNER JOIN bot_profile_revisions AS version ON version.thread_id = bot.thread_id
  `;

  const find = Effect.fn("BotStore.find")(function* (threadId: ThreadId) {
    const rows = yield* sql<ProfileRow>`
      ${select}
      WHERE bot.thread_id = ${threadId} AND version.revision = bot.revision
    `.pipe(Effect.flatMap(decodeRows), Effect.mapError(unavailable));
    return rows[0];
  });

  const requireProfile = Effect.fn("BotStore.requireProfile")(function* (threadId: ThreadId) {
    const profile = yield* find(threadId);
    if (profile === undefined) return yield* new BotError({ reason: "not_found" });
    return profile;
  });

  const list = Effect.fn("BotStore.list")(function* () {
    return yield* sql<ProfileRow>`
      ${select}
      WHERE version.revision = bot.revision
      ORDER BY bot.project_id, bot.thread_id
    `.pipe(Effect.flatMap(decodeRows), Effect.mapError(unavailable));
  });

  const create = Effect.fn("BotStore.create")(function* (input: BotProfile) {
    const { threadId, projectId, state, revision, access, ...profile } = input;
    const accessData = yield* encodeAccess(access).pipe(Effect.mapError(unavailable));
    const encoded = yield* encodeProfile(profile).pipe(Effect.mapError(unavailable));
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const inserted = yield* sql<{ readonly thread_id: string }>`
        INSERT INTO bot_profiles (thread_id, project_id, state, revision, access_json)
        VALUES (${threadId}, ${projectId}, ${state}, ${revision}, ${accessData})
        ON CONFLICT (thread_id) DO NOTHING
        RETURNING thread_id
      `;
          if (inserted.length > 0) {
            yield* sql`
          INSERT INTO bot_profile_revisions (thread_id, revision, profile)
          VALUES (${threadId}, ${revision}, ${encoded})
        `;
          }
          return yield* requireProfile(threadId);
        }),
      )
      .pipe(
        Effect.mapError(mapStoreError),
        Effect.tap(() => notify),
      );
  });

  const update = Effect.fn("BotStore.update")(function* (
    threadId: ThreadId,
    expectedRevision: number,
    profile: ProfileFields,
  ) {
    const revision = expectedRevision + 1;
    const encoded = yield* encodeProfile(profile).pipe(Effect.mapError(unavailable));
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* requireProfile(threadId);
          const updated = yield* sql<{ readonly thread_id: string }>`
        UPDATE bot_profiles SET revision = ${revision}
        WHERE thread_id = ${threadId} AND revision = ${expectedRevision}
        RETURNING thread_id
      `;
          if (updated.length === 0) return yield* new BotError({ reason: "conflict" });
          yield* sql`
        INSERT INTO bot_profile_revisions (thread_id, revision, profile)
        VALUES (${threadId}, ${revision}, ${encoded})
      `;
          return yield* requireProfile(threadId);
        }),
      )
      .pipe(
        Effect.mapError(mapStoreError),
        Effect.tap(() => notify),
      );
  });

  const setState = Effect.fn("BotStore.setState")(function* (threadId: ThreadId, state: BotState) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const bot = yield* requireProfile(threadId);
          yield* sql`UPDATE bot_profiles SET state = ${state} WHERE thread_id = ${threadId}`;
          return { ...bot, state };
        }),
      )
      .pipe(
        Effect.mapError(mapStoreError),
        Effect.tap(() => notify),
      );
  });

  const setAccess = Effect.fn("BotStore.setAccess")(function* (
    threadId: ThreadId,
    access: BotAccess,
  ) {
    const encoded = yield* encodeAccess(access).pipe(Effect.mapError(unavailable));
    const rows = yield* sql<{ readonly thread_id: string }>`
      UPDATE bot_profiles SET access_json = ${encoded} WHERE thread_id = ${threadId} RETURNING thread_id
    `.pipe(Effect.mapError(unavailable));
    if (rows.length === 0) return yield* new BotError({ reason: "not_found" });
    yield* notify;
  });

  const history = Effect.fn("BotStore.history")(function* (threadId: ThreadId) {
    return yield* sql<ProfileRow>`
      ${select}
      WHERE bot.thread_id = ${threadId}
      ORDER BY version.revision DESC
    `.pipe(Effect.flatMap(decodeRows), Effect.mapError(unavailable));
  });

  return BotStore.of({
    find,
    create,
    update,
    setState,
    history,
    setAccess,
    subscribe: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(list()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(list)),
          );
        }),
      ),
  });
});

export const layer = Layer.effect(BotStore, make);
