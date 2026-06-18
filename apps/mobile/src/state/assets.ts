import { useAtomValue } from "@effect/atom-react";
import { createAssetEnvironmentAtoms, resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { usePreparedConnection } from "./session";

export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_ASSET_URL_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("mobile-asset-url:empty"),
);

export function useAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): string | null {
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource } }),
  );
  if (preparedConnection._tag === "None" || result._tag !== "Success") {
    return null;
  }
  return resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl);
}
