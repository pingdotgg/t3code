/**
 * Plugin settings POLICY: the renderable field vocabulary the host form can draw,
 * and the compatibility fingerprint for stored values.
 *
 * Runtime logic, so it lives here rather than in `packages/contracts`, which
 * AGENTS.md requires to stay schema-only. The schema TYPE stays in contracts.
 *
 * @module pluginSettings
 */
import type { ProviderSettingsFormControl, SettingsSchema } from "@t3tools/contracts";
import { readSettingsFormAnnotation } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";

export type { SettingsSchema };

/**
 * A settings schema: a struct whose fields carry `providerSettingsForm`
 * annotations. Shared by first-party providers and plugins.
 *
 * The annotation name is historical — it predates plugins. Renaming it would
 * touch every provider, so plugins deliberately reuse the same vocabulary
 * rather than introducing a second one.
 */
/**
 * The only field shapes `ProviderSettingsForm` can render.
 *
 * This is NOT a stylistic restriction. The renderer defaults `control` to
 * `"text"` for every field and reads values with
 * `typeof value === "string" ? value : ""` — so a Number/Array/Struct field is
 * rendered as a text box, always reads as `""`, and every write it produces
 * fails server validation. Rejecting at registration turns a silent, permanent
 * mis-render into an immediate, actionable error.
 *
 * Widening this set means widening the renderer first.
 */
const CONTROL_JSON_TYPE: Record<ProviderSettingsFormControl, "string" | "boolean"> = {
  text: "string",
  password: "string",
  textarea: "string",
  switch: "boolean",
};

export interface PluginSettingsSchemaViolation {
  readonly field: string;
  readonly reason: string;
}

/**
 * Identifies the shape that produced a stored settings payload.
 *
 * Stored alongside the values so an upgrade that changes the schema can be
 * detected rather than silently misread. Derived from the JSON Schema, so it
 * tracks exactly what affects encoding/decoding — renaming a field or changing
 * its type changes the fingerprint, while editing a description does not.
 *
 * Not a security control: a fingerprint match means "same shape", not "same
 * plugin". It exists to make incompatibility detectable and recoverable.
 */
/**
 * JSON Schema keys that describe how a field is PRESENTED, not what it accepts.
 *
 * Changing any of these cannot invalidate stored values, so they must not affect the
 * fingerprint — a documentation-only plugin update would otherwise mark every user's
 * settings incompatible and brick their configuration.
 */
