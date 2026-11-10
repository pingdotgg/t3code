import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Floci from "./Floci.ts";

/**
 * `alchemy dev` trusts the local AWS emulator's CA bundle, once it has been
 * downloaded, so SDK clients in the dev process and its sidecars accept the
 * emulator's TLS certificate.
 */
export const devEnv = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const hasCa = yield* fs.exists(Floci.FLOCI_CA_PATH).pipe(Effect.orElseSucceed(() => false));
  const env: Record<string, string> = hasCa ? { NODE_EXTRA_CA_CERTS: Floci.FLOCI_CA_PATH } : {};
  return env;
});
