import * as Layer from "effect/Layer";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

export const layerServerSettings = ServerSettings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(ManagedPolicy.layer),
  Layer.provideMerge(SqlitePersistence.layerConfig),
);

export const layerPersistence = Layer.empty.pipe(Layer.provideMerge(SqlitePersistence.layerConfig));