const PRESENTATION_KEYS = new Set([
  "description",
  "title",
  "examples",
  "$comment",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

/**
 * Strips presentation keys and sorts remaining keys, recursively.
 *
 * Keeps everything that constrains what decodes — `type`, `enum`, `const`, `format`,
 * `pattern`, bounds, `items`, nested `properties`. An earlier version projected each
 * field to its primitive `type` alone, which was TOO aggressive in the other
 * direction: `Schema.String`, `Literals(["a","b"])` and `Literals(["a","c"])` all
 * fingerprinted identically despite accepting different values, so a change between
 * them went undetected. Sorting makes key order irrelevant without discarding meaning.
 */
/**
 * Removes every property the schema does not declare, at EVERY level.
 *
 * `parseOptions` is a schema annotation, so `onExcessProperty: "preserve"` is the
 * plugin's to set — meaning decode/re-encode is never a guarantee the HOST owns. A
 * top-level filter is not enough either: a hidden field may hold a nested Struct with
 * its own preserve annotation, which carries arbitrary client keys through decode,
 * encode, and a root-level filter alike (a reviewer proved this with a live probe).
 * Walking the derived JSON Schema makes the guarantee structural instead of trusting
 * anything the plugin declared.
 *
 * Nodes the schema does not describe as objects/arrays are passed through: they are
 * already constrained by decoding.
 */
type StripContext = {
  readonly definitions: Record<string, unknown>;
  readonly seen: ReadonlySet<string>;
};

/**
 * The result of stripping. `Unsupported` is NOT a detail — it is the whole point.
 *
 * The previous version returned the value unchanged whenever it met a node it did
 * not understand, which is FAIL-OPEN: every shape outside its vocabulary silently
 * became "nothing to strip", and the undeclared key was persisted. That defect was
 * found twice, in two different wrappers, because enumerating wrappers is a game you
 * lose by playing. Now the host either PROVES it stripped a node or refuses the
 * write, so an unmodelled shape is a loud rejection instead of a quiet leak.
 */
export type SettingsStripResult =
  | { readonly _tag: "Stripped"; readonly value: unknown }
  | { readonly _tag: "Unsupported"; readonly path: string; readonly detail: string };

const unsupported = (path: string, detail: string): SettingsStripResult => ({
  _tag: "Unsupported",
  path,
  detail,
});

/** Follow `$ref` into the document's definitions, refusing cycles. */
const resolveNode = (
  node: Record<string, unknown>,
  ctx: StripContext,
  path: string,
): { readonly node: Record<string, unknown>; readonly ctx: StripContext } | SettingsStripResult => {
  const ref = node["$ref"];
  if (typeof ref !== "string") return { node, ctx };
  // Only the local definitions form Effect emits is understood; anything else
  // (remote refs, JSON pointers into arbitrary subtrees) is refused rather than
  // guessed at.
  // Effect emits `#/$defs/Inner` while keying the document map `definitions`, so the
  // pointer prefix and the map name genuinely differ. Accepting only `#/definitions/`
  // meant an identified nested struct — `Struct({...}).annotate({ identifier })` —
  // decoded and activated, then had every save rejected. Both spellings are accepted
  // because either may appear; the segment after the prefix is the key either way.
  const prefix = ["#/$defs/", "#/definitions/"].find((candidate) => ref.startsWith(candidate));
  if (prefix === undefined) {
    return unsupported(path, `$ref "${ref}" is not a local $defs/definitions reference`);
  }
  if (ctx.seen.has(ref)) {
    // A recursive schema cannot be walked to a fixed point here, and pretending
    // otherwise would either loop forever or fall back to passing the value through.
    return unsupported(path, `$ref "${ref}" is recursive`);
  }
  const target = ctx.definitions[ref.slice(prefix.length)];
  if (typeof target !== "object" || target === null) {
    return unsupported(path, `$ref "${ref}" does not resolve`);
  }
  return {
    node: target as Record<string, unknown>,
    ctx: { definitions: ctx.definitions, seen: new Set([...ctx.seen, ref]) },
  };
};

/**
 * Members of a union that could describe an object/array value, ignoring `null`
 * (which is how a decoding default shows up: `anyOf: [{...}, {type:"null"}]`).
 */
const structuralMembers = (
  members: ReadonlyArray<unknown>,
): ReadonlyArray<Record<string, unknown>> =>
  members.filter((member): member is Record<string, unknown> => {
    if (typeof member !== "object" || member === null) return false;
    const record = member as Record<string, unknown>;
    return record["type"] !== "null";
  });

const stripNode = (
  value: unknown,
  node: unknown,
  ctx: StripContext,
  path: string,
): SettingsStripResult => {
  // A primitive cannot carry an undeclared key, so there is nothing to strip and
  // nothing to prove. This is what keeps fail-closed from rejecting ordinary
  // schemas: only objects and arrays ever reach the shape checks below.
  const isObject = typeof value === "object" && value !== null && !Array.isArray(value);
  const isArray = Array.isArray(value);
  if (!isObject && !isArray) return { _tag: "Stripped", value };

  if (typeof node !== "object" || node === null) {
    return unsupported(path, "the schema does not describe this value");
  }

  const resolved = resolveNode(node as Record<string, unknown>, ctx, path);
  if ("_tag" in resolved) return resolved;
  const schemaNode = resolved.node;
  const nodeCtx = resolved.ctx;

  const allOf = schemaNode["allOf"];
  if (Array.isArray(allOf)) {
    // Refuse only a STRUCTURAL intersection, not any `allOf` at all.
    //
    // Effect emits `allOf: [{ description }]` for `annotateKey` — on a node that
    // ALSO carries its own `properties`. Refusing every `allOf` therefore bricked an
    // ordinary annotated nested field: it decodes, it activates, and then every save
    // is rejected forever. Fail-closed is meant to refuse what it cannot model, not
    // what it merely finds documented. A reviewer predicted this and the real
    // derivation confirmed it.
    //
    // A member that only carries presentation keywords constrains nothing, so it is
    // ignored. A member with actual structure would need every member applied and
    // the results merged — picking one is how the old fail-open bug worked — so that
    // is still refused.
    const structural = allOf.filter(
      (member) =>
        typeof member !== "object" ||
        member === null ||
        Object.keys(member as Record<string, unknown>).some((key) => !PRESENTATION_KEYS.has(key)),
    );
    if (structural.length > 0) {
      return unsupported(path, "`allOf` intersections are not supported in settings schemas");
    }
  }

  for (const keyword of ["anyOf", "oneOf"] as const) {
    const members = schemaNode[keyword];
    if (!Array.isArray(members)) continue;
    const structural = structuralMembers(members);
    if (structural.length === 0) {
      return unsupported(path, `\`${keyword}\` has no member describing this value`);
    }
    if (structural.length > 1) {
      // Choosing a branch is guesswork with two failure modes, and the old code
      // silently took the first: strip against the wrong arm DELETES the user's
      // legitimate keys, strip against a permissive arm KEEPS undeclared ones.
      return unsupported(
        path,
        `\`${keyword}\` has ${structural.length} object/array branches, so the host cannot tell which one these values belong to`,
      );
    }
    return stripNode(value, structural[0], nodeCtx, path);
  }

  if (isArray) {
    const prefixItems = schemaNode["prefixItems"];
    const items = schemaNode["items"];
    const elements: Array<unknown> = [];
    for (const [index, element] of (value as ReadonlyArray<unknown>).entries()) {
      // A tuple derives to `prefixItems`, positionally. `items` covers the rest (or
      // everything, for a plain Array).
      const elementNode =
        Array.isArray(prefixItems) && index < prefixItems.length ? prefixItems[index] : items;
      if (elementNode === undefined) {
        return unsupported(`${path}[${index}]`, "the schema does not describe this element");
      }
      const stripped = stripNode(element, elementNode, nodeCtx, `${path}[${index}]`);
      if (stripped._tag === "Unsupported") return stripped;
      elements.push(stripped.value);
    }
    return { _tag: "Stripped", value: elements };
  }

  const properties = schemaNode["properties"];
  const additional = schemaNode["additionalProperties"];
  if (schemaNode["patternProperties"] !== undefined) {
    // Not modelled. Ignoring it is wrong in BOTH directions: a key matching a
    // pattern but absent from `properties` would be silently DROPPED (data loss),
    // and a pattern schema that further constrains a declared key would not be
    // applied (a leak). Refuse instead of guessing which.
    return unsupported(path, "`patternProperties` is not supported in settings schemas");
  }
  if (additional === true) {
    // `true` means "any key is allowed". Keeping them all reopens the leak; dropping
    // them silently deletes data the schema permits. Neither is defensible, so refuse
    // — the consistent fail-closed choice. (Effect does not appear to emit this from
    // a Struct; it is here so the vocabulary stays closed rather than hopeful.)
    return unsupported(path, "an object with `additionalProperties: true` cannot be safely stored");
  }
  const declared =
    typeof properties === "object" && properties !== null
      ? (properties as Record<string, unknown>)
      : {};
  const hasProperties = typeof properties === "object" && properties !== null;
  const additionalIsSchema = typeof additional === "object" && additional !== null;
  if (!hasProperties && !additionalIsSchema) {
    // e.g. a bare `{"type":"object"}` — every key is undeclared, and silently
    // keeping them all is exactly the leak this function exists to stop.
    return unsupported(path, "the schema describes an object but declares no properties");
  }

  const entries: Array<readonly [string, unknown]> = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const keyPath = path === "" ? key : `${path}.${key}`;
    const declaredNode = Object.hasOwn(declared, key) ? declared[key] : undefined;
    if (declaredNode === undefined) {
      // `additionalProperties` as a SCHEMA means the keys are legitimately open
      // (Schema.Record): keep them, but strip their VALUES against that schema.
      // Anything else (false, or absent) means undeclared — drop it. That drop is
      // the strip.
      if (!additionalIsSchema) continue;
      const stripped = stripNode(nested, additional, nodeCtx, keyPath);
      if (stripped._tag === "Unsupported") return stripped;
      entries.push([key, stripped.value]);
      continue;
    }
    const stripped = stripNode(nested, declaredNode, nodeCtx, keyPath);
    if (stripped._tag === "Unsupported") return stripped;
    entries.push([key, stripped.value]);
  }
  return { _tag: "Stripped", value: Object.fromEntries(entries) };
};

/**
 * Remove every property the schema does not declare, at every level.
 *
 * `onExcessProperty: "preserve"` is a schema ANNOTATION, so decoding cannot be
 * trusted to drop unknown keys — the plugin chooses. The host must own the strip,
 * or a plugin annotating a nested Struct with `preserve` persists whatever a client
 * sends. Walking the DERIVED JSON Schema makes the guarantee structural rather than
 * a matter of what the plugin declared.
 *
 * Takes the schema (not a pre-derived node) so that a schema which cannot be derived
 * is an `Unsupported` REJECTION rather than a silent skip: the previous version
 * returned `null` from its derivation helper and then treated `null` as "nothing to
 * strip", so a throwing derivation disabled stripping entirely.
 */
export const stripAgainstJsonSchemaDocument = (input: {
  readonly value: unknown;
  readonly schema: unknown;
  readonly definitions?: Record<string, unknown> | undefined;
}): SettingsStripResult =>
  stripNode(
    input.value,
    input.schema,
    { definitions: input.definitions ?? {}, seen: new Set<string>() },
    "",
  );

export const stripUndeclaredSettings = (
  value: unknown,
  schema: SettingsSchema,
): SettingsStripResult => {
  let document: ReturnType<typeof Schema.toJsonSchemaDocument>;
  try {
    document = Schema.toJsonSchemaDocument(schema);
  } catch (error) {
    return unsupported(
      "<schema>",
      `settings schema cannot be derived to JSON Schema: ${String(error)}`,
    );
  }
  const definitions = document.definitions;
  return stripAgainstJsonSchemaDocument({
    value,
    schema: document.schema,
    definitions:
      typeof definitions === "object" && definitions !== null
        ? (definitions as Record<string, unknown>)
        : {},
  });
};

const isEmptyObject = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 0;

const canonicalizeJsonSchema = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    // Drop members that reduced to nothing: an annotation-only allOf member becomes
    // `{}` once its presentation keys are stripped.
    return value.map(canonicalizeJsonSchema).filter((member) => !isEmptyObject(member));
  }
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !PRESENTATION_KEYS.has(key))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, nested]) => [key, canonicalizeJsonSchema(nested)] as const)
    // Effect renders annotations as `allOf: [{ description }]`, so stripping the
    // inner keys leaves `allOf: []` — which would still differ from a field that
    // never carried an annotation. Drop containers that emptied out, so a
    // description-only edit is genuinely invisible.
    .filter(([, nested]) => !(Array.isArray(nested) && nested.length === 0))
    .filter(([, nested]) => !isEmptyObject(nested));
  return Object.fromEntries(entries);
};

