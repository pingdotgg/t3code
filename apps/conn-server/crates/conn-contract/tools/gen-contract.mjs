// Generates the crate's Rust types from packages/contracts. `--check` fails when stale.
// `--contracts <dir>` reads another copy of the contract; `--out <dir>` writes elsewhere.
// Path: Schema.toCodecJson (Effect RPC's JSON codec) -> SchemaRepresentation IR -> serde types.
// A shape it cannot map exactly becomes `Opaque` (listed in generated/report.json), never looser.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { monorepo } from "../../../tools/monorepo.mjs";
import { gitEnv } from "../../../tools/sealed-env.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const crateDir = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const repoDir = monorepo();
const contractsDir = NodePath.resolve(
  option("--contracts") ?? NodePath.join(repoDir, "packages/contracts"),
);
const providerAdapterFile = NodePath.join(
  repoDir,
  "packages/provider-core/src/server/ProviderAdapter.ts",
);
const outDir = NodePath.resolve(option("--out") ?? crateDir);
const check = flag("--check");

const resolveFrom = NodeModule.createRequire(NodePath.join(contractsDir, "package.json")).resolve;
const imp = (m) => import(NodeURL.pathToFileURL(resolveFrom(m)).href);
const { Schema, SchemaAST, SchemaRepresentation } = await imp("effect");
const RpcSchema = await imp("effect/rpc/RpcSchema");

