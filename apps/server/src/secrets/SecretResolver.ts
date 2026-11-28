import * as SecretResolverCore from "@t3tools/secret-provider-core/server/SecretResolver";
import {
  LOCAL_VAULT_PROVIDER,
  parseLocalVaultReference,
  type ServerSettings,
  type SecretReference,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { BUILT_IN_SECRET_PROVIDER_DRIVER_LIST } from "./secretProviderDefinitions.ts";
import * as Settings from "../serverSettings.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { readVaultRecord } from "./LocalVault.ts";
import { authorizeVaultUse } from "./VaultAccess.ts";

export const readLocalVaultToken = Effect.fn("LocalVault.readToken")(function* (
  store: ServerSecretStore["Service"] | undefined,
  reference: SecretReference,
) {
  const parsed = parseLocalVaultReference(reference.reference);
  if (reference.provider !== LOCAL_VAULT_PROVIDER || !parsed || parsed.field !== "token")
    return undefined;
  const permitted = yield* authorizeVaultUse(store, parsed.name, "provider").pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!permitted) return undefined;
  const record = yield* readVaultRecord(store, parsed.name);
  return record?.kind === "token" ? record.token : undefined;
});

export const layer = Layer.effect(
  SecretResolverCore.SecretResolver,
  Effect.gen(function* () {
    const serverSettings = yield* Settings.ServerSettingsService;
    const store = Option.getOrUndefined(yield* Effect.serviceOption(ServerSecretStore));
    const base = yield* SecretResolverCore.make({
      drivers: BUILT_IN_SECRET_PROVIDER_DRIVER_LIST,
      secretProviders: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.secretProviders),
        Effect.orElseSucceed((): ServerSettings["secretProviders"] => ({})),
      ),
    });
    return SecretResolverCore.SecretResolver.of({
      read: Effect.fn("HyakkiSecretResolver.read")((references, options) =>
        Effect.forEach(references, (reference) =>
          reference.provider === LOCAL_VAULT_PROVIDER
            ? readLocalVaultToken(store, reference)
            : base.read([reference], options).pipe(Effect.map((values) => values[0])),
        ),
      ),
      invalidate: base.invalidate,
      label: Effect.fn("HyakkiSecretResolver.label")((provider) =>
        provider === LOCAL_VAULT_PROVIDER ? Effect.succeed("Hyakki vault") : base.label(provider),
      ),
    });
  }),
);
