// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Local `secrets_store_secret` binding entrypoint, adapted from Miniflare's
 * secret worker
 * (`workers-sdk/packages/miniflare/src/workers/secrets-store/secret.worker.ts`).
 *
 * Miniflare emits one secret service per `{storeId, secretName}` pair with
 * the identity baked into `env`; here a single `secrets-store:secret`
 * service hosts every binding and the identity travels on the service
 * designator props (`ctx.props`), following the one-service-per-binding-type
 * topology used by the other simulators (KV, send-email, ...).
 *
 * `get()` reads the named secret from the store's KV namespace (through the
 * `STORE` service binding into the `secrets-store` service, speaking the KV
 * Durable Object's HTTP protocol) and throws Miniflare's exact error message
 * when the secret doesn't exist.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { HEADER_KV_NAMESPACE } from "../kv-namespace/KvNamespaceOptions.shared.ts";
import type { SecretsStoreSecretServiceProps } from "./SecretsStoreOptions.shared.ts";
import { BINDING_SECRETS_STORE_STORE } from "./SecretsStoreOptions.shared.ts";

interface Env {
  [BINDING_SECRETS_STORE_STORE]: Fetcher;
}

export class SecretsStoreSecret extends WorkerEntrypoint<
  Env,
  SecretsStoreSecretServiceProps
> {
  async get(): Promise<string> {
    const { storeId, secretName } = this.ctx.props;
    const response = await this.env[BINDING_SECRETS_STORE_STORE].fetch(
      `http://placeholder/${encodeURIComponent(secretName)}?urlencoded=true`,
      { headers: { [HEADER_KV_NAMESPACE]: encodeURIComponent(storeId) } },
    );
    if (response.status === 404) {
      // Consume the body so the store's Durable Object call can settle
      // (see cloudflare/workerd#960).
      await response.body?.pipeTo(new WritableStream());
      // Match Miniflare's error message exactly.
      throw new Error(`Secret "${secretName}" not found`);
    }
    if (!response.ok) {
      throw new Error(
        `Secrets Store request failed: ${response.status} ${await response.text()}`,
      );
    }
    return await response.text();
  }
}

export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
