// Compatibility shim for the intentionally excluded orchestration harness.
import * as ProviderSessionDirectory from "../ProviderSessionDirectory.ts";

export const ProviderSessionDirectoryLive = ProviderSessionDirectory.layer;

export const makeProviderSessionDirectoryLive = () => ProviderSessionDirectory.layer;
