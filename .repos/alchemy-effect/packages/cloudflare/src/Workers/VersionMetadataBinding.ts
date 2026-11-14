import type * as Binding from "./Binding.ts";
import { makeBindingLayer } from "./BindingLayer.ts";
import {
  VersionMetadata,
  type VersionMetadataAccessor,
  type WorkerVersionMetadata,
} from "./VersionMetadata.ts";

/** The binding value produced by calling {@link VersionMetadata} (declared on `env` or `yield*`-ed). */
export type VersionMetadataBinding = Binding.Binding<
  VersionMetadata["key"],
  VersionMetadataAccessor,
  VersionMetadata
>;

/**
 * The layer that provides the Effect-native interface for the Cloudflare
 * Workers Version Metadata binding.
 *
 * Provide it on the Worker effect (`Effect.provide(Cloudflare.Workers.VersionMetadataBinding)`)
 * so that yielding a {@link VersionMetadata} binding attaches the native
 * `version_metadata` binding to the surrounding Worker at deploy time and, at
 * runtime, resolves to a deferred {@link VersionMetadataAccessor} (yield it to
 * read the {@link WorkerVersionMetadata}).
 */
export const VersionMetadataBinding = makeBindingLayer<
  VersionMetadata,
  WorkerVersionMetadata,
  VersionMetadataAccessor
>(VersionMetadata, (raw) => raw);
