import type {
  AcpRegistrySettings,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../../atomicWrite.ts";

const decodeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ binding: Schema.String, authenticated: Schema.Boolean })),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const hash = Effect.fn("AcpRegistryAuthenticationState.hash")(function* (value: unknown) {
  const crypto = yield* Crypto.Crypto;
  const json = yield* encodeJson(value).pipe(Effect.orDie);
  const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(json)).pipe(Effect.orDie);
  return Hex.encode(digest);
});

/** Remember explicit sign-in success, never discovery success or the agent's credentials. */
export const makeAcpRegistryAuthenticationState = Effect.fn("makeAcpRegistryAuthenticationState")(
  function* (input: {
    readonly cacheDir: string;
    readonly instanceId: ProviderInstanceId;
    readonly settings: AcpRegistrySettings;
    readonly environment: ProviderInstanceEnvironment;
    readonly processEnvironment: NodeJS.ProcessEnv;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(input.cacheDir, `acp-auth-${yield* hash(input.instanceId)}.json`);
    // Cosmetic settings and model discovery can rebuild the driver without
    // changing the account. Credential overrides and profile paths cannot.
    const binding = yield* hash({
      ...(input.settings.source === "local"
        ? { source: "local", commandArgs: input.settings.commandArgs }
        : {}),
      agentId: input.settings.agentId,
      commandPath: input.settings.commandPath,
      distribution: input.settings.distribution,
      authMethodId: input.settings.authMethodId,
      environment: [...input.environment].toSorted((a, b) => a.name.localeCompare(b.name)),
      profiles: [
        "HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "APPDATA",
        "LOCALAPPDATA",
      ].map((name) => input.processEnvironment[name] ?? null),
    });
    const saved = yield* fs.readFileString(filePath).pipe(
      Effect.flatMap(decodeState),
      Effect.orElseSucceed(() => undefined),
    );
    const confirmed = yield* Ref.make(saved?.binding === binding && saved.authenticated);
    const lock = yield* Semaphore.make(1);
    const persist = (authenticated: boolean) =>
      writeFileStringAtomically({
        filePath,
        contents: JSON.stringify({ binding, authenticated }),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.tapError(() => Effect.logWarning("Could not save ACP sign-in confirmation.")),
        Effect.ignore,
      );
    if (saved && saved.binding !== binding) yield* persist(false);
    return {
      get: Ref.get(confirmed),
      set: (authenticated: boolean) =>
        lock.withPermit(
          Ref.set(confirmed, authenticated).pipe(Effect.andThen(persist(authenticated))),
        ),
    };
  },
);
