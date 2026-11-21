import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as AntigravityInstallation from "../../../provider/AntigravityInstallation.ts";

export const layerInstallation = AntigravityInstallation.AntigravityInstallation.layer;

export const installationChanges = Effect.map(
  AntigravityInstallation.AntigravityInstallation,
  (installation) =>
    installation.changes.pipe(
      Stream.changesWith((previous, next) => previous.installedVersion === next.installedVersion),
      Stream.drop(1),
    ),
);