const srcDir = NodePath.join(contractsDir, "src");
const moduleFiles = NodeFS.readdirSync(srcDir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
  .sort();
const modules = [];
for (const file of moduleFiles) {
  modules.push([file, await import(NodeURL.pathToFileURL(NodePath.join(srcDir, file)).href)]);
}
const providerAdapter = await import(NodeURL.pathToFileURL(providerAdapterFile).href);
modules.push(["provider-core/ProviderAdapter.ts", providerAdapter]);

const isSchema = (v) =>
  v !== null && (typeof v === "object" || typeof v === "function") && Schema.isSchema(v);

// `withRecordIdTable` decodes from a pass-through declaration, so its JSON side reads as "any
// value". The wire value is the inner codec's JSON form (plus an `ids` table for clients that
// opted into compact ids). Drop that link in this process's AST so the inner form is generated.
const isPassThrough = (a) => {
  if (a._tag !== "Declaration" || a.typeParameters.length !== 0) return false;
  const f = a.annotations?.toCodecJson;
  if (typeof f !== "function") return false;
  try {
    return f([]) === undefined;
  } catch {
    return false;
  }
};
const passThroughDropped = [];
const visited = new Set();
const dropPassThrough = (ast) => {
  if (visited.has(ast)) return;
  visited.add(ast);
  const enc = ast.encoding;
  if (enc !== undefined && enc.length > 0 && isPassThrough(enc[enc.length - 1].to)) {
    Object.defineProperty(ast, "encoding", {
      value: enc.length > 1 ? enc.slice(0, -1) : undefined,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    passThroughDropped.push(ast);
  }
  for (const link of ast.encoding ?? []) dropPassThrough(link.to);
  if (ast._tag === "Suspend") dropPassThrough(ast.thunk());
  else if ("recur" in ast)
    ast.recur((x) => {
      dropPassThrough(x);
      return x;
    });
  else if (ast._tag === "TemplateLiteral") ast.parts.forEach(dropPassThrough);
};
const codecOf = (ast) => Schema.toCodecJson(Schema.make(ast)).ast;
const encodedOwner = (ast) => {
  let a = codecOf(ast);
  dropPassThrough(a);
  while (a.encoding !== undefined && a.encoding.length > 0)
    a = a.encoding[a.encoding.length - 1].to;
  return SchemaAST.getContextOwner(a);
};

// owner AST -> export name. The first module (sorted) and the shortest name win on aliases.
const nameOf = new Map();
const namedSchemas = new Map();
for (const [, mod] of modules) {
  for (const [name, value] of Object.entries(mod).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (!isSchema(value) || !/^[A-Z]/.test(name)) continue;
    let owner;
    try {
      owner = encodedOwner(value.ast);
    } catch {
      continue;
    }
    if (namedSchemas.has(name)) continue;
    namedSchemas.set(name, value);
    // Effect 4 brands are type-level only (`brand` keeps the same AST), and every id encodes to the
    // one `Schema.String` node. Naming primitives would leak one export's name into every string.
    if (!["Objects", "Union", "Arrays"].includes(owner._tag)) continue;
    const prev = nameOf.get(owner);
    if (prev === undefined || name.length < prev.length) nameOf.set(owner, name);
  }
}

// RPC methods.
const { OfficialWsRpcGroup, ForkWsRpcGroup } = await import(
  NodeURL.pathToFileURL(NodePath.join(srcDir, "rpc.ts")).href
);
const methods = [];
for (const [group, origin] of [
  [OfficialWsRpcGroup, "official"],
  [ForkWsRpcGroup, "fork"],
]) {
  for (const rpc of group.requests.values()) {
    const stream = RpcSchema.isStreamSchema(rpc.successSchema);
    const parts = stream
      ? {
          payload: rpc.payloadSchema,
          item: rpc.successSchema.success,
          error: rpc.successSchema.error,
        }
      : { payload: rpc.payloadSchema, success: rpc.successSchema, error: rpc.errorSchema };
    // A stream's request-level error (rpc.errorSchema) merges into the stream error on the wire.
    if (stream && !SchemaAST.isNever(rpc.errorSchema.ast)) parts.requestError = rpc.errorSchema;
    methods.push({ tag: rpc._tag, stream, origin, parts });
  }
}
methods.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));

const pascal = (s) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");

// Roots: the client's wire. Every RPC method part, the HTTP API's exported schemas (auth,
// pairing, snapshots), the provider event, and the placeholder schemas. Other exports only lend
// their names. Generating all ~1,300 exports doubled compile time for types nobody sends.
const ROOT_MODULES = new Set([
  "environmentHttp.ts",
  "auth.ts",
  "orchestrationV2.ts",
  "provider-core/ProviderAdapter.ts",
]);
const EXTRA_ROOTS = [
  "ModelSelection",
  "RuntimeMode",
  "ProviderInteractionMode",
  "ChatAttachment",
  "ProviderApprovalDecision",
  "ProviderUserInputAnswers",
  "PullRequestDiffInput",
  "PullRequestDiffResult",
];
const rootNames = new Set(EXTRA_ROOTS);
for (const [file, mod] of modules) {
  if (!ROOT_MODULES.has(file)) continue;
  for (const [name, value] of Object.entries(mod))
    if (namedSchemas.get(name) === value) rootNames.add(name);
}
const roots = [];
for (const [name, schema] of namedSchemas)
  if (rootNames.has(name)) roots.push({ hint: name, ast: schema.ast });
for (const m of methods) {
  for (const [part, schema] of Object.entries(m.parts)) {
    roots.push({ hint: pascal(m.tag) + pascal(part), ast: schema.ast, method: m.tag, part });
  }
}

// Secret fields: the contract's own `isSecretSetting` (a `settingsSecret` key annotation or a
// password form control), a `Redacted` value, and a field named `secret` (the webhook signature
// and the secret answer carry no mark). The IR drops annotations, so each is keyed by its
// struct's field names; `objectType` writes a `Debug` that prints `<redacted>` for these.
const { isSecretSetting } = await import(NodeURL.pathToFileURL(NodePath.join(srcDir, "settings.ts")).href);
const secretFieldKeys = new Set();
const fieldSetKey = (names, field) => `${[...names].map(String).sort().join(",")}|${String(field)}`;
{
  const seen = new Set();
  const hasRedacted = (a, depth = 0) => {
    if (!a || depth > 8) return false;
    if (a._tag === "Declaration" && String(a.annotations?.expected ?? "").includes("Redacted")) return true;
    if (a._tag === "Suspend") return false;
    return [...(a.types ?? []), ...(a.typeParameters ?? [])].some((t) => hasRedacted(t, depth + 1));
  };
  const walk = (a) => {
    if (!a || seen.has(a)) return;
    seen.add(a);
    if (a._tag === "Objects") {
      const names = a.propertySignatures.map((ps) => ps.name);
      for (const ps of a.propertySignatures) {
        if (typeof ps.name === "string" && (ps.name === "secret" || isSecretSetting(Schema.make(ps.type)) || hasRedacted(ps.type)))
          secretFieldKeys.add(fieldSetKey(names, ps.name));
        walk(ps.type);
      }
      for (const sig of a.indexSignatures ?? []) walk(sig.type);
    }
    for (const t of [...(a.types ?? []), ...(a.typeParameters ?? []), ...(a.elements ?? []), ...(a.rest ?? [])]) walk(t);
    if (a._tag === "Suspend") walk(a.thunk());
    for (const link of a.encoding ?? []) walk(link.to);
  };
  for (const r of roots) walk(r.ast);
}

const codecAsts = roots.map((r) => codecOf(r.ast));
codecAsts.forEach(dropPassThrough);

// Optional fields whose value admits a declared null (`Schema.optionalKey(Schema.NullOr(T))`):
// the wire tells missing from null there. `Schema.optional(T)` is an Undefined the JSON codec
// encodes as null, so its null means missing. The IR shows both as `T | null`, so each is keyed
// by its struct's field names, as secret fields are.
const nullableFieldKeys = new Set();
{
  const seen = new Set();
  const declaresNull = (a, depth = 0) =>
    a !== undefined &&
    depth < 8 &&
    (a._tag === "Null" || (a._tag === "Union" && a.types.some((t) => declaresNull(t, depth + 1))));
  const walk = (a) => {
    if (!a || seen.has(a)) return;
    seen.add(a);
    if (a._tag === "Objects") {
      const names = a.propertySignatures.map((ps) => ps.name);
      for (const ps of a.propertySignatures) {
        if (ps.type.context?.isOptional && declaresNull(ps.type))
          nullableFieldKeys.add(fieldSetKey(names, ps.name));
        walk(ps.type);
      }
      for (const sig of a.indexSignatures ?? []) walk(sig.type);
    }
    for (const t of [...(a.types ?? []), ...(a.typeParameters ?? []), ...(a.elements ?? []), ...(a.rest ?? [])]) walk(t);
    if (a._tag === "Suspend") walk(a.thunk());
    for (const link of a.encoding ?? []) walk(link.to);
  };
  codecAsts.forEach(walk);
}
const doc = SchemaRepresentation.toRepresentations(codecAsts, {
  referencePolicy: ({ ast, occurrences, identifier }) => {
    const name = nameOf.get(ast);
    if (name !== undefined) return name;
    if (identifier !== undefined) return identifier;
    if (occurrences > 1 && (ast._tag === "Objects" || ast._tag === "Union")) return "Anon";
    return undefined;
  },
});
const refs = doc.references;

// ids.rs names stay reserved so no generated item takes them.
const ID_TYPES = new Set(
  NodeFS.readFileSync(NodePath.join(crateDir, "src/ids.rs"), "utf8")
    .match(/string_id!\(([\s\S]*?)\);/)[1]
    .split(/[\s,]+/)
    .filter(Boolean),
);
const RUST_KEYWORDS = new Set(
  "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self static struct super trait true type unsafe use where while abstract become box do final macro override priv typeof unsized virtual yield try gen".split(
    " ",
  ),
);

const report = { opaque: [], lax: [] };
const items = new Map(); // rust name -> code
const itemOrder = [];
const rustNameOfRef = new Map(); // $ref -> rust name, or null when inlined
const usedNames = new Set([...ID_TYPES, "Never", "JsNumber", "Json", "Opaque", "Map"]);
const literalTypes = new Map(); // JSON literal -> lit type name
const unionTags = new Map(); // tagged union name -> its tag values, in member order
const usedLiteralNames = new Set();

const deref = (r) => {
  const seen = new Set();
  while (r && (r._tag === "Reference" || r._tag === "Suspend")) {
    if (r._tag === "Suspend") r = r.thunk;
    else {
      if (seen.has(r.$ref)) return r;
      seen.add(r.$ref);
      r = refs[r.$ref];
    }
  }
  return r;
};

const hasCheck = (r, id) => (r.checks ?? []).some((c) => checkIds(c).includes(id));
const checkIds = (c) =>
  c._tag === "FilterGroup" ? c.checks.flatMap(checkIds) : [c.representation?.id ?? "custom"];

const flattenUnion = (r) => {
  const out = [];
  const visit = (x) => {
    const d = deref(x);
    if (d._tag === "Union") d.types.forEach(visit);
    else if (d._tag !== "Never") out.push(x);
  };
  visit(r);
  return out;
};

const uniqueName = (base) => {
  let name = base || "Anon";
  if (/^[0-9]/.test(name)) name = "N" + name;
  let n = name;
  let i = 1;
  while (usedNames.has(n)) n = `${name}${++i}`;
  usedNames.add(n);
  return n;
};

const snake = (s) => {
  const out = s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return out === "" ? "field" : /^[0-9]/.test(out) ? `n${out}` : out;
};
const camelOfSnake = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const rustIdent = (s) =>
  RUST_KEYWORDS.has(s) ? (s === "self" || s === "crate" || s === "super" ? `${s}_` : `r#${s}`) : s;
const strLit = (s) => JSON.stringify(s);

const literalType = (value) => {
  const key = JSON.stringify(value);
  let name = literalTypes.get(key);
  if (name !== undefined) return `lit::${name}`;
  let base =
    typeof value === "string"
      ? pascal(value) || "Empty"
      : typeof value === "number"
        ? `N${String(value).replace(/[^0-9]/g, "_")}`
        : pascal(String(value));
  if (/^[0-9]/.test(base)) base = "V" + base;
  if (base === "Self") base = "Self_";
  name = base;
  let i = 1;
  while (usedLiteralNames.has(name)) name = `${base}${++i}`;
  usedLiteralNames.add(name);
  literalTypes.set(key, name);
  return `lit::${name}`;
};

const opaque = (path, why) => {
  report.opaque.push({ path, why });
  return "Opaque";
};
const lax = (path, why) => {
  report.lax.push({ path, why });
};

// Cycles: a struct field that reaches its own type without Vec/Map/Option<Box> needs Box.
const recursiveRefs = new Set();
{
  const state = new Map();
  const visit = (ref) => {
    if (state.get(ref) === "done") return;
    if (state.get(ref) === "active") {
      recursiveRefs.add(ref);
      return;
    }
    state.set(ref, "active");
    const walk = (r) => {
      if (!r || typeof r !== "object") return;
      if (r._tag === "Reference") return visit(r.$ref);
      if (r._tag === "Suspend") return walk(r.thunk);
      for (const v of Object.values(r)) {
        if (v && typeof v === "object") {
          if (Array.isArray(v)) v.forEach(walk);
          else walk(v);
        }
      }
    };
    walk(refs[ref]);
    state.set(ref, "done");
  };
  Object.keys(refs).forEach(visit);
}

const DERIVE = "#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]";

const emit = (name, code) => {
  items.set(name, code);
  itemOrder.push(name);
};

// Rust type for a representation. `hint` names any item this creates.
const typeOf = (r, hint, path) => {
  switch (r._tag) {
    case "Reference":
      return refType(r.$ref, hint, path);
    case "Suspend":
      return typeOf(r.thunk, hint, path);
    case "Declaration":
      if (r.representation?.id === "effect/schema/Json") return "Json";
      return opaque(path, `declaration ${JSON.stringify(r.representation?.id)}`);
    case "Unknown":
    case "Any":
    case "ObjectKeyword":
      return "Json";
    case "Null":
      return "()";
    case "Never":
      return "Never";
    case "String":
      return "String";
    case "TemplateLiteral":
      lax(path, "template literal decoded as any string");
      return "String";
    case "Number":
      return hasCheck(r, "effect/schema/isInt") ? "i64" : "f64";
    case "Boolean":
      return "bool";
    case "Literal":
      return literalType(r.literal);
    case "Enum":
      return opaque(path, "enum");
    case "Arrays":
      return arrayType(r, hint, path);
    case "Objects":
      return objectType(r, hint, path, null);
    case "Union":
      return unionType(r, hint, path);
    default:
      return opaque(path, `unsupported ${r._tag}`);
  }
};

const refType = (ref, hint, path) => {
  if (rustNameOfRef.has(ref)) return rustNameOfRef.get(ref) ?? typeOf(refs[ref], hint, path);
  const target = refs[ref];
  const exported =
    nameOf.has(ref) ||
    (/^[A-Z]/.test(ref) &&
      !ref.startsWith("Anon") &&
      !ref.startsWith("Objects_") &&
      !ref.startsWith("Union_"));
  const base = exported ? ref.replace(/_\d+$/, "") : hint;
  // Only objects and unions that need their own item get a name; the rest inline.
  const d = deref(target);
  const needsItem =
    d._tag === "Objects" ||
    (d._tag === "Union" && unionNeedsItem(d)) ||
    (exported && (d._tag === "String" || d._tag === "Arrays"));
  if (!needsItem) {
    rustNameOfRef.set(ref, null);
    return typeOf(target, hint, path);
  }
  const name = uniqueName(base);
  rustNameOfRef.set(ref, name);
  if (d._tag === "String") {
    emit(name, `pub type ${name} = String;`);
    return name;
  }
  if (d._tag === "Arrays") {
    const t = typeOf(target, name + "Item", `${name}`);
    emit(name, `pub type ${name} = ${t};`);
    return name;
  }
  const t = d._tag === "Objects" ? objectType(d, name, name, name) : unionType(d, name, name, name);
  if (t !== name) emit(name, `pub type ${name} = ${t};`);
  return name;
};

const unionNeedsItem = (u) => {
  const members = flattenUnion(u);
  const nonNull = members.filter((m) => deref(m)._tag !== "Null");
  if (nonNull.length < members.length) return false;
  if (nonNull.length <= 1) return false;
  if (isJsNumber(nonNull)) return false;
  if (isStringish(nonNull)) return false;
  return true;
};

const isJsNumber = (members) => {
  const ds = members.map(deref);
  const lits = ds.filter((d) => d._tag === "Literal").map((d) => d.literal);
  return (
    ds.length === 4 &&
    ds.filter((d) => d._tag === "Number").length === 1 &&
    ["Infinity", "-Infinity", "NaN"].every((v) => lits.includes(v))
  );
};
// A union of `string` with string literals or template literals is just a string on the wire.
const isStringish = (members) => {
  const ds = members.map(deref);
  return (
    ds.some((d) => d._tag === "String" || d._tag === "TemplateLiteral") &&
    ds.every(
      (d) =>
        d._tag === "String" ||
        d._tag === "TemplateLiteral" ||
        (d._tag === "Literal" && typeof d.literal === "string"),
    )
  );
};

const arrayType = (r, hint, path) => {
  if (r.elements.length === 0 && r.rest.length === 1)
    return `Vec<${typeOf(r.rest[0], hint + "Item", `${path}[]`)}>`;
  if (r.elements.length === 0 && r.rest.length === 0) return "[(); 0]";
  if (r.rest.length === 0 && r.elements.every((e) => !e.isOptional)) {
    const ts = r.elements.map((e, i) => typeOf(e.type, `${hint}${i}`, `${path}[${i}]`));
    return `(${ts.join(", ")}${ts.length === 1 ? "," : ""})`;
  }
  if (
    r.rest.length === 1 &&
    r.elements.every((e) => !e.isOptional && JSON.stringify(e.type) === JSON.stringify(r.rest[0]))
  ) {
    lax(path, `array needs at least ${r.elements.length} item(s); not enforced`);
    return `Vec<${typeOf(r.rest[0], hint + "Item", `${path}[]`)}>`;
  }
  return opaque(path, "tuple with optional elements or a rest after elements");
};

// Field type and serde attributes for a property.
const fieldOf = (prop, owner, path, keys) => {
  const key = prop.name;
  const t = prop.type;
  const hint = owner + pascal(String(key));
  const d = deref(t);
  const attrs = [];
  let ty;
  const members = d._tag === "Union" ? flattenUnion(t) : [t];
  const nullCount = members.filter((m) => deref(m)._tag === "Null").length;
  const rest = members.filter((m) => deref(m)._tag !== "Null");
  // `T | null | null`: Schema.optional(Schema.NullOr(T)). The wire tells missing from null.
  // Also when the value type itself admits null (Json, Unknown, Defect): `null` is a value there.
  const admitsNull = (m) => {
    const dm = deref(m);
    return (
      dm._tag === "Unknown" ||
      dm._tag === "Any" ||
      (dm._tag === "Declaration" && dm.representation?.id === "effect/schema/Json")
    );
  };
  const nestedNull =
    nullCount >= 2 ||
    rest.some(admitsNull) ||
    nullableFieldKeys.has(fieldSetKey(keys, key));
  const inner = () =>
    rest.length === 1
      ? typeOf(rest[0], hint, `${path}.${key}`)
      : unionOf(rest, hint, `${path}.${key}`);
  if (nullCount > 0 && rest.length > 0) {
    let it = inner();
    if (recursive(t, owner)) it = `Box<${it}>`;
    if (prop.isOptional && nestedNull) {
      ty = `Option<Option<${it}>>`;
      attrs.push(
        `default, skip_serializing_if = "Option::is_none", with = "crate::support::double_option"`,
      );
    } else if (prop.isOptional) {
      ty = `Option<${it}>`;
      attrs.push(`default, skip_serializing_if = "Option::is_none"`);
    } else {
      ty = `Option<${it}>`;
    }
  } else if (prop.isOptional) {
    let it = typeOf(t, hint, `${path}.${key}`);
    if (recursive(t, owner)) it = `Box<${it}>`;
    ty = `Option<${it}>`;
    attrs.push(`default, skip_serializing_if = "Option::is_none"`);
  } else {
    ty = typeOf(t, hint, `${path}.${key}`);
    if (recursive(t, owner)) ty = `Box<${ty}>`;
  }
  const rname = rustIdent(snake(String(key)));
  const plain = rname.replace(/^r#/, "");
  if (camelOfSnake(plain) !== key) attrs.unshift(`rename = ${strLit(String(key))}`);
  return { rname, ty, attrs, key };
};

// True when a field's type refers back to the struct being generated (needs Box).
const recursive = (t) => {
  const direct = (x) => {
    while (x._tag === "Suspend") x = x.thunk;
    return x._tag === "Reference" && recursiveRefs.has(x.$ref);
  };
  return direct(t) || (deref(t)._tag === "Union" && flattenUnion(t).some(direct));
};

const objectType = (r, hint, path, forcedName) => {
  if (r.propertySignatures.length === 0 && r.indexSignatures.length === 0) {
    const name = forcedName ?? uniqueName(hint);
    emit(name, `${DERIVE}\npub struct ${name} {}`);
    return name;
  }
  const mapValue = () => {
    if (r.indexSignatures.length > 1) {
      return opaque(path, "several index signatures");
    }
    const sig = r.indexSignatures[0];
    const p = deref(sig.parameter);
    if (p._tag !== "String" && p._tag !== "TemplateLiteral")
      return opaque(path, `index key ${p._tag}`);
    if (p._tag === "TemplateLiteral" || (p.checks ?? []).length)
      lax(path, "record key constraint not enforced");
    return typeOf(sig.type, hint + "Value", `${path}{}`);
  };
  if (r.propertySignatures.length === 0) {
    const v = mapValue();
    return v === "Opaque" && report.opaque.at(-1)?.path === path ? "Opaque" : `Map<String, ${v}>`;
  }
  const name = forcedName ?? uniqueName(hint);
  usedNames.add(name);
  // Reserve before recursing so self references resolve.
  const fields = [];
  for (const prop of r.propertySignatures) {
    if (typeof prop.name !== "string") {
      return opaque(path, "symbol key");
    }
    fields.push(fieldOf(prop, name, path, r.propertySignatures.map((p) => p.name)));
  }
  const seen = new Set();
  for (const f of fields) {
    while (seen.has(f.rname)) f.rname += "_";
    seen.add(f.rname);
  }
  let body = fields
    .map((f) => {
      const a = f.attrs.length ? `    #[serde(${f.attrs.join(", ")})]\n` : "";
      return `${a}    pub ${f.rname}: ${f.ty},`;
    })
    .join("\n");
  if (r.indexSignatures.length > 0) {
    const v = mapValue();
    body += `\n    #[serde(flatten)]\n    pub extra: Map<String, ${v}>,`;
    lax(path, "struct with index signature uses serde flatten");
  }
  const keys = r.propertySignatures.map((p) => p.name);
  const secret = fields.map((f, i) => secretFieldKeys.has(fieldSetKey(keys, r.propertySignatures[i].name)));
  if (!secret.some(Boolean)) {
    emit(name, `${DERIVE}\n#[serde(rename_all = "camelCase")]\npub struct ${name} {\n${body}\n}`);
    return name;
  }
  // A secret never reaches a log line, an error text or a test snapshot through `Debug`.
  const debugFields = fields
    .map((f, i) =>
      secret[i]
        ? `.field(${strLit(f.rname)}, &"<redacted>")`
        : `.field(${strLit(f.rname)}, &self.${f.rname})`,
    )
    .join("");
  const extra = r.indexSignatures.length > 0 ? `.field("extra", &self.extra)` : "";
  emit(
    name,
    `${DERIVE.replace("Debug, ", "")}\n#[serde(rename_all = "camelCase")]\npub struct ${name} {\n${body}\n}\n\nimpl ::std::fmt::Debug for ${name} {\n    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {\n        f.debug_struct(${strLit(name)})${debugFields}${extra}.finish()\n    }\n}`,
  );
  return name;
};

const unionType = (r, hint, path, forcedName) => {
  const members = flattenUnion(r);
  const nonNull = members.filter((m) => deref(m)._tag !== "Null");
  if (nonNull.length === 0) return members.length ? "()" : "Never";
  if (nonNull.length < members.length) {
    const inner =
      nonNull.length === 1 ? typeOf(nonNull[0], hint, path) : unionOf(nonNull, hint, path);
    return `Option<${inner}>`;
  }
  return nonNull.length === 1
    ? typeOf(nonNull[0], hint, path)
    : unionOf(nonNull, hint, path, forcedName);
};

const variantName = (s) => {
  const n = pascal(String(s));
  return n === "" ? "Empty" : /^[0-9]/.test(n) ? `V${n}` : n === "Self" ? "Self_" : n;
};

const unionOf = (members, hint, path, forcedName) => {
  const ds = members.map(deref);
  if (isJsNumber(members)) return "JsNumber";
  if (isStringish(members)) {
    if (ds.some((d) => d._tag === "TemplateLiteral") && !ds.some((d) => d._tag === "String"))
      lax(path, "literals plus template literal decoded as any string");
    return "String";
  }
  // All string literals: a unit enum.
  if (ds.every((d) => d._tag === "Literal" && typeof d.literal === "string")) {
    const name = forcedName ?? uniqueName(hint);
    const values = [...new Set(ds.map((d) => d.literal))];
    const used = new Set();
    const variants = values.map((v) => {
      let vn = variantName(v);
      while (used.has(vn)) vn += "_";
      used.add(vn);
      return `    #[serde(rename = ${strLit(v)})]\n    ${vn},`;
    });
    emit(
      name,
      `#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]\npub enum ${name} {\n${variants.join("\n")}\n}`,
    );
    return name;
  }
  // Objects sharing a string-literal discriminator: a tagged union. Members whose tag is a plain
  // string are catch-alls (ForwardCompatibleUnion); they are tried only for unknown tags, which
  // matches their own "a known tag must decode in full" checks. Members sharing a tag value are
  // tried in order, as Effect does.
  if (ds.every((d) => d._tag === "Objects")) {
    const disc = findDiscriminator(ds);
    if (disc !== undefined) {
      const name = forcedName ?? uniqueName(hint);
      const usedV = new Set();
      const variants = [];
      const byValue = new Map();
      const fallback = [];
      members.forEach((m, i) => {
        const values = disc.values[i];
        let base = values === null ? "Unknown" : variantName(values[0]);
        let vn = base;
        let n = 1;
        while (usedV.has(vn)) vn = `${base}${++n}`;
        usedV.add(vn);
        const ty = typeOf(m, name + vn, `${path}<${values === null ? "*" : values[0]}>`);
        variants.push(`${vn}(${ty})`);
        if (values === null || disc.optional[i]) fallback.push(`${vn}(${ty})`);
        if (values !== null)
          for (const v of values) byValue.set(v, [...(byValue.get(v) ?? []), `${vn}(${ty})`]);
      });
      unionTags.set(
        name,
        disc.values.flatMap((values) => values ?? []),
      );
      // Group values that dispatch to the same candidate list.
      const groups = new Map();
      for (const [v, cands] of byValue) {
        const k = cands.join(", ");
        groups.set(k, [...(groups.get(k) ?? []), v]);
      }
      const dispatch = [...groups].map(
        ([cands, vs]) => `        ${vs.map(strLit).join(" | ")} => [${cands}],`,
      );
      emit(
        name,
        `tagged_union! {\n    ${name}, ${strLit(disc.key)},\n    variants { ${variants.join(", ")} },\n    dispatch {\n${dispatch.join("\n")}\n    },\n    fallback [${fallback.join(", ")}]\n}`,
      );
      return name;
    }
    const keyed = findKeys(ds);
    if (keyed !== undefined) {
      const name = forcedName ?? uniqueName(hint);
      const arms = members.map((m, i) => {
        const vn = variantName(keyed[i]);
        return `        ${strLit(keyed[i])} => ${vn}(${typeOf(m, name + vn, `${path}<${keyed[i]}>`)}),`;
      });
      emit(name, `keyed_union! {\n    ${name}, {\n${arms.join("\n")}\n    }\n}`);
      return name;
    }
  }
  // Number literals: an enum over those values.
  if (ds.every((d) => d._tag === "Literal" && typeof d.literal === "number")) {
    const name = forcedName ?? uniqueName(hint);
    const values = [...new Set(ds.map((d) => d.literal))];
    const arms = values.map(
      (v) =>
        `        ${"V" + String(v).replace("-", "Minus").replace(".", "_")} = ${Number.isInteger(v) ? v.toFixed(1) : v},`,
    );
    emit(name, `number_literals! {\n    ${name}, {\n${arms.join("\n")}\n    }\n}`);
    return name;
  }
  // At most one member per JSON kind: dispatch on the kind.
  const kinds = new Map();
  for (let i = 0; i < members.length; i++) {
    const k = jsonKind(ds[i]);
    if (k === undefined || kinds.has(k)) {
      kinds.clear();
      break;
    }
    kinds.set(k, members[i]);
  }
  // Merge string literals into one string enum member.
  if (kinds.size === 0) {
    const strLits = ds.filter((d) => d._tag === "Literal" && typeof d.literal === "string");
    const others = members.filter(
      (_, i) => !(ds[i]._tag === "Literal" && typeof ds[i].literal === "string"),
    );
    if (strLits.length > 1 && others.every((m) => jsonKind(deref(m)) !== "string")) {
      const merged = {
        _tag: "Union",
        types: members.filter(
          (_, i) => ds[i]._tag === "Literal" && typeof ds[i].literal === "string",
        ),
        checks: [],
      };
      return unionOf([...others, merged], hint, path, forcedName);
    }
  }
  if (kinds.size === members.length) {
    const name = forcedName ?? uniqueName(hint);
    const arms = [...kinds].map(
      ([k, m]) => `        ${k} => ${pascal(k)}(${typeOf(m, name + pascal(k), `${path}<${k}>`)}),`,
    );
    emit(name, `kind_union! {\n    ${name}, {\n${arms.join("\n")}\n    }\n}`);
    return name;
  }
  return opaque(path, `union without a discriminator: ${ds.map(describe).join(" | ")}`);
};

const describe = (d) =>
  d._tag === "Literal"
    ? JSON.stringify(d.literal)
    : d._tag === "Objects"
      ? `{${d.propertySignatures
          .map((p) => String(p.name))
          .slice(0, 4)
          .join(",")}}`
      : d._tag;

const jsonKind = (d) => {
  switch (d._tag) {
    case "String":
    case "TemplateLiteral":
      return "string";
    case "Number":
      return "number";
    case "Boolean":
      return "bool";
    case "Arrays":
      return "array";
    case "Objects":
      return "object";
    case "Literal":
      return typeof d.literal === "string"
        ? "string"
        : typeof d.literal === "number"
          ? "number"
          : typeof d.literal === "boolean"
            ? "bool"
            : undefined;
    case "Union": {
      const ks = new Set(flattenUnion(d).map((m) => jsonKind(deref(m))));
      return ks.size === 1 ? [...ks][0] : undefined;
    }
    default:
      return undefined;
  }
};

const literalValues = (t) => {
  const d = deref(t);
  if (d._tag === "Literal" && typeof d.literal === "string") return [d.literal];
  if (d._tag === "Union") {
    const ms = flattenUnion(d).map(deref);
    if (ms.every((m) => m._tag === "Literal" && typeof m.literal === "string"))
      return ms.map((m) => m.literal);
  }
  return undefined;
};

const isStringKind = (t) => {
  const ms = flattenUnion(t)
    .map(deref)
    .filter((d) => d._tag !== "Null");
  return ms.length === 1 && (ms[0]._tag === "String" || ms[0]._tag === "TemplateLiteral");
};
const findDiscriminator = (ds) => {
  const candidates = ds[0].propertySignatures
    .map((p) => p.name)
    .filter((n) => typeof n === "string");
  const found = [];
  for (const key of candidates) {
    const values = [];
    // Members whose tag is an optional literal: they also decode a value without the tag.
    const optional = [];
    let good = true;
    for (const d of ds) {
      const prop = d.propertySignatures.find((p) => p.name === key);
      if (!prop) {
        good = false;
        break;
      }
      const vals = literalValues(prop.type);
      optional.push(Boolean(prop.isOptional && vals));
      if (vals) values.push(vals);
      else if (isStringKind(prop.type)) values.push(null);
      else {
        good = false;
        break;
      }
    }
    const literal = values.filter((v) => v !== null);
    if (!good || literal.length === 0) continue;
    const all = literal.flat();
    const dupes = all.length - new Set(all).size;
    const catchAlls = values.length - literal.length;
    // A catch-all must come after the literal members it could shadow.
    const lastLiteral = values.findLastIndex((v) => v !== null);
    if (
      values.findIndex((v) => v === null) !== -1 &&
      values.findIndex((v) => v === null) < lastLiteral
    )
      continue;
    // At most one member may own the absent tag, or the order between them is lost.
    const optionals = optional.filter(Boolean).length;
    if (optionals > 1 || (optionals === 1 && catchAlls > 0)) continue;
    found.push({
      key,
      values,
      optional,
      score:
        dupes * 10 +
        catchAlls * 100 +
        optionals * 5 +
        (["type", "_tag", "kind"].includes(key) ? 0 : 1),
    });
  }
  found.sort((a, b) => a.score - b.score || (a.key < b.key ? -1 : 1));
  return found[0];
};

// Objects without a tag where each member has a required key no other member has.
const findKeys = (ds) => {
  const keys = [];
  for (const d of ds) {
    const own = d.propertySignatures
      .filter((p) => !p.isOptional && typeof p.name === "string")
      .map((p) => p.name);
    const unique = own.find((k) =>
      ds.every((o) => o === d || !o.propertySignatures.some((p) => p.name === k)),
    );
    if (unique === undefined) return undefined;
    keys.push(unique);
  }
  return keys;
};

// Generate every root.
const rootTypes = roots.map((root, i) => {
  const r = doc.representations[i];
  if (r._tag === "Reference") return typeOf(r, root.hint, root.hint);
  return typeOf(r, root.hint, root.hint);
});

// Named exports that inlined (e.g. a literal union used once) still get a name.
const exportTypes = new Map();
roots.forEach((root, i) => {
  if (root.method !== undefined) return;
  const t = rootTypes[i];
  if (t === root.hint) exportTypes.set(root.hint, t);
  else if (!usedNames.has(root.hint) && !ID_TYPES.has(root.hint)) {
    usedNames.add(root.hint);
    emit(root.hint, `pub type ${root.hint} = ${t};`);
    exportTypes.set(root.hint, root.hint);
  } else exportTypes.set(root.hint, t);
});

// Dedup: the same anonymous shape inlined in many places (a tool icon union appears in every
// turn item member) generates identical items. Collapse identical bodies to one name, repeat
// until stable, and keep every exported name as an alias.
{
  const exported = new Set(exportTypes.values());
  const nameRe = (n) => new RegExp(`(?<![":\\w])${n}(?!\\w)`, "g");
  const bodyKey = (name, code) => code.replace(nameRe(name), "@");
  let renames = 0;
  for (;;) {
    const groups = new Map();
    for (const name of itemOrder) {
      const code = items.get(name);
      if (code === undefined || code.startsWith("pub type ")) continue;
      const k = bodyKey(name, code);
      (groups.get(k) ?? groups.set(k, []).get(k)).push(name);
    }
    const map = new Map();
    for (const names of groups.values()) {
      if (names.length < 2) continue;
      const canon = [...names].sort(
        (a, b) => exported.has(b) - exported.has(a) || a.length - b.length || (a < b ? -1 : 1),
      )[0];
      for (const n of names) if (n !== canon) map.set(n, canon);
    }
    if (map.size === 0) break;
    renames += map.size;
    const re = new RegExp(`(?<![":\\w])(${[...map.keys()].join("|")})(?!\\w)`, "g");
    const sub = (t) => t.replace(re, (m) => map.get(m));
    for (const [n, canon] of map)
      items.set(n, exported.has(n) ? `pub type ${n} = ${canon};` : undefined);
    for (const name of itemOrder) {
      const code = items.get(name);
      if (code !== undefined && !(map.has(name) && code.startsWith("pub type ")))
        items.set(name, sub(code));
    }
    for (let i = 0; i < rootTypes.length; i++) rootTypes[i] = sub(rootTypes[i]);
    for (const [k, v] of exportTypes)
      if (!map.has(v) || !exported.has(v)) exportTypes.set(k, sub(v));
  }
  for (const name of items.keys()) if (items.get(name) === undefined) items.delete(name);
  report.dedupedItems = renames;
}

// Placeholder names used by the other tracks.
const ALIASES = {
  Command: "OrchestrationV2Command",
  DispatchCommandResult: "OrchestrationV2DispatchCommandResult",
  DispatchCommandError: "OrchestrationV2DispatchCommandError",
  GetShellSnapshotError: "OrchestrationV2GetShellSnapshotError",
  GetThreadProjectionError: "OrchestrationV2GetThreadProjectionError",
  SubscribeShellInput: "OrchestrationV2SubscribeShellInput",
  ShellStreamItem: "OrchestrationV2ShellStreamItem",
  SubscribeThreadInput: "OrchestrationV2SubscribeThreadInput",
  ThreadStreamItem: "OrchestrationV2ThreadStreamItem",
  ThreadLaunchInput: "OrchestrationV2ThreadLaunchInput",
  ThreadLaunchResult: "OrchestrationV2ThreadLaunchResult",
  ThreadLaunchError: "OrchestrationV2ThreadLaunchError",
  DomainEvent: "OrchestrationV2DomainEvent",
  ModelSelection: "ModelSelection",
  RuntimeMode: "RuntimeMode",
  InteractionMode: "ProviderInteractionMode",
  ProviderCapabilities: "OrchestrationV2ProviderCapabilities",
  AppThread: "OrchestrationV2AppThread",
  ProviderSession: "OrchestrationV2ProviderSession",
  ProviderThread: "OrchestrationV2ProviderThread",
  ProviderTurn: "OrchestrationV2ProviderTurn",
  ExecutionNode: "OrchestrationV2ExecutionNode",
  Subagent: "OrchestrationV2Subagent",
  ConversationMessage: "OrchestrationV2ConversationMessage",
  TurnItem: "OrchestrationV2TurnItem",
  RuntimeRequest: "OrchestrationV2RuntimeRequest",
  PlanArtifact: "OrchestrationV2PlanArtifact",
  ProviderFailure: "OrchestrationV2ProviderFailure",
  ProviderRetry: "OrchestrationV2ProviderRetry",
  ChatAttachment: "ChatAttachment",
  ApprovalDecision: "ProviderApprovalDecision",
  UserInputAnswers: "ProviderUserInputAnswers",
};
// Every tag of the command union, so a check can hold the engine to the contract.
const commandUnion = exportTypes.get(ALIASES.Command);
const commandTags = unionTags.get(commandUnion);
if (commandTags === undefined) throw new Error(`${commandUnion} is not a tagged union`);
const commandTypesLine = `/// Every \`type\` of \`${ALIASES.Command}\`, in contract order.\npub const COMMAND_TYPES: &[&str] = &[${commandTags.map(strLit).join(", ")}];`;

const aliasLines = [];
for (const [alias, target] of Object.entries(ALIASES)) {
  const t = exportTypes.get(target);
  if (t === undefined) throw new Error(`placeholder ${alias}: ${target} is not an exported schema`);
  if (alias !== t) aliasLines.push(`pub type ${alias} = ${t};`);
}

// Per-method types.
const methodModules = [];
const methodRows = [];
let methodsFullyTyped = 0;
let methodIndex = roots.findIndex((r) => r.method !== undefined);
for (const m of methods) {
  const row = { tag: m.tag, stream: m.stream, origin: m.origin };
  const lines = [];
  let typed = true;
  for (const part of Object.keys(m.parts)) {
    const t = rootTypes[methodIndex++];
    const alias = {
      payload: "Payload",
      success: "Success",
      item: "Item",
      error: "Error",
      requestError: "RequestError",
    }[part];
    lines.push(
      `    pub type ${alias} = ${t.replace(/^(?!crate::)([A-Z]\w*)/, "super::super::$1")};`,
    );
    row[part] = t;
    if (typeUsesJsonFallback(t)) typed = false;
  }
  if (typed) methodsFullyTyped++;
  row.typed = typed;
  methodRows.push(row);
  methodModules.push({ tag: m.tag, lines });
}

function typeUsesJsonFallback(t) {
  // A method is fully typed when none of its types reach an opaque fallback.
  return reachesOpaque(t, new Set());
}
function reachesOpaque(t, seen) {
  for (const word of t.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (word === "Opaque") return true;
    if (seen.has(word)) continue;
    seen.add(word);
    const code = items.get(word);
    if (
      code !== undefined &&
      reachesOpaque(
        code
          .replace(/#\[serde\([^\]]*\)\]/g, "")
          .replace(/^[^\n]*\n/, "")
          .replace(/(pub (struct|enum|type)|tagged_union!|kind_union!) \S+/, ""),
        seen,
      )
    )
      return true;
  }
  return false;
}

// Group method modules: `rpc::orchestration::dispatch_command::Payload`.
const groups = new Map();
for (const mm of methodModules) {
  const [area, ...rest] = mm.tag.split(".");
  const g = groups.get(area) ?? [];
  g.push({ name: snake(rest.join("_")), lines: mm.lines, tag: mm.tag });
  groups.set(area, g);
}
let rpcModule =
  "/// Payload, success, stream item and error types of every RPC method, by tag.\npub mod rpc {\n";
for (const [area, ms] of groups) {
  rpcModule += `    pub mod ${rustIdent(snake(area))} {\n`;
  for (const mm of ms) {
    rpcModule += `        /// \`${mm.tag}\`\n        pub mod ${rustIdent(mm.name)} {\n            use crate::{*, support::*};\n${mm.lines.map((l) => "        " + l.replace("super::super::", "")).join("\n")}\n        }\n`;
  }
  rpcModule += "    }\n";
}
rpcModule += "}\n";

const literalCode = [...literalTypes]
  .sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([json, name]) => `    literal!(${name} = ${json.startsWith('"') ? json : json});`)
  .join("\n");

const header = `// @generated by tools/gen-contract.mjs from packages/contracts. Do not edit.
// Regenerate: node crates/conn-contract/tools/gen-contract.mjs
#![allow(
    clippy::all,
    clippy::pedantic,
    clippy::allow_attributes,
    non_camel_case_types,
    dead_code,
    unused_imports,
    reason = "generated by gen-contract.mjs"
)]

use serde::{Deserialize, Serialize};

use crate::ids::*;
use crate::support::{JsNumber, Json, Map, Never, Opaque, keyed_union, kind_union, literal, number_literals, tagged_union};
`;

const body = itemOrder
  .filter((n) => items.has(n))
  .map((n) => items.get(n))
  .join("\n\n");
const generated = `${header}

/// Single-value types for literal fields. Each serializes to its value and rejects any other.
pub mod lit {
    use crate::support::literal;
${literalCode}
}

${body}

// Placeholder names (the contract name without \`OrchestrationV2\`).
${aliasLines.join("\n")}

${commandTypesLine}

${rpcModule}`;

// Registry for the round-trip tests: each root under a key. Named roots use their Rust name;
// method parts use their `rpc::` alias, so every method has a fixture target.
const PART_ALIAS = {
  payload: "Payload",
  success: "Success",
  item: "Item",
  error: "Error",
  requestError: "RequestError",
};
const rootKeys = roots.map((root) => {
  if (root.method !== undefined) {
    const [area, ...rest] = root.method.split(".");
    return `rpc::${rustIdent(snake(area))}::${rustIdent(snake(rest.join("_")))}::${PART_ALIAS[root.part]}`;
  }
  const t = exportTypes.get(root.hint);
  return /^[A-Za-z_]\w*$/.test(t) && !["Json", "Opaque", "Never"].includes(t) ? t : undefined;
});
const registryKeys = [...new Set(rootKeys.filter((k) => k !== undefined))].sort();
const registry = `// @generated by tools/gen-contract.mjs. Do not edit.
/// Decodes \`value\` as the generated type under \`key\` and encodes it again.
pub(crate) fn round_trip(key: &str, value: serde_json::Value) -> Option<Result<serde_json::Value, serde_json::Error>> {
    fn go<T: serde::Serialize + serde::de::DeserializeOwned>(value: serde_json::Value) -> Result<serde_json::Value, serde_json::Error> {
        let typed: T = serde_json::from_value(value)?;
        serde_json::to_value(&typed)
    }
    Some(match key {
${registryKeys.map((n) => `        ${strLit(n)} => go::<conn_contract::${n}>(value),`).join("\n")}
        _ => return None,
    })
}
`;

// Fixtures: values sampled from each root schema with Effect's Arbitrary, encoded with the real
// JSON codec. Unions are sampled member by member so every tag gets a value.
const { Arbitrary, Effect } = await imp("effect");
const CORE =
  /^(OrchestrationV2|rpc::orchestration::|ProviderAdapterV2|ModelSelection|ChatAttachment|Provider)/;
// Explicit `undefined` encodes as `null` but decodes like a missing key; drop it so the fixture
// is canonical. Lone UTF-16 surrogates have no Rust `String` form (see the report); replace them.
const dropUndefined = (v) => {
  if (Array.isArray(v)) return v.map(dropUndefined);
  if (v === null || typeof v !== "object" || v instanceof Date) return v;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null && !Object.values(v).includes(undefined))
    return v;
  const descriptors = Object.getOwnPropertyDescriptors(v);
  for (const k of Reflect.ownKeys(descriptors)) {
    const d = descriptors[k];
    if ("value" in d) {
      if (d.value === undefined && d.enumerable) delete descriptors[k];
      else d.value = dropUndefined(d.value);
    }
  }
  return Object.create(proto, descriptors);
};
const wellFormed = (v) =>
  typeof v === "string"
    ? v.toWellFormed()
    : Array.isArray(v)
      ? v.map(wellFormed)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k.toWellFormed(), wellFormed(x)]))
        : v;
