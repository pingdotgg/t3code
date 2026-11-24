import { type KompasError, MEMORY_LIMITS, type MemoryEntry, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { KompasDatabase, kompasError, storageError } from "./KompasDatabase.ts";
import { KompasSettingsStore } from "./KompasSettingsStore.ts";

export interface MemoryAuthor {
  readonly model: string | null;
  readonly threadId: ThreadId | null;
}

export type MemoryChange =
  | { readonly action: "add"; readonly scope: string; readonly text: string }
  | { readonly action: "patch"; readonly scope: string; readonly id: string; readonly text: string }
  | { readonly action: "remove"; readonly scope: string; readonly id: string };

/** A model's change as it landed; `proposed` while the user still has to approve it. */
export interface MemoryChangeResult {
  readonly entry: MemoryEntry;
  readonly status: "saved" | "proposed" | "removed";
  readonly usage: string;
}

export class MemoryService extends Context.Service<
  MemoryService,
  {
    readonly list: Effect.Effect<ReadonlyArray<MemoryEntry>, KompasError>;
    /** A model's change. Over the limit, it fails with the usage and entries to merge or remove. */
    readonly applyFromModel: (
      change: MemoryChange,
      author: MemoryAuthor,
    ) => Effect.Effect<MemoryChangeResult, KompasError>;
    readonly saveFromUser: (input: {
      readonly id?: string;
      readonly scope: string;
      readonly text: string;
    }) => Effect.Effect<void, KompasError>;
    readonly remove: (id: string) => Effect.Effect<void, KompasError>;
    readonly resolve: (input: {
      readonly id: string;
      readonly approve: boolean;
    }) => Effect.Effect<void, KompasError>;
    readonly removeScope: (scope: string) => Effect.Effect<void, KompasError>;
    /** The memory a new session starts with, as one block of data. */
    readonly promptBlock: (workstreamId: string | null) => Effect.Effect<string, KompasError>;
  }
>()("t3/kompas/MemoryService") {}

export const projectScope = (workstreamId: string) => `project:${workstreamId}`;

const limitOf = (scope: string) =>
  scope === "user" || scope === "notes" ? MEMORY_LIMITS[scope] : MEMORY_LIMITS.project;

const usedBy = (entries: ReadonlyArray<MemoryEntry>) =>
  entries.reduce((total, entry) => total + entry.text.length, 0);

const usageOf = (scope: string, entries: ReadonlyArray<MemoryEntry>) => {
  const used = usedBy(entries);
  const limit = limitOf(scope);
  return `${Math.round((used / limit) * 100)}%, ${used} of ${limit} characters`;
};

const entryLines = (entries: ReadonlyArray<MemoryEntry>) =>
  entries.map((entry) => `- [${entry.id}] ${entry.text}`).join("\n");

// Saved text stays inside its line of its block: it can neither close the tag nor add a heading.
const asData = (text: string) => text.replaceAll("<", "&lt;").replaceAll(/\s*\n\s*/g, " ");
const promptLines = (entries: ReadonlyArray<MemoryEntry>) =>
  entries.map((entry) => `- [${entry.id}] ${asData(entry.text)}`).join("\n");

const SECTION_TITLES = { user: "User profile", notes: "Assistant notes" } as const;

interface MemoryRow {
  readonly entry_id: string;
  readonly scope: string;
  readonly text: string;
  readonly status: string;
  readonly replaces_id: string | null;
  readonly model: string | null;
  readonly thread_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const toEntry = (row: MemoryRow): MemoryEntry => ({
  id: row.entry_id,
  scope: row.scope,
  text: row.text,
  status: row.status === "proposed" ? "proposed" : "saved",
  replacesId: row.replaces_id,
  model: row.model,
  threadId: row.thread_id === null ? null : ThreadId.make(row.thread_id),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const database = yield* KompasDatabase;
  const settings = yield* KompasSettingsStore;
  // One writer: two threads must not both fit under the limit the other used up.
  const writer = yield* Semaphore.make(1);
  const serialized = writer.withPermits(1);

  const list = sql<MemoryRow>`SELECT * FROM kompas_memory_entries ORDER BY created_at`.pipe(
    Effect.map((rows) => rows.map(toEntry)),
    Effect.mapError(storageError),
    Effect.withSpan("MemoryService.list"),
  );
  const savedIn = (scope: string) =>
    Effect.map(list, (entries) =>
      entries.filter((entry) => entry.scope === scope && entry.status === "saved"),
    );
  const find = Effect.fn("MemoryService.find")(function* (id: string) {
    const entry = (yield* list).find((candidate) => candidate.id === id);
    return entry ?? (yield* kompasError("not-found", "This memory entry no longer exists."));
  });

  const write = (entry: MemoryEntry) =>
    sql`
      INSERT INTO kompas_memory_entries
        (entry_id, scope, text, status, replaces_id, model, thread_id, created_at, updated_at)
      VALUES (
        ${entry.id}, ${entry.scope}, ${entry.text}, ${entry.status}, ${entry.replacesId},
        ${entry.model}, ${entry.threadId}, ${entry.createdAt}, ${entry.updatedAt}
      )
      ON CONFLICT (entry_id) DO UPDATE SET
        text = excluded.text, status = excluded.status, replaces_id = excluded.replaces_id,
        model = excluded.model, thread_id = excluded.thread_id, updated_at = excluded.updated_at
    `.pipe(Effect.mapError(storageError), Effect.andThen(database.notifyChanged));

  const deleteEntry = (id: string) =>
    sql`DELETE FROM kompas_memory_entries WHERE entry_id = ${id} OR replaces_id = ${id}`.pipe(
      Effect.mapError(storageError),
      Effect.andThen(database.notifyChanged),
    );

  const requireRoom = Effect.fn("MemoryService.requireRoom")(function* (
    scope: string,
    text: string,
    replacesId: string | null,
  ) {
    const entries = yield* savedIn(scope);
    const others = entries.filter((entry) => entry.id !== replacesId);
    if (usedBy(others) + text.length <= limitOf(scope)) return;
    return yield* kompasError(
      "limit",
      `Memory "${scope}" is full (${usageOf(scope, entries)}) and this entry needs ${text.length} characters. Merge or remove entries first, then retry:\n${entryLines(entries)}`,
    );
  });

  const applyFromModel: MemoryService["Service"]["applyFromModel"] = Effect.fn(
    "MemoryService.applyFromModel",
  )(function* (change, author) {
    const now = yield* database.now;
    const existing = change.action === "add" ? null : yield* find(change.id);
    if (existing !== null && existing.scope !== change.scope) {
      return yield* kompasError("not-found", `Entry ${existing.id} is not in "${change.scope}".`);
    }
    const text = change.action === "remove" ? "" : change.text.trim();
    if (change.action !== "remove") {
      if (text.length === 0) return yield* kompasError("invalid", "An entry needs text.");
      yield* requireRoom(change.scope, text, existing?.id ?? null);
    }
    const propose = (yield* settings.get).memoryAskBeforeSaving;
    const entry: MemoryEntry = {
      id: propose || existing === null ? (yield* database.newId).slice(0, 8) : existing.id,
      scope: change.scope,
      text,
      status: propose ? "proposed" : "saved",
      replacesId: propose ? (existing?.id ?? null) : null,
      model: author.model,
      threadId: author.threadId,
      createdAt: !propose && existing !== null ? existing.createdAt : now,
      updatedAt: now,
    };
    if (!propose && change.action === "remove") yield* deleteEntry(entry.id);
    else yield* write(entry);
    const result: MemoryChangeResult = {
      entry:
        change.action === "remove" && existing !== null ? { ...entry, text: existing.text } : entry,
      status: propose ? "proposed" : change.action === "remove" ? "removed" : "saved",
      usage: usageOf(change.scope, yield* savedIn(change.scope)),
    };
    return result;
  }, serialized);

  const saveFromUser: MemoryService["Service"]["saveFromUser"] = Effect.fn(
    "MemoryService.saveFromUser",
  )(function* (input) {
    const now = yield* database.now;
    const existing = input.id === undefined ? null : yield* find(input.id);
    yield* requireRoom(input.scope, input.text, existing?.id ?? null);
    yield* write({
      id: existing?.id ?? (yield* database.newId).slice(0, 8),
      scope: existing?.scope ?? input.scope,
      text: input.text,
      status: "saved",
      replacesId: null,
      model: null,
      threadId: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }, serialized);

  const resolve: MemoryService["Service"]["resolve"] = Effect.fn("MemoryService.resolve")(
    function* (input) {
      const proposal = yield* find(input.id);
      if (proposal.status !== "proposed") return;
      if (!input.approve) return yield* deleteEntry(proposal.id);
      if (proposal.text.length === 0) {
        return yield* deleteEntry(proposal.replacesId ?? proposal.id);
      }
      yield* requireRoom(proposal.scope, proposal.text, proposal.replacesId);
      if (proposal.replacesId === null) {
        return yield* write({ ...proposal, status: "saved", updatedAt: yield* database.now });
      }
      const replaced = yield* find(proposal.replacesId);
      yield* write({
        ...replaced,
        text: proposal.text,
        model: proposal.model,
        threadId: proposal.threadId,
        updatedAt: yield* database.now,
      });
      yield* deleteEntry(proposal.id);
    },
    serialized,
  );

  const remove = Effect.fn("MemoryService.remove")((id: string) => deleteEntry(id), serialized);

  const removeScope = Effect.fn("MemoryService.removeScope")(
    (scope: string) =>
      sql`DELETE FROM kompas_memory_entries WHERE scope = ${scope}`.pipe(
        Effect.mapError(storageError),
        Effect.andThen(database.notifyChanged),
      ),
    serialized,
  );

  const promptBlock = Effect.fn("MemoryService.promptBlock")(function* (
    workstreamId: string | null,
  ) {
    const saved = (yield* list).filter((entry) => entry.status === "saved");
    const section = (scope: string, title: string) => {
      const entries = saved.filter((entry) => entry.scope === scope);
      return `## ${title} (${usageOf(scope, entries)})\n${entries.length === 0 ? "(empty)" : promptLines(entries)}`;
    };
    const sections = [
      section("user", SECTION_TITLES.user),
      section("notes", SECTION_TITLES.notes),
      ...(workstreamId === null ? [] : [section(projectScope(workstreamId), "Project memory")]),
    ];
    return `<user-memory>\n${sections.join("\n\n")}\n</user-memory>`;
  });

  return MemoryService.of({
    list,
    applyFromModel,
    saveFromUser,
    remove,
    resolve,
    removeScope,
    promptBlock,
  });
});

export const layer = Layer.effect(MemoryService, make);
