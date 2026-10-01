import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Electron from "electron";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { MacPermissionHelper } from "./MacPermissionHelper.ts";
import type { MacPermission } from "./MacPermission.ts";

export class MacPermissions extends Context.Service<
  MacPermissions,
  {
    readonly showHelper: (
      permission: MacPermission,
      owner: Electron.BrowserWindow | null,
      isGranted?: () => boolean | Promise<boolean>,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/permissions/MacPermissions") {}

export const layer = Layer.effect(
  MacPermissions,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const path = yield* Path.Path;
    const helper = new MacPermissionHelper();
    yield* Effect.addFinalizer(() => Effect.sync(() => helper.close()));
    return MacPermissions.of({
      showHelper: Effect.fn("MacPermissions.showHelper")(function* (permission, owner, isGranted) {
        if (environment.platform !== "darwin" || !environment.isPackaged) return;
        yield* Effect.tryPromise(() =>
          helper.show(
            permission,
            path.join(environment.dirname, "mac-permission-preload.cjs"),
            owner,
            environment.resolveResourcePathCandidates("icon.png"),
            isGranted,
          ),
        ).pipe(
          Effect.catch((cause) => Effect.logWarning("Could not show permission helper", cause)),
        );
      }),
    });
  }),
);
