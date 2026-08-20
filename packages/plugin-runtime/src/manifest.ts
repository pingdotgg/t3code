import * as Schema from "effect/Schema";

const NamespacedId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/),
  Schema.isMaxLength(255),
);

const SemanticVersion = Schema.String.check(
  Schema.isPattern(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  ),
);

const CapabilityId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9.-]*@[1-9]\d*$/));

const RelativeEntrypoint = Schema.String.check(
  Schema.isPattern(/^\.\/(?!(?:\.\.(?:\/|$)|.*\/\.\.(?:\/|$)))[A-Za-z0-9_./-]+$/),
);
const Permission = Schema.String.check(Schema.isPattern(/^[a-z][a-z-]*:.+$/));

const ContributionCatalog = Schema.Struct({
  commands: Schema.optional(Schema.Array(NamespacedId)),
  settings: Schema.optional(Schema.Array(NamespacedId)),
  views: Schema.optional(Schema.Array(NamespacedId)),
  mobileCards: Schema.optional(Schema.Array(NamespacedId)),
});

export const PluginManifest = Schema.Struct({
  manifestVersion: Schema.Literal(1),
  id: NamespacedId,
  version: SemanticVersion,
  apiVersion: Schema.Literal(1),
  surfaces: Schema.optional(Schema.Array(Schema.Literals(["web", "desktop", "mobile"]))),
  entrypoints: Schema.Struct({
    server: Schema.optional(RelativeEntrypoint),
    web: Schema.optional(RelativeEntrypoint),
    desktop: Schema.optional(RelativeEntrypoint),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  capabilities: Schema.Array(CapabilityId),
  requires: Schema.optional(Schema.Array(CapabilityId)),
  optional: Schema.optional(Schema.Array(CapabilityId)),
  provides: Schema.optional(Schema.Array(CapabilityId)),
  permissions: Schema.optional(Schema.Array(Permission)),
  contributes: ContributionCatalog,
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export type PluginManifest = typeof PluginManifest.Type;