export const fingerprintSettingsSchema = (schema: SettingsSchema): string => {
  try {
    const root = Schema.toJsonSchemaDocument(schema).schema as Record<string, unknown>;
    const properties =
      typeof root["properties"] === "object" && root["properties"] !== null
        ? (root["properties"] as Record<string, unknown>)
        : {};
    const required = new Set(
      Array.isArray(root["required"]) ? (root["required"] as ReadonlyArray<unknown>) : [],
    );

    // Canonicalise to ONLY what affects whether stored values still decode: each
    // field's name, its encoded type, and whether it is required.
    //
    // Raw JSON.stringify of the JSON Schema was wrong in both directions. It changed
    // when a DESCRIPTION or title changed — so a documentation-only plugin update
    // marked every user's stored settings incompatible and bricked their config —
    // and it changed on mere field REORDERING, which affects nothing. Sorting by key
    // removes the ordering sensitivity; dropping the presentation keywords removes
    // the cosmetic sensitivity.
    //
    // It does NOT reduce a field to its (type, required) pair — that was the first
    // attempt, and it collided: String, Literals(["a","b"]) and Literals(["a","c"])
    // all fingerprinted identically, so a schema change between them looked like no
    // change at all. Every CONSTRAINING keyword is kept.
    //
    // Adding or removing a decoding default IS still detected, because a defaulted
    // field drops out of `required`. Changing a default's VALUE is deliberately NOT
    // detected: the stored values still decode, so there is nothing to repair.
    const canonical = Object.keys(properties)
      .sort()
      .map((key) => ({
        key,
        schema: canonicalizeJsonSchema(properties[key]),
        required: required.has(key),
      }));
    return JSON.stringify(canonical);
  } catch {
    // Unfingerprintable schemas are already rejected by
    // findPluginSettingsSchemaViolations; this keeps the function total.
    return "";
  }
};

