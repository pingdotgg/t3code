import { builtInSecretProviderDefinitions } from "@t3tools/secret-provider-definitions/registry";
import * as OnePasswordDriver from "@t3tools/secret-provider-onepassword/server/driver";

/** In the shared registry's order. */
export const BUILT_IN_SECRET_PROVIDER_DRIVER_LIST = [OnePasswordDriver.driver] as const;

export const secretProviderDefinitions = builtInSecretProviderDefinitions;
