import { ManagedCloudSandboxContext } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import { CloudSandboxManagerError } from "./CloudSandboxStore.ts";

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(ManagedCloudSandboxContext));
export const readManagedCloudSandboxContext = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const file = path.join(config.baseDir, "managed-cloud.json");
  if (!(yield* fs.exists(file))) return Option.none();
  return Option.some(yield* fs.readFileString(file).pipe(Effect.flatMap(decode)));
}).pipe(Effect.mapError((cause) => new CloudSandboxManagerError({ reason: "storage", cause })));
