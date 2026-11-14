import { useAtomValue } from "@effect/atom-react";
import {
  type AssetUrlState,
  assetUrlStateFromResult,
  blockedAssetUrlState,
  EMPTY_ASSET_URL_ATOM,
} from "@t3tools/client-runtime/state/assets";
import { AssetResource, type AssetCreateUrlResult, EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { assetEnvironment } from "~/state/assets";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { usePreparedConnection } from "~/state/session";

type AssetUrlTarget = {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly resource: AssetResource };
};

const decodeAssetUrlKey = Schema.decodeUnknownSync(Schema.Tuple([EnvironmentId, AssetResource]));

/**
 * Asset URLs for documents that cannot report a failed load, such as frames. A
 * cached URL with `minLifeMs` left is reused; one closer to expiry is re-minted.
 * A node mints at most once, so a skewed client clock cannot mint on every update.
 */
export function makeLongLivedAssetUrlFamily(
  createUrl: (
    target: AssetUrlTarget,
  ) => Atom.Atom<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>>,
  options: { readonly minLifeMs: number; readonly now?: () => number },
) {
  const now = options.now ?? Date.now;
  const family = Atom.family((key: string) => {
    const [environmentId, resource] = decodeAssetUrlKey(JSON.parse(key));
    const query = createUrl({ environmentId, input: { resource } });
    return Atom.transform(
      query,
      (get) => {
        let minting = false;
        const settle = (
          value: AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>,
        ): AsyncResult.AsyncResult<AssetCreateUrlResult, unknown> => {
          if (value._tag !== "Success") return value;
          const lasts = value.value.expiresAt - now() > options.minLifeMs;
          // An expiring URL must not be handed out while its successor mints,
          // whichever reader started the mint.
          if (value.waiting) return lasts ? value : AsyncResult.initial(true);
          if (minting || lasts) return value;
          minting = true;
          get.refresh(query);
          return AsyncResult.initial(true);
        };
        get.subscribe(query, (value) => get.setSelf(settle(value)));
        return settle(get.once(query));
      },
      { initialValueTarget: query },
      // Each mount gets its own node, so a later mount may mint again.
    ).pipe(Atom.setIdleTTL(0));
  });
  return (target: AssetUrlTarget) =>
    family(JSON.stringify([target.environmentId, target.input.resource]));
}

const longLivedAssetUrl = makeLongLivedAssetUrlFamily(assetEnvironment.createUrl, {
  minLifeMs: 5 * 60_000,
});

/** Pass a null environment once the URL is adopted, so later mints do not re-render. */
export function useLongLivedAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource,
): AssetUrlState {
  const blocked = blockedAssetUrlState(resource, useFilesystemReadAccess(environmentId));
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    blocked !== null || environmentId === null
      ? EMPTY_ASSET_URL_ATOM
      : longLivedAssetUrl({ environmentId, input: { resource } }),
  );
  if (blocked !== null) return blocked;
  return assetUrlStateFromResult(
    result,
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null,
  );
}
