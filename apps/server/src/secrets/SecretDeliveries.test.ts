import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ServerConfig from "../config.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { NodeId, RunId, ThreadId, type OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretDeliveries from "./SecretDeliveries.ts";

const decodeMetadata = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

class RecordingFailure extends Schema.TaggedError<RecordingFailure>()("RecordingFailure", {}) {}

const setup = (realStore = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const filePath = `${directory}/input`;
    const value = "\uFEFF  synthetic-only\nPEM body\n\n";
    yield* fs.writeFileString(filePath, value, { mode: 0o600 });
    const stored = new Map<string, Uint8Array>();
    const commands: Array<OrchestrationV2ServerCommand> = [];
    const state = { failRecord: false, deletedThread: false };
    const real = realStore
      ? Context.get(
          yield* Layer.build(
            ServerSecretStore.layer.pipe(
              Layer.provide(
                ServerConfig.layerTest(process.cwd(), { prefix: "delivery-recovery-" }),
              ),
              Layer.provide(NodeCrypto.layer),
            ),
          ),
          ServerSecretStore.ServerSecretStore,
        )
      : undefined;
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      real
        ? Layer.succeed(ServerSecretStore.ServerSecretStore, real)
        : Layer.mock(ServerSecretStore.ServerSecretStore)({
            directory,
            get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
            create: (name, bytes) => Effect.sync(() => void stored.set(name, bytes)),
            set: (name, bytes) => Effect.sync(() => void stored.set(name, bytes)),
          }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        dispatch: (command) =>
          Effect.sync(() => {
            if (state.failRecord) throw new Error("publication interrupted");
            commands.push(command);
            return { sequence: 1 };
          }).pipe(Effect.catchDefect(() => Effect.fail(new RecordingFailure({})))) as never,
        getThreadRecords: () =>
          Effect.sync(() => ({
            thread: { deletedAt: state.deletedThread ? 1 : null },
            turnItems: commands.flatMap((command) =>
              command.type === "secret_delivery.record"
                ? [
                    {
                      id: command.turnItemId,
                      threadId: command.threadId,
                      type: "secret_delivery",
                      secretStatus: command.secretStatus,
                    },
                  ]
                : [],
            ),
          })) as never,
      }),
    );
    const service = yield* SecretDeliveries.SecretDeliveries.pipe(
      Effect.provide(SecretDeliveries.layer.pipe(Layer.provide(dependencies))),
    );
    const input = {
      filePath,
      label: "Synthetic credential",
      clientRequestId: "retry-1",
      threadId: ThreadId.make("original"),
      runId: RunId.make("run"),
      nodeId: NodeId.make("node"),
    };
    return { service, input, commands, stored, state, fs, value, dependencies, real };
  });

