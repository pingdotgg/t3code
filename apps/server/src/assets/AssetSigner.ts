import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import * as PayloadSigner from "../auth/PayloadSigner.ts";
import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";

/** Signs asset and attachment-upload URLs; both share one key. */
export class AssetSigner extends Context.Service<
  AssetSigner,
  PayloadSigner.PayloadSigner<ServerSecretStore.SecretStoreError>
>()("t3/assets/AssetSigner") {}

export const layer = Layer.effect(AssetSigner, PayloadSigner.make("asset-access-signing-key"));
