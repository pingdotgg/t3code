import * as SecretProviderConfigChoicesCore from "@t3tools/secret-provider-core/server/SecretProviderConfigChoices";

import { BUILT_IN_SECRET_PROVIDER_DRIVER_LIST } from "./secretProviderDefinitions.ts";

export const layer = SecretProviderConfigChoicesCore.layer({
  drivers: BUILT_IN_SECRET_PROVIDER_DRIVER_LIST,
});
