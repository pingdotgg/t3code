// @effect-diagnostics nodeBuiltinImport:off -- Native open flags and descriptor stat enforce private regular-file input.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  SecretDeliveryError,
  SecretDeliveryStatus,
  TurnItemId,
  ThreadId,
  RunId,
  NodeId,
  type SendSecretInput,
  type SecretDeliveryInput,
  type SecretDeliveryReceipt,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreThreadNotFoundError } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

// Value-free tombstones keep retry keys from recreating deleted or expired deliveries.
const Stored = Schema.fromJsonString(
  Schema.Struct({
    threadId: ThreadId,
    runId: RunId,
    nodeId: NodeId,
    deliveryId: Schema.String,
    label: Schema.String,
    expiresAt: Schema.Number,
    status: SecretDeliveryStatus,
    value: Schema.optionalKey(Schema.String),
  }),
);
type Stored = typeof Stored.Type;
const encode = Schema.encodeEffect(Stored);
const decode = Schema.decodeUnknownEffect(Stored);
const isProjectionError = Schema.is(OrchestratorProjectionError);
const isThreadNotFound = Schema.is(ProjectionStoreThreadNotFoundError);
const storageError = () => new SecretDeliveryError({ reason: "storage_failed" });
const unavailable = () => new SecretDeliveryError({ reason: "unavailable" });
const nameFor = (id: string) => `secret-delivery-${id}`;
const ID_PATTERN = /^[a-f0-9]{64}$/;
const STORE_NAME_PATTERN = /^secret-delivery-([a-f0-9]{64})\.bin$/;
const MAX_BYTES = 65536;
const LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Reads an absolute, owner-private, singly linked regular file as exact UTF-8. Rejects
 * symlinks anywhere in the path, special files, and a file that changes during the read.
 * Fails closed where POSIX ownership is unavailable (Windows).
 */
async function readPrivateFile(filePath: string): Promise<string> {
  const path = NodePath.resolve(filePath);
  if (!NodePath.isAbsolute(filePath) || (await NodeFSP.realpath(path)) !== path) throw new Error();
  const file = await NodeFSP.open(
    path,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 ||
      process.getuid === undefined ||
      before.uid !== process.getuid() ||
      before.size === 0 ||
      before.size > MAX_BYTES
    )
      throw new Error();
    // One spare byte detects a file that grew past the cap after the stat.
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await file.read(bytes, size, bytes.length - size, null);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    const after = await file.stat();
    const linked = await NodeFSP.lstat(path);
    if (
      size > MAX_BYTES ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      linked.ino !== before.ino ||
      linked.dev !== before.dev ||
      (await NodeFSP.realpath(path)) !== path
    )
      throw new Error();
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, size),
    );
  } finally {
    await file.close();
  }
}

export class SecretDeliveries extends Context.Service<
  SecretDeliveries,
  {
    readonly publish: (
      input: SendSecretInput & {
        threadId: ThreadId;
        runId: RunId;
        nodeId: NodeId;
      },
    ) => Effect.Effect<SecretDeliveryReceipt, SecretDeliveryError>;
    readonly read: (
      input: SecretDeliveryInput,
    ) => Effect.Effect<{ value: string }, SecretDeliveryError>;
    readonly delete: (input: SecretDeliveryInput) => Effect.Effect<void, SecretDeliveryError>;
  }
