// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Local hosted-image store service, adapted from Miniflare's images plugin
 * (`workers-sdk/packages/miniflare/src/plugins/images/index.ts`), which
 * reuses the KV namespace Durable Object (`worker:kv/namespace`) as the
 * hosted-image key-value backend (`images:ns` / `images:ns:data`). This port
 * does the same: the store service re-exports {@link KVNamespaceObject} from
 * the KV simulator, backed by its own `images:storage` disk service so hosted
 * images never mix with user KV data.
 *
 * Every images binding shares one fixed namespace ({@link IMAGES_STORE_NAMESPACE}),
 * mirroring Miniflare's single `"images-data"` namespace.
 */
import { KVNamespaceObject } from "../kv-namespace/KvNamespace.worker.ts";
import {
  BINDING_KV_OBJECT,
  HEADER_KV_NAMESPACE,
} from "../kv-namespace/KvNamespaceOptions.shared.ts";
import { IMAGES_STORE_NAMESPACE } from "./ImagesOptions.shared.ts";

interface Env {
  [BINDING_KV_OBJECT]: DurableObjectNamespace;
}

export { KVNamespaceObject };

export default {
  fetch(request, env) {
    const stub = env[BINDING_KV_OBJECT].getByName(IMAGES_STORE_NAMESPACE);
    const headers = new Headers(request.headers);
    headers.set(
      HEADER_KV_NAMESPACE,
      encodeURIComponent(IMAGES_STORE_NAMESPACE),
    );
    return stub.fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;