const fixtureStats = { roots: 0, samples: 0, sampleFailures: 0, encodeForbidden: 0 };
const fixtures = [];
const seen = new Set();
roots.forEach((root, i) => {
  const key = rootKeys[i];
  if (key === undefined || seen.has(key)) return;
  seen.add(key);
  const schema = Schema.make(root.ast);
  const codec = Schema.toCodecJson(schema);
  const encode = Schema.encodeUnknownSync(codec);
  const typeAst = SchemaAST.toType(root.ast);
  const members = typeAst._tag === "Union" ? typeAst.types : [typeAst];
  const per = CORE.test(key) ? 3 : 1;
  let got = 0;
  members.forEach((member, j) => {
    let values;
    // Schemas with object-level checks reject most random values; retry smaller and longer.
    const attempt = (size, maxDiscards) =>
      Effect.runSync(
        Arbitrary.sampleEffect(Arbitrary.schema(Schema.make(member)), {
          count: per,
          size,
          maxDiscards,
          seed: `${key}#${j}`,
        }),
      );
    try {
      try {
        values = attempt(4, undefined);
      } catch {
        values = attempt(1, 20000);
      }
    } catch (e) {
      fixtureStats.sampleFailures++;
      (fixtureStats.failed ??= []).push(
        `${key}#${j}: ${String(e?.message ?? e?._tag ?? e).slice(0, 160)}`,
      );
      return;
    }
    for (const value of values) {
      let json;
      try {
        json = wellFormed(JSON.parse(JSON.stringify(encode(dropUndefined(value)))));
      } catch {
        fixtureStats.encodeForbidden++;
        continue;
      }
      fixtures.push({ key, value: json });
      got++;
    }
  });
  if (got > 0) fixtureStats.roots++;
});
fixtureStats.samples = fixtures.length;
fixtureStats.keys = registryKeys.length;

