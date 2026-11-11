import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Schema from "effect/Schema";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as WriterRegistry from "./WriterRegistry.ts";

const encodeWriters = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

// An absent registry must fail deployment rather than revoke every existing writer.
export const WriterSecrets = ConfigProvider.layerAdd(
  Effect.gen(function* () {
    const configured = yield* Config.Redacted("DEVELOPER_KEYS").pipe(Config.option);
    const readers = yield* Config.Redacted("READER_KEYS").pipe(Config.option);
    const fs = yield* FileSystem.FileSystem;
    const readerKeys = Option.isSome(readers)
      ? {}
      : {
          READER_KEYS: yield* fs.readFileString(
            `${yield* Config.String("HOME")}/.config/t3-task-cache/readers.json`,
          ),
        };
    if (Option.isSome(configured)) return ConfigProvider.fromUnknown(readerKeys);
    return ConfigProvider.fromUnknown({
      ...readerKeys,
      DEVELOPER_KEYS: yield* encodeWriters(
        yield* WriterRegistry.WriterRegistry.pipe(
          Effect.flatMap((registry) => registry.read()),
          Effect.provide(WriterRegistry.layer.pipe(Layer.provide(NodeCrypto.layer))),
        ),
      ),
    });
  }),
);
