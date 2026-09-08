// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Local Secrets Store store service, adapted from Miniflare's secrets-store
 * plugin (`workers-sdk/packages/miniflare/src/plugins/secret-store/index.ts`),
 * which reuses the KV namespace Durable Object (`worker:kv/namespace`) as the
 * per-store key-value backend. This port does the same: the store service
 * re-exports {@link KVNamespaceObject} from the KV simulator, backed by its
 * own `secrets-store:storage` disk service so secrets never mix with user KV
 * data.
 *
 * A single `secrets-store` service hosts every store. The store id arrives
 * either on the designator props (`ctx.props.storeId` — the admin/seeding
 * path binds a store as a raw KV namespace) or, for the secret entrypoint
 * service's plain `STORE` service binding (whose designator carries no
 * props), on the namespace header the entrypoint sets itself.
 */
import { KVNamespaceObject } from "../kv-namespace/KvNamespace.worker.ts";
import {
  BINDING_KV_OBJECT,
  HEADER_KV_NAMESPACE,
} from "../kv-namespace/KvNamespaceOptions.shared.ts";
import type { SecretsStoreStoreServiceProps } from "./SecretsStoreOptions.shared.ts";

interface Env {
  [BINDING_KV_OBJECT]: DurableObjectNamespace;
}

export { KVNamespaceObject };

export default {
  async fetch(request, env, ctx) {
    const props = (ctx as { props?: SecretsStoreStoreServiceProps }).props;
    const encodedHeader = request.headers.get(HEADER_KV_NAMESPACE);
    const storeId =
      props?.storeId ??
      (encodedHeader !== null ? decodeURIComponent(encodedHeader) : undefined);
    if (storeId === undefined) {
      return new Response("Missing Secrets Store id", { status: 400 });
    }
    const stub = env[BINDING_KV_OBJECT].getByName(storeId);
    const headers = new Headers(request.headers);
    headers.set(HEADER_KV_NAMESPACE, encodeURIComponent(storeId));
    return stub.fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;