// The contract inputs' digest: sha256 over each tracked input file's path and bytes, by path.
// It depends only on the tree. A commit id cannot be recorded here: a commit that changes the
// contract cannot name itself, and a shallow checkout sees no history (2026-11-15).
const CONTRACT_INPUTS = ["packages/contracts", "packages/provider-core/src/server/ProviderAdapter.ts"];
const contractDigest = (() => {
  const listed = NodeChildProcess.execFileSync("git", ["ls-files", "-z", "--", ...CONTRACT_INPUTS], {
    encoding: "utf8",
    cwd: repoDir,
    env: gitEnv(),
  });
  const files = listed
    .split("\0")
    .filter((file) => file.length > 0)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (files.length === 0) throw new Error(`no tracked contract inputs under ${repoDir}`);
  const hash = NodeCrypto.createHash("sha256");
  for (const file of files) {
    hash.update(`${file}\0`);
    hash.update(NodeFS.readFileSync(NodePath.join(repoDir, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
})();

const reportJson = {
  roots: roots.length,
  namedSchemas: namedSchemas.size,
  references: Object.keys(refs).length,
  rustItems: items.size,
  literalTypes: literalTypes.size,
  methods: methods.length,
  methodsFullyTyped,
  opaqueFallbacks: report.opaque.length,
  lax: report.lax.length,
  dedupedItems: report.dedupedItems,
  passThroughLinksDropped: passThroughDropped.length,
  opaque: report.opaque,
  laxDetails: report.lax,
  fixtures: fixtureStats,
  methodTypes: methodRows,
};

const rustfmt = (code) =>
  NodeChildProcess.execFileSync("rustfmt", ["--edition", "2024", "--emit", "stdout"], {
    input: code,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });

const outputs = {
  "src/generated.rs": rustfmt(generated),
  "tests/registry/mod.rs": rustfmt(registry),
  "generated/report.json": JSON.stringify(reportJson, null, 2) + "\n",
  "tests/fixtures/sampled.jsonl": fixtures.map((f) => JSON.stringify(f) + "\n").join(""),
  "methods.json":
    JSON.stringify(
      {
        contractDigest,
        methods: methods.map(({ tag, stream, origin }) => ({ tag, stream, origin })),
      },
      null,
      2,
    ) + "\n",
};

let stale = [];
for (const [rel, content] of Object.entries(outputs)) {
  const file = NodePath.join(outDir, rel);
  const current = NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : undefined;
  if (current === content) continue;
  if (check) stale.push(rel);
  else {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, content);
  }
}

console.log(
  `${roots.length} roots, ${items.size} Rust items, ${literalTypes.size} literal types, ` +
    `${report.opaque.length} opaque fallbacks, ${report.lax.length} lax spots; ` +
    `${methodsFullyTyped} of ${methods.length} methods fully typed`,
);
if (check) {
  if (stale.length) {
    console.error(`stale: ${stale.join(", ")}. Run tools/gen-contract.mjs and commit the result.`);
    process.exit(1);
  }
  console.log("generated files are current");
}
