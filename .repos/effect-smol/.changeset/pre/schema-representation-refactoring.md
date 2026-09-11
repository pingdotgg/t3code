---
"effect": patch
---

Refactor the `SchemaRepresentation` module to improve clarity and maintainability.

The representation pipeline is now open and compiler-extensible. The same encoded-side representation is used for JSON persistence, runtime reconstruction, JSON Schema Draft 2020-12 compilation, TypeScript code generation, AI structured output, and HTTP / OpenAPI schemas.

### New representation model

- Add `RepresentationAnnotation` and `CheckRepresentationAnnotation`, which identify declarations and checks with a stable `id`, JSON `payload`, and optional schema dependencies.
- Preserve checks on every non-reference representation node instead of storing constraints in the previous closed `meta` unions.
- Add compiler hooks for checks and declarations through `SchemaRepresentation.ToJsonSchema` and `SchemaRepresentation.Generation`.
- Add `SchemaMultiDocument`, `fromSchemaMultiDocument`, and `fromRepresentations` so several live schemas and named definitions can be converted and reconstructed together. Explicit definitions are preserved even when no root references them.
- Preserve shared structural nodes, annotated recursion, union member order, identifiers, reference siblings, and structural checks when projecting encoded schemas.

### Persistence and revivers

- Add `toJson`, `fromJson`, `toJsonMultiDocument`, and `fromJsonMultiDocument` as the persistence boundary for representation documents.
- Live representations store literal, enum, and property-name scalars as native values. JSON persistence encodes them as `{ type, value }` tagged unions so their runtime types remain distinct across persistence formats, canonically encodes structural bigint and global symbol values, keeps JSON-valued annotations, and removes runtime-only callbacks and other non-JSON annotation values.
- Replace the generic reviver callback with typed `DeclarationReviver`, `FilterReviver`, and `FilterGroupReviver` contracts. Add `makeDeclarationReviver`, `makeFilterReviver`, and `makeFilterGroupReviver`, which infer their payload type from `payloadSchema`.
- Resolve acyclic references to concrete runtime schemas and reserve `Schema.suspend` wrappers for recursive back-edges. Acyclic alias chains may be normalized while preserving the outer reference identifier.
- Export individual revivers for built-in declarations and checks from `Schema`. Consumers opt in to exactly the revivers accepted when reconstructing persisted documents:
  - declaration revivers: `OptionReviver`, `ResultReviver`, `RedactedReviver`, `CauseReasonReviver`, `CauseReviver`, `ErrorReviver`, `ExitReviver`, `ReadonlyMapReviver`, `HashMapReviver`, `ReadonlySetReviver`, `HashSetReviver`, `ChunkReviver`, `RegExpReviver`, `URLReviver`, `DateReviver`, `DurationReviver`, `BigDecimalReviver`, `FileReviver`, `FormDataReviver`, `URLSearchParamsReviver`, `Uint8ArrayReviver`, `DateTimeUtcReviver`, `TimeZoneOffsetReviver`, `TimeZoneNamedReviver`, `TimeZoneReviver`, `DateTimeZonedReviver`, `JsonReviver`, and `MutableJsonReviver`
  - check revivers: `isTrimmedReviver`, `isPatternReviver`, `isStringFiniteReviver`, `isStringBigIntReviver`, `isStringSymbolReviver`, `isUUIDReviver`, `isGUIDReviver`, `isULIDReviver`, `isBase64Reviver`, `isBase64UrlReviver`, `isStartsWithReviver`, `isEndsWithReviver`, `isIncludesReviver`, `isUppercasedReviver`, `isLowercasedReviver`, `isCapitalizedReviver`, `isUncapitalizedReviver`, `isFiniteReviver`, `isGreaterThanReviver`, `isGreaterThanOrEqualToReviver`, `isLessThanReviver`, `isLessThanOrEqualToReviver`, `isBetweenReviver`, `isMultipleOfReviver`, `isIntReviver`, `isDateValidReviver`, `isGreaterThanDateReviver`, `isGreaterThanOrEqualToDateReviver`, `isLessThanDateReviver`, `isLessThanOrEqualToDateReviver`, `isBetweenDateReviver`, `isGreaterThanBigIntReviver`, `isGreaterThanOrEqualToBigIntReviver`, `isLessThanBigIntReviver`, `isLessThanOrEqualToBigIntReviver`, `isBetweenBigIntReviver`, `isMinLengthReviver`, `isMaxLengthReviver`, `isLengthBetweenReviver`, `isMinSizeReviver`, `isMaxSizeReviver`, `isSizeBetweenReviver`, `isMinPropertiesReviver`, `isMaxPropertiesReviver`, `isPropertiesLengthBetweenReviver`, `isPropertyNamesReviver`, and `isUniqueReviver`
- Validate reviver payloads with their `payloadSchema`, and report missing or duplicate reviver identifiers.

### JSON Schema and code generation

- Compile JSON Schema from the canonical JSON codec and the encoded-side representation. Custom checks can contribute constraints through `Annotations.Filter.toJsonSchema` without modifying a central metadata registry.
- Import JSON Schema directly as live schemas. The importer now supports shared definitions, aliases, recursion, reference siblings, and definitions that are not reachable from a root.
- Add the named `FromJsonSchemaOptions` type for the importer `onEnter` callback.
- Generate code from live `toCode` annotations on declarations and checks. Compiler callbacks receive generated type parameters or schema dependencies and can emit multiple import declarations.
- Add import artifacts to `CodeDocument` and preserve all explicit definitions during multi-document code generation.
- Reject distinct schemas that declare the same identifier instead of silently merging them or generating suffixed references.

### Canonical codecs and integrations

