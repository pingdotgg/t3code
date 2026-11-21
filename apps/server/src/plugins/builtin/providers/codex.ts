import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as CodexAdapterV2 from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CodexInstallation from "../../../provider/CodexInstallation.ts";

export type AdapterInfrastructure = CodexAdapterV2.CodexAppServerClientFactory;

export const layerInstallation = CodexInstallation.CodexInstallation.layer;
export const layerAdapterInfrastructure = CodexAdapterV2.layerAppServerClientFactory;

export const installationChanges = Effect.map(CodexInstallation.CodexInstallation, (installation) =>
  installation.changes.pipe(
    Stream.changesWith((previous, next) => previous.installedVersion === next.installedVersion),
    Stream.drop(1),
  ),
);
