import type { ToolActivityNativeAppReference } from "@t3tools/contracts";
import { makeNativeAppIconResolver } from "@t3tools/shared/nativeAppIcon";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";

/** Serves native app icons from the environment that owns the tool activity. */
export class NativeAppIconResolver extends Context.Service<
  NativeAppIconResolver,
  { readonly resolve: (app: ToolActivityNativeAppReference) => Effect.Effect<string | null> }
>()("t3/assets/NativeAppIconResolver") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return NativeAppIconResolver.of(
    yield* makeNativeAppIconResolver(path.join(config.providerStatusCacheDir, "native-app-icons")),
  );
});

export const layer = Layer.effect(NativeAppIconResolver, make);
