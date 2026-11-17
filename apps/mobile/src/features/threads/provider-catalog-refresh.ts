import type { EnvironmentId } from "@t3tools/contracts";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { msg } from "gt-react-native";

import { m } from "../../i18n/messages";

type RefreshProvidersTarget = {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly refreshModels: true };
};

export function createProviderCatalogRefreshRunner<Result>(
  refreshProviders: (target: RefreshProvidersTarget) => Promise<Result>,
) {
  let pending: Promise<Result> | null = null;

  return (environmentId: EnvironmentId): Promise<Result> => {
    if (pending) return pending;
    pending = refreshProviders({ environmentId, input: { refreshModels: true } }).finally(() => {
      pending = null;
    });
    return pending;
  };
}

export function providerCatalogRefreshError(
  result: AtomCommandResult<unknown, unknown>,
): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return errorDisplayMessage(error, m) ?? m(msg("Provider discovery failed."));
}
