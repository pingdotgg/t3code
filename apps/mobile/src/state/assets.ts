import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { createAssetEnvironmentAtoms } from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { resolveAssetUrlState, type AssetUrlState } from "./assetUrlState";
import { usePreparedConnection } from "./session";

export type { AssetUrlState };

export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_ASSET_URL_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("mobile-asset-url:empty"),
);

export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): {
  readonly retry: () => void;
  readonly status: AssetUrlState;
} {
  const preparedConnection = usePreparedConnection(environmentId);
  const selectedAtom =
    environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource } });
  const result = useAtomValue(selectedAtom);
  const retry = useAtomRefresh(selectedAtom);
  return {
    retry,
    status: resolveAssetUrlState({
      httpBaseUrl:
        preparedConnection._tag === "None" ? null : preparedConnection.value.httpBaseUrl,
      requested: environmentId !== null && resource !== null,
      result,
    }),
  };
}

export function useAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): string | null {
  const { status } = useAssetUrlState(environmentId, resource);
  return status._tag === "Success" ? status.url : null;
}