/**
 * The field's encoded JSON type, or null when it isn't a single plain type.
 *
 * Unwraps nullable unions: `withDecodingDefault` — which providers use on nearly
 * every field — encodes as `anyOf: [{type:"string"},{type:"null"}]`, since an
 * absent value is permitted and filled by the default. Treating that as "no type"
 * would reject defaults, which are the main reason to declare settings at all.
 *
 * Genuinely mixed unions still return null, which is what keeps Number out:
 * it encodes as `anyOf: [{type:"number"}, {type:"string",enum:["NaN"]}, …]` to
 * carry NaN/Infinity, so its non-null members are not a single type.
 */
const jsonTypeOf = (property: unknown): string | null => {
  if (typeof property !== "object" || property === null) return null;
  const record = property as Record<string, unknown>;
  const type = record["type"];
  if (typeof type === "string") return type;

  const anyOf = record["anyOf"];
  if (!Array.isArray(anyOf)) return null;
  const nonNullTypes = new Set(
    anyOf
      .map((member) =>
        typeof member === "object" && member !== null
          ? (member as Record<string, unknown>)["type"]
          : undefined,
      )
      .filter((memberType) => memberType !== "null"),
  );
  if (nonNullTypes.size !== 1) return null;
  const only = [...nonNullTypes][0];
  return typeof only === "string" ? only : null;
};

