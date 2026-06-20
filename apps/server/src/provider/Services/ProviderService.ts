// Compatibility shim for the intentionally excluded orchestration modules and harness.
export * from "../ProviderService.ts";

/** @deprecated Use `ProviderService["Service"]` from the canonical module. */
export type ProviderServiceShape = import("../ProviderService.ts").ProviderService["Service"];
