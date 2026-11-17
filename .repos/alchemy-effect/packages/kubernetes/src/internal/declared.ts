import { deepEqual } from "alchemy/Diff";
import { isPlainObject } from "alchemy/Util/data";
import { sha256Object } from "alchemy/Util/sha256";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * Core list keys. Used only for the upstream groups in {@link builtinGroups}
 * when `fieldsV1` did not describe that path. `ports` is `containerPort`+
 * `protocol` on containers and `port`+`protocol` on Services. Every other
 * list is atomic, Kubernetes' default — a CRD field named `containers` included.
 */
const listKeys: Record<string, readonly (readonly string[])[]> = {
  containers: [["name"]],
  initContainers: [["name"]],
  ephemeralContainers: [["name"]],
  volumes: [["name"]],
  env: [["name"]],
  imagePullSecrets: [["name"]],
  volumeMounts: [["mountPath"]],
  volumeDevices: [["devicePath"]],
  ports: [
    ["containerPort", "protocol"],
    ["port", "protocol"],
  ],
  readinessGates: [["conditionType"]],
};

/** Absent apiserver default, so a declared port matches `{ protocol: TCP }`. */
const listDefaults: Record<string, Record<string, string>> = {
  ports: { protocol: "TCP" },
};

/** Scalar merge sets. Identity is the string itself. */
const scalarSets = new Set(["finalizers"]);

/**
 * Maps whose values are Kubernetes quantities. The apiserver rewrites
 * `"0.1"` to `"100m"` and `"1.5Gi"` to `"1536Mi"`. Keying this off the
 * value's own name would also rewrite ConfigMap `data.memory`.
 */
const quantityParents = new Set(["requests", "limits", "hard"]);

const decimalNanos: Record<string, bigint> = {
  n: 1n,
  u: 1_000n,
  m: 1_000_000n,
  "": 1_000_000_000n,
  k: 1_000_000_000_000n,
  M: 1_000_000_000_000_000n,
  G: 1_000_000_000_000_000_000n,
  T: 1_000_000_000_000_000_000_000n,
  P: 1_000_000_000_000_000_000_000_000n,
  E: 1_000_000_000_000_000_000_000_000_000n,
};

const binaryFactor: Record<string, bigint> = {
  Ki: 1024n,
  Mi: 1024n ** 2n,
  Gi: 1024n ** 3n,
  Ti: 1024n ** 4n,
  Pi: 1024n ** 5n,
  Ei: 1024n ** 6n,
};

const quantityPattern = /^([+-])?(\d+)(?:\.(\d+))?(n|u|m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/;

/** Nanounits, or undefined when `raw` is not a Kubernetes quantity. */
const parseQuantityNanos = (raw: string): bigint | undefined => {
  const match = quantityPattern.exec(raw);
  if (!match) return undefined;
  const suffix = match[4] ?? "";
  const scale =
    suffix in binaryFactor ? binaryFactor[suffix]! * 1_000_000_000n : decimalNanos[suffix];
  if (scale === undefined) return undefined;
  const fraction = match[3] ?? "";
  const numerator = BigInt((match[2] ?? "") + fraction) * scale;
  const denominator = 10n ** BigInt(fraction.length);
  if (denominator === 0n || numerator % denominator !== 0n) return undefined;
  const magnitude = numerator / denominator;
  return match[1] === "-" ? -magnitude : magnitude;
};

const canonicalScalar = (
  parent: string | undefined,
  field: string | undefined,
  value: unknown,
): unknown => {
  if (parent === "ports" && field === "protocol" && typeof value === "string") {
    return value.toUpperCase();
  }
  if (typeof value === "string" && parent !== undefined && quantityParents.has(parent)) {
    const nanos = parseQuantityNanos(value);
    if (nanos !== undefined) return nanos.toString();
  }
  return value;
};

/**
 * `stringData` is write-only. The apiserver stores it as base64 `data` and
 * omits `stringData` from GET and apply responses, so compare the declared
 * strings with `data` decoded on both sides.
 */
const decodeSecretData = (data: unknown): Record<string, unknown> => {
  if (!isPlainObject(data)) return {};
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    decoded[key] =
      typeof value === "string" ? Buffer.from(value, "base64").toString("utf8") : value;
  }
  return decoded;
};

