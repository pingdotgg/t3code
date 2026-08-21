/**
 * OmpAdapter: shape type for the Oh My Pi ACP provider adapter.
 *
 * The driver bundles one adapter per provider instance. The runtime
 * implementation lives beside the other ACP adapters and is intentionally
 * kept separate from this type-only service boundary.
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface OmpAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