>()("t3/secrets/SecretDeliveries") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const fs = yield* FileSystem.FileSystem;
  const lock = yield* Semaphore.make(1);
  const find = Effect.fn("SecretDeliveries.find")(function* (id: string) {
    const bytes = yield* store.get(nameFor(id));
    if (Option.isNone(bytes)) return Option.none<Stored>();
    return Option.some(yield* decode(new TextDecoder().decode(bytes.value)));
  }, Effect.mapError(storageError));
  const load = Effect.fn("SecretDeliveries.load")(function* (id: string) {
    if (!ID_PATTERN.test(id)) return yield* unavailable();
    const stored = yield* find(id);
    if (Option.isNone(stored)) return yield* unavailable();
    return stored.value;
  });
  const record = Effect.fn("SecretDeliveries.record")(function* (stored: Stored) {
    const projection = yield* threads
      .getThreadRecords(stored.threadId, ["turnItems"], {
        turnItemTypes: ["secret_delivery"],
        messageRoles: [],
      })
      .pipe(
        Effect.mapError((error) =>
          isProjectionError(error) && isThreadNotFound(error.cause)
            ? unavailable()
            : new SecretDeliveryError({ reason: "record_failed" }),
        ),
      );

    if (projection.thread.deletedAt !== null) return yield* unavailable();
    if (
      projection.turnItems.some(
        (item) =>
          item.id === stored.deliveryId &&
          item.type === "secret_delivery" &&
          item.secretStatus === stored.status,
      )
    )
      return;
    yield* threads
      .dispatch({
        type: "secret_delivery.record",
        commandId: CommandId.make(`secret-delivery:${NodeCrypto.randomUUID()}`),
        threadId: stored.threadId,
        runId: stored.runId,
        nodeId: stored.nodeId,
        turnItemId: TurnItemId.make(stored.deliveryId),
        label: stored.label,
        secretStatus: stored.status,
        expiresAt: stored.expiresAt,
      })
      .pipe(Effect.mapError(() => new SecretDeliveryError({ reason: "record_failed" })));
  });
  /** Drops the value for good, keeping the metadata as a tombstone for retries. */
  const retire = Effect.fn("SecretDeliveries.retire")(function* (
    stored: Stored,
    status: "deleted" | "expired",
  ) {
    const { value: _value, ...metadata } = stored;
    const retired = { ...metadata, status };
    const text = yield* encode(retired).pipe(Effect.mapError(storageError));
    yield* store
      .set(nameFor(retired.deliveryId), new TextEncoder().encode(text))
      .pipe(Effect.mapError(storageError));
    yield* record(retired);
    return retired;
  });
  const expire = Effect.fn("SecretDeliveries.expire")(function* (stored: Stored) {
    if (stored.status !== "available" || (yield* Clock.currentTimeMillis) < stored.expiresAt)
      return stored;
    return yield* retire(stored, "expired");
  });
  const authorized = Effect.fn("SecretDeliveries.authorized")(function* (
    input: SecretDeliveryInput,
  ) {
    const stored = yield* load(input.deliveryId);
    // Retrieval must name the original thread.
    if (stored.threadId !== input.threadId) return yield* unavailable();
    // The item must still be in its thread: a deleted thread's delivery is unreadable.
    const projection = yield* threads
      .getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["secret_delivery"],
        messageRoles: [],
      })
      .pipe(Effect.mapError(unavailable));
    if (
      projection.thread.deletedAt !== null ||
      !projection.turnItems.some(
        (item) =>
          item.id === input.deliveryId &&
          item.threadId === input.threadId &&
          item.type === "secret_delivery",
      )
    )
      return yield* unavailable();
    return yield* expire(stored);
  });
  const publish: SecretDeliveries["Service"]["publish"] = Effect.fn("SecretDeliveries.publish")(
    function* (input) {
      const id = NodeCrypto.createHash("sha256")
        .update(`${input.threadId.length}:${input.threadId}${input.clientRequestId}`)
        .digest("hex");
      const existing = yield* find(id);
      let stored: Stored;
      if (Option.isSome(existing)) {
        stored = yield* expire(existing.value);
      } else {
        if (process.getuid === undefined)
          return yield* new SecretDeliveryError({ reason: "unsupported_host" });
        const value = yield* Effect.tryPromise({
          try: () => readPrivateFile(input.filePath),
          catch: () => new SecretDeliveryError({ reason: "invalid_file" }),
        });
        stored = {
          threadId: input.threadId,
          runId: input.runId,
          nodeId: input.nodeId,
          deliveryId: id,
          label: input.label,
          expiresAt: (yield* Clock.currentTimeMillis) + LIFETIME_MS,
          status: "available",
          value,
        };
        const encoded = yield* encode(stored).pipe(Effect.mapError(storageError));
        yield* store
          .create(nameFor(id), new TextEncoder().encode(encoded))
          .pipe(Effect.mapError(storageError));
      }
      yield* record(stored);
      return {
        deliveryId: TurnItemId.make(id),
        status: stored.status,
        expiresAt: stored.expiresAt,
      };
    },
    lock.withPermits(1),
  );
  const read: SecretDeliveries["Service"]["read"] = Effect.fn("SecretDeliveries.read")(function* (
    input,
  ) {
    const stored = yield* authorized(input);
    if (stored.status !== "available" || stored.value === undefined) return yield* unavailable();
    return { value: stored.value };
  }, lock.withPermits(1));
  const remove: SecretDeliveries["Service"]["delete"] = Effect.fn("SecretDeliveries.delete")(
    function* (input) {
      yield* retire(yield* authorized(input), "deleted");
    },
    lock.withPermits(1),
  );
  const sweep = Effect.gen(function* () {
    if (store.directory === undefined) return;
    for (const file of yield* fs.readDirectory(store.directory)) {
      const match = STORE_NAME_PATTERN.exec(file);
      if (!match?.[1]) continue;
      yield* load(match[1]).pipe(
        Effect.flatMap(expire),
        Effect.flatMap(record),
        Effect.catch((error) =>
          error.reason === "unavailable"
            ? Effect.void
            : Effect.logWarning("Could not recover a secret delivery"),
        ),
      );
    }
  }).pipe(
    lock.withPermits(1),
    Effect.catch(() => Effect.logWarning("Could not recover secret deliveries")),
  );
  // The singleton delivery owner has not been published yet: no delivery writer can be active.
  // Only startup removes crash leftovers; hourly sweeps must not race a live store write.
  if (store.directory !== undefined) {
    const directory = store.directory;
    yield* Effect.gen(function* () {
      for (const file of yield* fs.readDirectory(directory)) {
        const target = ServerSecretStore.temporarySecretTarget(file);
        if (target !== undefined && STORE_NAME_PATTERN.test(target)) {
          yield* fs
            .remove(NodePath.join(directory, file))
            .pipe(
              Effect.catch(() => Effect.logWarning("Could not remove a secret delivery leftover")),
            );
        }
      }
    }).pipe(Effect.catch(() => Effect.logWarning("Could not scan secret delivery leftovers")));
  }
  yield* sweep;
  yield* sweep.pipe(
    Effect.delay("1 hour"),
    Effect.repeat(Schedule.spaced("1 hour")),
    Effect.forkScoped,
  );
  return SecretDeliveries.of({ publish, read, delete: remove });
});
export const layer = Layer.effect(SecretDeliveries, make);
