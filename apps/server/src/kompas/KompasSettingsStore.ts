import { DEFAULT_KOMPAS_SETTINGS, type KompasError, KompasSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KompasDatabase, storageError } from "./KompasDatabase.ts";

export class KompasSettingsStore extends Context.Service<
  KompasSettingsStore,
  {
    readonly get: Effect.Effect<KompasSettings, KompasError>;
    readonly update: (patch: Partial<KompasSettings>) => Effect.Effect<void, KompasError>;
  }
>()("t3/kompas/KompasSettingsStore") {}

const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(KompasSettings));
const encodeStored = Schema.encodeSync(Schema.fromJsonString(KompasSettings));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const database = yield* KompasDatabase;

  const get = sql<{ readonly settings_json: string }>`
    SELECT settings_json FROM kompas_settings WHERE id = 1
  `.pipe(
    Effect.map((rows) =>
      Option.getOrElse(decodeStored(rows[0]?.settings_json), () => DEFAULT_KOMPAS_SETTINGS),
    ),
    Effect.mapError(storageError),
    Effect.withSpan("KompasSettingsStore.get"),
  );

  const update = Effect.fn("KompasSettingsStore.update")(function* (
    patch: Partial<KompasSettings>,
  ) {
    const next = encodeStored({ ...(yield* get), ...patch });
    yield* sql`
      INSERT INTO kompas_settings (id, settings_json) VALUES (1, ${next})
      ON CONFLICT (id) DO UPDATE SET settings_json = excluded.settings_json
    `.pipe(Effect.mapError(storageError));
    yield* database.notifyChanged;
  });

  return KompasSettingsStore.of({ get, update });
});

export const layer = Layer.effect(KompasSettingsStore, make);
