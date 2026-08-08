import * as NodeOS from "node:os";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";

export interface ForgejoCredential {
  readonly host: string;
  readonly type: string;
  readonly name: string;
  readonly token: string;
}

export interface ForgejoKeyStoreShape {
  readonly listHosts: Effect.Effect<ReadonlyArray<string>>;
  readonly getCredential: (host: string) => Effect.Effect<ForgejoCredential | null>;
  readonly authHeader: (credential: ForgejoCredential) => readonly [string, string];
}

export class ForgejoKeyStore extends Context.Service<ForgejoKeyStore, ForgejoKeyStoreShape>()(
  "t3/sourceControl/ForgejoKeyStore",
) {}

export const defaultKeysPath = Effect.fn("defaultKeysPath")(function* () {
  const { join } = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;
  const home = NodeOS.homedir();
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Cyborus.forgejo-cli", "keys.json");
  }
  if (platform === "win32") {
    const base = env["APPDATA"] ?? join(home, "AppData", "Roaming");
    return join(base, "Cyborus", "forgejo-cli", "data", "keys.json");
  }
  const base = env["XDG_DATA_HOME"] ?? join(home, ".local", "share");
  return join(base, "forgejo-cli", "keys.json");
});

export function parseKeysFile(content: string): Map<string, ForgejoCredential> {
  const store = new Map<string, ForgejoCredential>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return store;
  }
  const hosts = (parsed as { hosts?: unknown } | null)?.hosts;
  if (hosts === null || typeof hosts !== "object") return store;
  for (const [rawHost, rawEntry] of Object.entries(hosts as Record<string, unknown>)) {
    if (rawEntry === null || typeof rawEntry !== "object") continue;
    const token = (rawEntry as { token?: unknown }).token;
    if (typeof token !== "string" || token.trim().length === 0) continue;
    const type = (rawEntry as { type?: unknown }).type;
    const name = (rawEntry as { name?: unknown }).name;
    const host = rawHost.trim().toLowerCase();
    if (host.length === 0) continue;
    store.set(host, {
      host,
      token,
      type: typeof type === "string" ? type : "",
      name: typeof name === "string" ? name : "",
    });
  }
  return store;
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const overridePath = yield* Config.string("T3CODE_FORGEJO_KEYS_PATH").pipe(Config.option);
  const keysPath = Option.isSome(overridePath) ? overridePath.value : yield* defaultKeysPath();

  const readStore = fileSystem
    .readFileString(keysPath)
    .pipe(
      Effect.map(parseKeysFile),
      Effect.orElseSucceed(() => new Map<string, ForgejoCredential>()),
    );

  return ForgejoKeyStore.of({
    listHosts: readStore.pipe(Effect.map((store) => Array.from(store.keys()))),
    getCredential: (host) =>
      readStore.pipe(
        Effect.map((store) => {
          // Remote URLs may carry a `:port`, but `fj` keys keys.json by bare hostname.
          // Try the exact host first, then fall back to the port-stripped hostname.
          const wanted = host.trim().toLowerCase();
          return store.get(wanted) ?? store.get(wanted.replace(/:\d+$/u, "")) ?? null;
        }),
      ),
    authHeader: (credential) =>
      /oauth/iu.test(credential.type)
        ? (["Authorization", `Bearer ${credential.token}`] as const)
        : (["Authorization", `token ${credential.token}`] as const),
  });
});

export const layer = Layer.effect(ForgejoKeyStore, make);
