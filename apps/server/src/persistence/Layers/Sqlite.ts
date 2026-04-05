import { Effect, Layer } from "effect";
import { ServerConfig } from "../../config.ts";
import { makeSqlitePersistenceLive } from "./Sqlite.shared";

export const layerConfig = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ dbPath }) => makeSqlitePersistenceLive(dbPath)),
);