/** Root-only: Secret `stringData` is compared as decoded `data`. */
const normalizeApplied = (applied: unknown, desired: unknown): unknown => {
  if (!isPlainObject(applied) || !isPlainObject(desired)) return applied;
  if (
    (applied.kind === "Secret" || desired.kind === "Secret") &&
    "stringData" in desired &&
    isPlainObject(applied.data)
  ) {
    return { ...applied, stringData: decodeSecretData(applied.data) };
  }
  return applied;
};

const fieldValue = (
  item: unknown,
  key: string,
  field: string | undefined,
): string | number | undefined => {
  if (isPlainObject(item)) {
    const raw = item[key];
    const value = Redacted.isRedacted(raw) ? Redacted.value(raw) : raw;
    if (typeof value === "string") return key === "protocol" ? value.toUpperCase() : value;
    if (typeof value === "number") return value;
  }
  return field === undefined ? undefined : listDefaults[field]?.[key];
};

type ListKeys = readonly string[];
/** Map key fields, `"set"` for a scalar set, or `"atomic"` when fieldsV1 said so. */
type ListSpec = ListKeys | "set" | "atomic";
type ListTopo = Map<string, ListSpec>;

const alignKeys = (
  field: string | undefined,
  desired: ReadonlyArray<unknown>,
): ListKeys | undefined => {
  for (const keys of (field === undefined ? undefined : listKeys[field]) ?? []) {
    if (desired.every((item) => keys.every((key) => fieldValue(item, key, field) !== undefined))) {
      return keys;
    }
  }
  return undefined;
};

const apiVersionOf = (value: unknown): string | undefined =>
  isPlainObject(value) && typeof value.apiVersion === "string" ? value.apiVersion : undefined;

/**
 * Upstream groups whose OpenAPI matches {@link listKeys}. A CRD group is
 * absent even when it ends in `.k8s.io`.
 */
const builtinGroups = new Set(["", "apps", "batch", "policy", "autoscaling"]);

const builtinGroup = (apiVersion: string | undefined): boolean => {
  if (apiVersion === undefined) return false;
  const slash = apiVersion.indexOf("/");
  const group = slash === -1 ? "" : apiVersion.slice(0, slash);
  return builtinGroups.has(group);
};

const parseMapKeys = (encoded: string): ListKeys | undefined => {
  try {
    const value: unknown = JSON.parse(encoded);
    return isPlainObject(value) ? Object.keys(value) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * List paths encoded by the apiserver in `metadata.managedFields[].fieldsV1`.
 * `arrays` drops scalar leaves: an owned `{".":{}}` is a list only when the
 * declaration has an array there.
 */
const fieldsV1Topo = (document: unknown, arrays: ReadonlySet<string>): ListTopo | undefined => {
  if (!isPlainObject(document) || !isPlainObject(document.metadata)) return undefined;
  const managed = document.metadata.managedFields;
  if (!Array.isArray(managed)) return undefined;
  const topo: ListTopo = new Map();
  const visit = (node: unknown, path: string[]) => {
    if (!isPlainObject(node)) return;
    const id = path.join(".");
    let mapKeys: ListKeys | undefined;
    let set = false;
    let atomic = false;
    // `{".":{}}` is an owned list with no element yet. A scalar leaf looks the same.
    let sawDot = false;
    let sawOther = false;
    for (const key of Object.keys(node)) {
      if (key === ".") {
        sawDot = true;
        continue;
      }
      sawOther = true;
      if (!mapKeys && key.startsWith("k:")) mapKeys = parseMapKeys(key.slice(2));
      else if (key.startsWith("v:")) set = true;
      else if (key.startsWith("i:")) atomic = true;
    }
    const ownedEmpty = sawDot && !sawOther;
    const field = path[path.length - 1];
    // `k:` is the list identity. A later `v:` or empty owner must not replace it.
    const keyed = Array.isArray(topo.get(id));
    if (id.length > 0 && mapKeys && mapKeys.length > 0) topo.set(id, mapKeys);
    else if (
      id.length > 0 &&
      !keyed &&
      (set || (ownedEmpty && arrays.has(id) && scalarSets.has(field ?? "")))
    ) {
      topo.set(id, "set");
    } else if (id.length > 0 && (atomic || ownedEmpty) && arrays.has(id) && !topo.has(id)) {
      topo.set(id, "atomic");
    }
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith("f:")) visit(child, [...path, key.slice(2)]);
      else if (key.startsWith("k:") || key.startsWith("i:")) visit(child, path);
    }
  };
  for (const entry of managed) {
    if (!isPlainObject(entry) || !isPlainObject(entry.fieldsV1)) continue;
    visit(entry.fieldsV1, []);
  }
  return topo;
};

