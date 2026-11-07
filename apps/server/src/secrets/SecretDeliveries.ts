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
const encode = Schema.encodeEffect(Stored);
const decode = Schema.decodeUnknownEffect(Stored);
const storageError = () => new SecretDeliveryError({ reason: "storage_failed" });
const nameFor = (id: string) => `secret-delivery-${id}`;

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
  const load = Effect.fn("SecretDeliveries.load")(function* (id: string) {
    if (!/^[a-f0-9]{64}$/.test(id))
      return yield* new SecretDeliveryError({ reason: "unavailable" });
    const bytes = yield* store.get(nameFor(id)).pipe(Effect.mapError(storageError));
    if (Option.isNone(bytes)) return yield* new SecretDeliveryError({ reason: "unavailable" });
    return yield* decode(new TextDecoder().decode(bytes.value)).pipe(Effect.mapError(storageError));
  });
  const save = Effect.fn("SecretDeliveries.save")(function* (record: typeof Stored.Type) {
    const text = yield* encode(record);
    yield* store.set(nameFor(record.deliveryId), new TextEncoder().encode(text));
  }, Effect.mapError(storageError));
  const record = Effect.fn("SecretDeliveries.record")(function* (stored: typeof Stored.Type) {
    yield* threads
      .dispatch({
        type: "secret_delivery.record",
        commandId: CommandId.make(`secret-delivery:${stored.deliveryId}:${stored.status}`),
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
  const expire = Effect.fn("SecretDeliveries.expire")(function* (
    stored: typeof Stored.Type,
  ): Effect.fn.Return<typeof Stored.Type, SecretDeliveryError> {
    if (stored.status !== "available" || (yield* Clock.currentTimeMillis) < stored.expiresAt)
      return stored;
    const { value: _value, ...metadata } = stored;
    const expired = { ...metadata, status: "expired" as const };
    yield* save(expired);
    yield* record(expired);
    return expired;
  });
  const authorized = Effect.fn("SecretDeliveries.authorized")(function* (
    input: SecretDeliveryInput,
  ) {
    const stored = yield* load(input.deliveryId);
    if (stored.threadId !== input.threadId)
      return yield* new SecretDeliveryError({ reason: "unavailable" });
    // Resolve only in the original thread, never an inherited fork item.
    const projection = yield* threads
      .getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["secret_delivery"],
        messageRoles: [],
      })
      .pipe(Effect.mapError(() => new SecretDeliveryError({ reason: "unavailable" })));
    if (
      !projection.turnItems.some(
        (item) =>
          item.id === input.deliveryId &&
          item.threadId === input.threadId &&
          item.type === "secret_delivery",
      )
    )
      return yield* new SecretDeliveryError({ reason: "unavailable" });
    return yield* expire(stored);
  });
  const publish: SecretDeliveries["Service"]["publish"] = Effect.fn("SecretDeliveries.publish")(
    function* (input) {
      const id = NodeCrypto.createHash("sha256")
        .update(`${input.threadId.length}:${input.threadId}${input.clientRequestId}`)
        .digest("hex");
      const existing = yield* store.get(nameFor(id)).pipe(Effect.mapError(storageError));
      let stored: typeof Stored.Type;
      if (Option.isSome(existing)) {
        stored = yield* load(id).pipe(Effect.flatMap(expire));
      } else {
        const value = yield* Effect.tryPromise({
          try: async () => {
            const path = NodePath.resolve(input.filePath);
            if (!NodePath.isAbsolute(input.filePath) || (await NodeFSP.realpath(path)) !== path)
              throw new Error();
            const file = await NodeFSP.open(
              path,
              NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
            );
            try {
              const stat = await file.stat();
              if (
                !stat.isFile() ||
                stat.nlink !== 1 ||
                (stat.mode & 0o077) !== 0 ||
                process.getuid === undefined ||
                stat.uid !== process.getuid() ||
                stat.size > 65536
              )
                throw new Error();
              const bytes = Buffer.alloc(65537);
              let size = 0;
              while (size < bytes.length) {
                const result = await file.read(bytes, size, bytes.length - size, null);
                if (result.bytesRead === 0) break;
                size += result.bytesRead;
              }
              const after = await NodeFSP.lstat(path);
              const finished = await file.stat();
              if (
                size > 65536 ||
                finished.size !== stat.size ||
                finished.mtimeMs !== stat.mtimeMs ||
                finished.ctimeMs !== stat.ctimeMs ||
                after.ino !== stat.ino ||
                after.dev !== stat.dev ||
                (await NodeFSP.realpath(path)) !== path
              )
                throw new Error();
              return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
                bytes.subarray(0, size),
              );
            } finally {
              await file.close();
            }
          },
          catch: () => new SecretDeliveryError({ reason: "invalid_file" }),
        });
        stored = {
          threadId: input.threadId,
          runId: input.runId,
          nodeId: input.nodeId,
          deliveryId: id,
          label: input.label,
          expiresAt: (yield* Clock.currentTimeMillis) + 86400000,
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
    if (stored.status !== "available" || stored.value === undefined)
      return yield* new SecretDeliveryError({ reason: "unavailable" });
    return { value: stored.value };
  }, lock.withPermits(1));
  const remove: SecretDeliveries["Service"]["delete"] = Effect.fn("SecretDeliveries.delete")(
    function* (input) {
      const stored = yield* authorized(input);
      const { value: _value, ...metadata } = stored;
      const deleted = { ...metadata, status: "deleted" as const };
      yield* save(deleted);
      yield* record(deleted);
    },
    lock.withPermits(1),
  );
  const sweep = Effect.gen(function* () {
    if (store.directory === undefined) return;
    for (const file of yield* fs.readDirectory(store.directory)) {
      const match = /^secret-delivery-([a-f0-9]{64})\.bin$/.exec(file);
      if (!match?.[1]) continue;
      yield* load(match[1]).pipe(
        Effect.flatMap(expire),
        Effect.flatMap(record),
        Effect.catch(() => Effect.logWarning("Could not recover a secret delivery")),
      );
    }
  }).pipe(
    lock.withPermits(1),
    Effect.catch(() => Effect.logWarning("Could not recover secret deliveries")),
  );
  yield* sweep;
  yield* sweep.pipe(
    Effect.delay("1 hour"),
    Effect.repeat(Schedule.spaced("1 hour")),
    Effect.forkScoped,
  );
  return SecretDeliveries.of({ publish, read, delete: remove });
});
export const layer = Layer.effect(SecretDeliveries, make);
