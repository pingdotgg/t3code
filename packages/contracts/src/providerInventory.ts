import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ProviderInventoryStatus = Schema.Literals([
  "connected",
  "needsAuth",
  "failed",
  "pending",
  "disabled",
]);
export type ProviderInventoryStatus = typeof ProviderInventoryStatus.Type;

export const ProviderInventoryItem = Schema.Struct({
  /** The provider's own key for the item, and what `disabledInventory` stores. */
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  status: Schema.optional(ProviderInventoryStatus),
  toolCount: Schema.optional(NonNegativeInt),
  /** The plugin that ships this item. It loads and unloads with that plugin. */
  plugin: Schema.optional(TrimmedNonEmptyString),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderInventoryItem = typeof ProviderInventoryItem.Type;

export const ProviderInventorySection = Schema.Union([
  Schema.TaggedStruct("Listed", {
    items: Schema.Array(ProviderInventoryItem),
    /** Whether T3 can keep individual items out of its own sessions. */
    canDisable: Schema.Boolean,
  }),
  Schema.TaggedStruct("Unsupported", {}),
  Schema.TaggedStruct("Failed", { message: TrimmedNonEmptyString }),
]);
export type ProviderInventorySection = typeof ProviderInventorySection.Type;

export const ProviderInventory = Schema.Struct({
  instanceId: ProviderInstanceId,
  checkedAt: IsoDateTime,
  /** Where the account's connectors are managed for every app, not just T3. */
  manageUrl: Schema.optional(TrimmedNonEmptyString),
  connectors: ProviderInventorySection,
  mcpServers: ProviderInventorySection,
  plugins: ProviderInventorySection,
  skills: ProviderInventorySection,
});
export type ProviderInventory = typeof ProviderInventory.Type;

export const ProviderReadInventoryInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type ProviderReadInventoryInput = typeof ProviderReadInventoryInput.Type;