/**
 * Checks a settings schema against the renderable vocabulary.
 *
 * Returns every violation (not just the first) so a plugin author fixes the
 * whole schema in one pass rather than one field per install attempt.
 */
export interface PluginSettingsValidationOptions {
  /**
   * Whether a `password` control is permitted.
   *
   * FALSE for plugins. In this codebase `password` means "mask the input", NOT
   * "store securely" — OpenCode's own `serverPassword` uses it and its description
   * says "Stored in plain text on disk." Plugin settings are stored as ordinary
   * plaintext in `plugin_settings` and are readable by anyone with `plugins:manage`,
   * so a plugin author reaching for `password` to hold an API key would be silently
   * wrong. Secrets are deliberately out of scope for this slice; a plugin needing one
   * uses SecretsCapability, which already exists. Fail closed until the secret
   * settings slice lands, then revisit.
   *
   * TRUE for first-party provider schemas, which predate this and where the field
   * descriptions already tell the user what is stored.
   */
  readonly allowPasswordControl: boolean;
}

export const findPluginSettingsSchemaViolations = (
  schema: SettingsSchema,
  options: PluginSettingsValidationOptions = { allowPasswordControl: true },
): ReadonlyArray<PluginSettingsSchemaViolation> => {
  let document: ReturnType<typeof Schema.toJsonSchemaDocument>;
  try {
    document = Schema.toJsonSchemaDocument(schema);
  } catch (error) {
    return [
      {
        field: "<schema>",
        reason: `is not JSON-Schema-derivable: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }

  const root = document.schema as Record<string, unknown>;
  if (root["type"] !== "object") {
    return [{ field: "<schema>", reason: "must be a Schema.Struct with an object root" }];
  }
  const properties = root["properties"];
  if (typeof properties !== "object" || properties === null) {
    return [{ field: "<schema>", reason: "must declare at least one field" }];
  }

  const required = new Set(
    Array.isArray(root["required"]) ? (root["required"] as ReadonlyArray<unknown>) : [],
  );

  const violations: Array<PluginSettingsSchemaViolation> = [];
  for (const [key, fieldSchema] of Object.entries(schema.fields)) {
    const annotation = readSettingsFormAnnotation(fieldSchema);
    if (annotation.hidden === true) {
      // A hidden field the form can never supply, and that decoding cannot fill in,
      // makes the plugin unconfigurable: the form omits it, so EVERY write fails
      // validation forever. Reject it here rather than shipping a settings page that
      // cannot be saved. (A hidden field WITH a decoding default is fine — that is
      // how every first-party provider parks non-renderable state like
      // `enabled: Boolean` / `customModels: Array`, and those are absent from
      // `required`.)
      if (required.has(key)) {
        violations.push({
          field: key,
          reason:
            "is hidden and required with no decoding default, so the settings form can never supply it and every save would fail",
        });
      }
      // Otherwise hidden fields are never rendered (`ProviderSettingsForm` drops
      // them before building a field model), so the control vocabulary does not
      // constrain them.
      continue;
    }

    const control: ProviderSettingsFormControl = annotation.control ?? "text";
    if (control === "password" && !options.allowPasswordControl) {
      violations.push({
        field: key,
        reason:
          'uses the "password" control, which only masks the input — plugin settings are stored as ordinary plaintext and are readable by anyone who can manage plugins. Use SecretsCapability for secrets',
      });
      continue;
    }
    const expected = CONTROL_JSON_TYPE[control];
    const actual = jsonTypeOf((properties as Record<string, unknown>)[key]);
    if (actual !== expected) {
      violations.push({
        field: key,
        reason:
          actual === null
            ? `control "${control}" requires a ${expected} field, but this field's encoded form is not a plain ${expected} (unions, numbers, arrays and nested structs are not renderable)`
            : `control "${control}" requires a ${expected} field, but this field encodes as ${actual}`,
      });
    }
  }
  return violations;
};