it.effect(
  "preserves exact text and source, publishes metadata only, retries without reading the source, and denies forks",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { service, input, value, fs, commands, state } = yield* setup();
        const receipt = yield* service.publish(input);
        const target = { threadId: input.threadId, deliveryId: receipt.deliveryId };
        assert.equal((yield* service.read(target)).value, value);
        assert.equal((yield* service.read(target)).value, value);
        assert.deepEqual(yield* fs.readFile(input.filePath), new TextEncoder().encode(value));
        assert.isFalse(JSON.stringify(commands).includes("synthetic-only"));
        yield* fs.remove(input.filePath);
        assert.deepEqual(yield* service.publish(input), receipt);
        assert.equal(
          (yield* service.read({ ...target, threadId: ThreadId.make("fork") }).pipe(Effect.flip))
            .reason,
          "unavailable",
        );
        state.deletedThread = true;
        assert.equal((yield* service.read(target).pipe(Effect.flip)).reason, "unavailable");
        state.deletedThread = false;
        yield* service.delete(target);
        assert.equal((yield* service.read(target).pipe(Effect.flip)).reason, "unavailable");
        assert.equal((yield* service.publish(input)).status, "deleted");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "recovers publication failure across restart and enforces the fixed deadline on every read",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { service, input, state, fs, dependencies, stored } = yield* setup();
        state.failRecord = true;
        assert.equal((yield* service.publish(input).pipe(Effect.flip)).reason, "record_failed");
        yield* fs.remove(input.filePath);
        state.failRecord = false;
        const restarted = yield* SecretDeliveries.SecretDeliveries.pipe(
          Effect.provide(SecretDeliveries.layer.pipe(Layer.provide(dependencies))),
        );
        const receipt = yield* restarted.publish(input);
        const target = { threadId: input.threadId, deliveryId: receipt.deliveryId };
        yield* restarted.read(target);
        yield* TestClock.adjust("24 hours");
        assert.equal((yield* restarted.read(target).pipe(Effect.flip)).reason, "unavailable");
        assert.equal((yield* restarted.publish(input)).status, "expired");
        assert.isFalse(
          [...stored.values()].some((bytes) =>
            new TextDecoder().decode(bytes).includes("synthetic-only"),
          ),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects symlinks, public files, oversized text, invalid UTF-8 and directories", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { service, input, fs } = yield* setup();
      const link = `${input.filePath}-link`;
      yield* fs.symlink(input.filePath, link);
      for (const path of [link, input.filePath.slice(0, input.filePath.lastIndexOf("/"))]) {
        assert.equal(
          (yield* service.publish({ ...input, filePath: path }).pipe(Effect.flip)).reason,
          "invalid_file",
        );
      }
      const directoryLink = `${input.filePath}-directory`;
      yield* fs.symlink(input.filePath.slice(0, input.filePath.lastIndexOf("/")), directoryLink);
      assert.equal(
        (yield* service.publish({ ...input, filePath: `${directoryLink}/input` }).pipe(Effect.flip))
          .reason,
        "invalid_file",
      );
      const canonical = yield* fs.realPath(`${directoryLink}/input`);
      assert.equal(
        (yield* service.publish({ ...input, filePath: canonical, clientRequestId: "canonical" }))
          .status,
        "available",
      );
      yield* fs.chmod(input.filePath, 0o644);
      assert.equal((yield* service.publish(input).pipe(Effect.flip)).reason, "invalid_file");
      yield* fs.chmod(input.filePath, 0o600);
      for (const bytes of [new Uint8Array(0), new Uint8Array(65537), new Uint8Array([0xff])]) {
        yield* fs.writeFile(input.filePath, bytes);
        assert.equal((yield* service.publish(input).pipe(Effect.flip)).reason, "invalid_file");
      }
      yield* fs.writeFileString(input.filePath, "x".repeat(65536));
      const receipt = yield* service.publish(input);
      assert.equal(
        (yield* service.read({ threadId: input.threadId, deliveryId: receipt.deliveryId })).value
          .length,
        65536,
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("serializes duplicate publication and deletion so retries never resurrect a value", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { service, input } = yield* setup();
      const [first, duplicate] = yield* Effect.all(
        [service.publish(input), service.publish(input)],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(first, duplicate);
      const target = { threadId: input.threadId, deliveryId: first.deliveryId };
      yield* Effect.all([service.delete(target), service.publish(input)], {
        concurrency: "unbounded",
      });
      assert.equal((yield* service.publish(input)).status, "deleted");
      assert.equal((yield* service.read(target).pipe(Effect.flip)).reason, "unavailable");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "startup recovers real store records and removes crash-leftover values before serving",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { service, input, commands, state, fs, real, dependencies } = yield* setup(true);
        state.failRecord = true;
        assert.equal((yield* service.publish(input).pipe(Effect.flip)).reason, "record_failed");
        const directory = real!.directory!;
        const [name] = yield* fs.readDirectory(directory);
        const final = `${directory}/${name}`;
        const beforeLink = ServerSecretStore.temporarySecretPath(
          `${directory}/secret-delivery-${"b".repeat(64)}.bin`,
          "11111111-1111-4111-8111-111111111111",
        );
        const afterLink = ServerSecretStore.temporarySecretPath(
          final,
          "22222222-2222-4222-8222-222222222222",
        );
        yield* fs.copyFile(final, beforeLink);
        yield* fs.link(final, afterLink);
        state.failRecord = false;
        const restarted = yield* SecretDeliveries.SecretDeliveries.pipe(
          Effect.provide(SecretDeliveries.layer.pipe(Layer.provide(dependencies))),
        );
        assert.equal(commands.length, 1);
        assert.deepEqual(yield* fs.readDirectory(directory), [name]);
        const command = commands[0]!;
        assert.equal(command.type, "secret_delivery.record");
        if (command.type !== "secret_delivery.record") return;
        const target = { threadId: input.threadId, deliveryId: command.turnItemId };
        assert.equal((yield* restarted.read(target)).value.includes("synthetic-only"), true);
        state.failRecord = true;
        assert.equal((yield* restarted.delete(target).pipe(Effect.flip)).reason, "record_failed");
        state.failRecord = false;
        yield* SecretDeliveries.SecretDeliveries.pipe(
          Effect.provide(SecretDeliveries.layer.pipe(Layer.provide(dependencies))),
        );
        const recovered = commands.at(-1);
        assert.equal(
          recovered?.type === "secret_delivery.record" && recovered.secretStatus,
          "deleted",
        );
        assert.equal((yield* service.publish(input)).status, "deleted");
        const tombstone = decodeMetadata(JSON.parse(yield* fs.readFileString(final)));
        yield* fs.writeFileString(
          final,
          JSON.stringify({
            ...tombstone,
            status: "available",
            value: "synthetic-only-expired",
            expiresAt: 0,
          }),
        );
        state.deletedThread = true;
        const recorded = commands.length;
        yield* SecretDeliveries.SecretDeliveries.pipe(
          Effect.provide(SecretDeliveries.layer.pipe(Layer.provide(dependencies))),
        );
        assert.equal(commands.length, recorded);
        assert.equal(decodeMetadata(JSON.parse(yield* fs.readFileString(final))).status, "expired");
        for (const file of yield* fs.readDirectory(directory)) {
          assert.isFalse(
            (yield* fs.readFileString(`${directory}/${file}`)).includes("synthetic-only"),
          );
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