const builtinTopo = (declaration: unknown): ListTopo => {
  const topo: ListTopo = new Map();
  const visit = (node: unknown, path: string[]) => {
    if (Array.isArray(node)) return;
    if (Redacted.isRedacted(node)) return visit(Redacted.value(node), path);
    if (!isPlainObject(node)) return;
    for (const [key, child] of Object.entries(node)) {
      const next = [...path, key];
      const value = Redacted.isRedacted(child) ? Redacted.value(child) : child;
      if (Array.isArray(value)) {
        const id = next.join(".");
        if (scalarSets.has(key)) topo.set(id, "set");
        else {
          const keys = alignKeys(key, value);
          if (keys) topo.set(id, keys);
        }
        for (const item of value) visit(item, next);
        continue;
      }
      visit(value, next);
    }
  };
  visit(declaration, []);
  return topo;
};

/** Array paths in `declaration`. Scalar `{".":{}}` leaves are not lists. */
const listPaths = (declaration: unknown): ReadonlySet<string> => {
  const paths = new Set<string>();
  const visit = (node: unknown, path: string[]) => {
    const value = Redacted.isRedacted(node) ? Redacted.value(node) : node;
    if (Array.isArray(value)) {
      if (path.length > 0) paths.add(path.join("."));
      for (const item of value) visit(item, path);
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
  };
  visit(declaration, []);
  return paths;
};

/**
 * The document (apply response or live GET) wins per path. The declaration
 * fills paths it described and the document did not. Built-in groups then
 * fill paths fieldsV1 left blank. An owned `{".":{}}` map list and an `i:`
 * list stay atomic, so the built-in table cannot reclassify them. A `v:`
 * member replaces that mark, and an empty scalar set is stored as a set.
 */
const topologyOf = (declaration: unknown, document: unknown): ListTopo => {
  const lists: ListTopo = new Map();
  const arrays = listPaths(declaration);
  for (const source of [fieldsV1Topo(declaration, arrays), fieldsV1Topo(document, arrays)]) {
    if (!source) continue;
    for (const [path, keys] of source) lists.set(path, keys);
  }
  const version = apiVersionOf(declaration) ?? apiVersionOf(document);
  if (builtinGroup(version)) {
    for (const [path, keys] of builtinTopo(declaration)) {
      if (!lists.has(path)) lists.set(path, keys);
    }
  }
  return lists;
};

const storedTopology = (encoded: unknown): ListTopo => {
  const lists: ListTopo = new Map();
  if (!isPlainObject(encoded)) return lists;
  for (const [path, keys] of Object.entries(encoded)) {
    if (keys === "set" || keys === "atomic") {
      lists.set(path, keys);
      continue;
    }
    if (Array.isArray(keys) && keys.every((key): key is string => typeof key === "string")) {
      lists.set(path, keys);
    }
  }
  return lists;
};

const mergeKey = (item: unknown, keys: readonly string[], field: string | undefined): string =>
  keys.map((key) => String(fieldValue(item, key, field))).join("\0");

const scalarIdentity = (item: unknown): string | undefined => {
  const value = Redacted.isRedacted(item) ? Redacted.value(item) : item;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  return undefined;
};

/**
 * Fields alchemy applied. Leaf `null` is a scalar slot filled from the
 * document. Merge-key scalars and set members stay so list identity still
 * matches. A Redacted identity stays wrapped; other secret leaves are null
 * so they are not copied into state.
 *
 * When any list is a map or a set, the mask is `{ $fields, $lists }`. `$lists`
 * is the topology taken from `witness` (the apply response's fieldsV1) so a
 * later GET is classified the same way. A plain object mask has only atomic lists.
 */
export const driftMask = (declaration: unknown, witness?: unknown): unknown => {
  const lists = topologyOf(declaration, witness ?? declaration);
  const fields = maskOf(declaration, lists, []);
  if (lists.size === 0) return fields;
  return { $fields: fields, $lists: Object.fromEntries(lists) };
};

const maskOf = (
  declaration: unknown,
  lists: ListTopo,
  path: string[],
  keep?: ReadonlySet<string>,
  sensitive = false,
): unknown => {
  if (Redacted.isRedacted(declaration)) {
    return maskOf(Redacted.value(declaration), lists, path, keep, true);
  }
  if (Array.isArray(declaration)) {
    const spec = lists.get(path.join("."));
    if (spec === "set") {
      return declaration.map((item) => {
        const identity = scalarIdentity(item);
        if (identity === undefined) return null;
        return sensitive || Redacted.isRedacted(item) ? Redacted.make(identity) : identity;
      });
    }
    const keepKeys = Array.isArray(spec) ? new Set(spec) : undefined;
    return declaration.map((item) =>
      maskOf(item, lists, path, keepKeys, sensitive || Redacted.isRedacted(item)),
    );
  }
  if (!isPlainObject(declaration)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(declaration)) {
    const redacted = Redacted.isRedacted(child);
    const value = redacted ? Redacted.value(child) : child;
    const leaf = !isPlainObject(value) && !Array.isArray(value);
    const secret = sensitive || redacted;
    out[key] =
      keep?.has(key) && leaf
        ? secret
          ? Redacted.make(value)
          : value
        : maskOf(child, lists, [...path, key], undefined, sensitive);
  }
  return out;
};

/**
 * Declared paths, values taken from `document` (the apply response or a later
 * GET). Undeclared keys — HPA replicas, controller annotations, apiserver
 * defaults — are absent. Map-list order is not significant.
 */
const selectDeclared = (
  declaration: unknown,
  document: unknown,
  lists: ListTopo,
  path: string[],
): unknown => {
  if (Redacted.isRedacted(declaration)) {
    return selectDeclared(Redacted.value(declaration), document, lists, path);
  }
  if (Redacted.isRedacted(document)) {
    return selectDeclared(declaration, Redacted.value(document), lists, path);
  }
  const field = path[path.length - 1];
  if (Array.isArray(declaration)) {
    const items = Array.isArray(document) ? document : [];
    const spec = lists.get(path.join("."));
    if (spec === "set") {
      const present = new Set(items.map(scalarIdentity).filter((value) => value !== undefined));
      return declaration
        .map(scalarIdentity)
        .filter((value): value is string => value !== undefined && present.has(value))
        .sort((left, right) => left.localeCompare(right));
    }
    if (spec === undefined || spec === "atomic") {
      const length = Math.max(declaration.length, items.length);
      return Array.from({ length }, (_, index) =>
        index < declaration.length
          ? selectDeclared(declaration[index], items[index], lists, path)
          : items[index],
      );
    }
    const match = (item: unknown) =>
      items.find((candidate) =>
        spec.every((key) => fieldValue(candidate, key, field) === fieldValue(item, key, field)),
      );
    return declaration
      .map((item) => ({
        key: mergeKey(item, spec, field),
        value: selectDeclared(item, match(item), lists, path),
      }))
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((entry) => entry.value);
  }
  if (!isPlainObject(declaration)) {
    return canonicalScalar(path[path.length - 2], field, document);
  }
  const source = isPlainObject(document) ? document : {};
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(declaration)) {
    out[key] = selectDeclared(child, source[key], lists, [...path, key]);
  }
  return out;
};

const projection = (
  declaration: unknown,
  document: unknown,
): { fields: unknown; lists: ListTopo } => {
  if (isPlainObject(declaration) && "$fields" in declaration && isPlainObject(declaration.$lists)) {
    return { fields: declaration.$fields, lists: storedTopology(declaration.$lists) };
  }
  return { fields: declaration, lists: topologyOf(declaration, document) };
};

/** Selection of `document` through `declaration` (or a {@link driftMask}). */
export const selectDrift = (declaration: unknown, document: unknown): unknown => {
  const { fields, lists } = projection(declaration, document);
  return selectDeclared(fields, normalizeApplied(document, fields), lists, []);
};

/** True when a live object and a baseline agree on the declared fields. */
export const appliedObjectsMatch = (live: unknown, preview: unknown, desired: unknown): boolean =>
  deepEqual(selectDrift(desired, live), selectDrift(desired, preview));

/** Hash of {@link selectDrift}. The apply response and a later GET share it. */
export const hashDriftSelection = (declaration: unknown, document: unknown) =>
  Effect.sync(() => {
    const viewed = selectDrift(declaration, document);
    return isPlainObject(viewed) ? viewed : { value: viewed };
  }).pipe(Effect.flatMap(sha256Object));
