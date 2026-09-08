import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as NodeOs from "node:os";

export const home = Config.string("CLOUDFLARE_RUNTIME_HOME").pipe(
  Effect.orElseSucceed(() => NodeOs.homedir()),
);

export const fileSystemSupportsWatcher = Config.boolean(
  "CLOUDFLARE_RUNTIME_FILE_SYSTEM_SUPPORTS_WATCHER",
).pipe(Effect.orElseSucceed(() => NodeOs.platform() !== "win32"));
