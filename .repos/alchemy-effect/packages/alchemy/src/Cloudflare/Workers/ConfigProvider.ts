import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import cloudflare_workers from "./cloudflare_workers.ts";

export const WorkerConfigProvider = () =>
  cloudflare_workers.pipe(
    Effect.map(({ env }) => ConfigProvider.fromUnknown(env)),
  );