- Preserve schema identifiers, property context, key encodings, and applicable checks while deriving canonical JSON codecs.
- Treat `Schema.Json` and `Schema.MutableJson` as already canonical. JSON validation now rejects sparse arrays, and non-finite numbers decode only from the canonical strings `"Infinity"`, `"-Infinity"`, and `"NaN"` rather than raw non-finite numeric inputs.
- Declarations without `toCodecJson` or `toCodec` now use JSON validation as their fallback instead of silently encoding to `null`. `toCodecJson` callbacks may return `undefined` when a declaration is already canonical.
- Add `Annotations.Declaration.toCodecStringTree`; StringTree derivation now requires a declaration to provide a structural StringTree, JSON, or general codec instead of silently encoding an opaque declaration to `undefined`.
- Update AI structured-output, HTTP schema, HttpApi OpenAPI, and OpenAPI generator integrations to consume the same canonical encoded representation and compiler hooks. Provider-specific structured-output transforms may remove unsupported JSON Schema keywords, while the Effect codec remains the validation authority.

### Breaking changes

- Rename the low-level representation constructors:
  - `SchemaRepresentation.fromAST` -> `SchemaRepresentation.toRepresentation`
  - `SchemaRepresentation.fromASTs` -> `SchemaRepresentation.toRepresentations`
- Replace `SchemaRepresentation.toSchema` with `fromRepresentation`, and add `fromRepresentations` for multi-root documents. Both reconstruction functions require `{ revivers: [...] }`; no default reviver is installed implicitly.
- Remove `SchemaRepresentation.toSchemaDefaultReviver`. Pass the required built-in revivers exported by `Schema`, or custom revivers created with the new constructors.
- Replace `DocumentFromJson` and `MultiDocumentFromJson` with the `toJson` / `fromJson` and `toJsonMultiDocument` / `fromJsonMultiDocument` functions.
- The persisted `Document` and `MultiDocument` format is incompatible with the previous format. Nodes now contain `checks`; encoded literal values, enum values, and property signature names use tagged `{ type, value }` objects while decoded documents expose their native scalar values; declarations no longer contain `encodedSchema`; persisted opaque declarations and leaf filters require a `{ id, payload }` representation identity; and checks no longer contain closed `meta` payloads. Regenerate stored documents from their source schemas with the new API, or migrate their shape before passing them to `fromJson`.
- Replace the generic `Reviver<T>` function type with `DeclarationReviver<P>`, `FilterReviver<P>`, `FilterGroupReviver<P>`, `CheckReviver<P>`, `Reviver<P>`, and `AnyReviver`.
- Remove the closed metadata types `StringMeta`, `NumberMeta`, `BigIntMeta`, `ArraysMeta`, `ObjectsMeta`, `DateMeta`, `SizeMeta`, `DeclarationMeta`, and `Meta` from `SchemaRepresentation`.
- Remove the exported representation validation schemas and `PrimitiveTree`: `$PrimitiveTree`, `$Annotations`, `$Null`, `$Undefined`, `$Void`, `$Never`, `$Unknown`, `$Any`, `$StringMeta`, `$String`, `$NumberMeta`, `$Number`, `$Boolean`, `$BigInt`, `$Symbol`, `$LiteralValue`, `$Literal`, `$UniqueSymbol`, `$ObjectKeyword`, `$Enum`, `$TemplateLiteral`, `$Element`, `$Arrays`, `$PropertySignature`, `$IndexSignature`, `$ObjectsMeta`, `$Objects`, `$Union`, `$Reference`, `$DateMeta`, `$SizeMeta`, `$DeclarationMeta`, `$Declaration`, `$Suspend`, `$Representation`, `$Document`, and `$MultiDocument`.
- Replace schema annotations as follows:
  - remove `Annotations.Bottom.meta` and `Annotations.Filter.meta`
  - remove `Annotations.Declaration.typeConstructor`; use `representation`
  - remove `Annotations.Declaration.generation`; use the `toCode` callback
  - add `Annotations.Filter.representation`, `toJsonSchema`, and `toCode`
  - add `Annotations.Augment.contentSchema` as a JSON-valued annotation
  - allow `Annotations.Declaration.toCodecJson` and `toCodecStringTree` to return `undefined`
- Remove the top-level `contentMediaType` and `contentSchema` fields from `SchemaRepresentation.String`. Content metadata is now carried in ordinary annotations, and `contentSchema` is a JSON Schema value rather than a nested Effect representation.
- Remove `Schema.Annotations.BuiltInMetaDefinitions`, `BuiltInMeta`, `MetaDefinitions`, and `Meta`. Custom checks should carry a representation identity and compiler callbacks instead of augmenting the metadata registry.
- `fromJsonSchemaDocument` now returns `Schema.Top` instead of a representation `Document`. `fromJsonSchemaMultiDocument` now returns `SchemaMultiDocument` instead of `MultiDocument`; call `fromSchemaMultiDocument` when a representation multi-document is required.
- `toCodeDocument` now accepts only a live `MultiDocument`; remove its `reviver` option. Reconstruct persisted documents first so revivers can restore runtime compiler callbacks.
- Rename the `generation` field of `Artifact` values for symbols and enums to `code`. Declaration generation no longer has an `Encoded` output, and `importDeclaration` is replaced by `importDeclarations` on callback output.
- Remove the exported `sanitizeJavaScriptIdentifier`, `topologicalSort`, and `TopologicalSort` helpers.
- Negative zero no longer receives special representation handling. Do not rely on preserving its sign across JSON persistence or generated code, where it may be normalized to `0`.
- With `{ errors: "all" }`, structural checks run only after their base array, object, or declaration parses successfully; they are no longer added to an already failing child parse.
