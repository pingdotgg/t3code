// One schema walk for RPC limits and MCP decode-time checks.
import { importSource, packageImporter } from "./monorepo.mjs";

const pkg = packageImporter("apps/server");
const Schema = await pkg("effect/Schema");
const Exit = await pkg("effect/Exit");
const { TrimmedString } = await importSource("packages/contracts/src/baseSchemas.ts");
const trim = TrimmedString.ast.encoding[0].transformation;
const expected = (ast) => ast.getExpected(expected).replaceAll("undefined", "null");
const supported = ["isTrimmed", "isMinLength", "isMaxLength", "isMaxProperties", "isInt", "isGreaterThanOrEqualTo", "isLessThanOrEqualTo", "isPattern", "isBetween"];
const limitOrder = ["nonBlank", "isMinLength", "isMaxLength", "isPattern", "isInt", "isGreaterThanOrEqualTo", "isLessThanOrEqualTo", "isMaxProperties"];

export function schemaRule(ast, purpose) {
  if (ast._tag === "Suspend") return schemaRule(ast.thunk(), purpose);
  const decode = purpose === "decode";
  const walk = (ast) => schemaRule(ast, purpose);
  if (decode && !["Unknown", "String", "Number", "Boolean", "Null", "Literal", "Union", "Objects", "Arrays"].includes(ast._tag)) throw new Error(`input needs AST ${ast._tag}`);
  const rule = decode ? { kind: ast._tag, expected: expected(ast) } : {};
  if (decode && ast.context?.isOptional) {
    rule.optional = true;
    const result = Schema.decodeUnknownExit(Schema.toCodecJson(Schema.make(ast)))(null);
    if (Exit.isSuccess(result) && result.value === undefined) rule.nullAsOmitted = true;
  }
  const nonBlank = ast.checks?.some(c => c.annotations?.expected === "a non-blank string");
  if ((decode || ast._tag === "String") && (ast.encoding?.some(e => e.transformation === trim) || (!decode && nonBlank))) rule.trim = true;
  if (decode && ast._tag === "Literal") rule.literal = ast.literal;
  if (ast._tag === "Union") {
    const members = ast.types.filter(t => t._tag !== "Undefined" && (decode || t._tag !== "Null"));
    if (decode) rule.members = members.map(walk);
    else {
      const flat = members.flatMap(t => t._tag === "Union" ? t.types : [t]).filter(t => t._tag !== "Undefined" && t._tag !== "Null");
      const tag = (t, key) => t._tag === "Objects" && t.propertySignatures.find(p => p.name === key)?.type.literal;
      const key = ["_tag", "kind"].find(key => flat.length > 1 && flat.every(t => typeof tag(t, key) === "string"));
      if (key) return { variants: Object.fromEntries(flat.map(t => [tag(t, key), walk(t)]).filter(([,r]) => r)), discriminator: key };
      return members.length === 1 ? walk(members[0]) : null;
    }
  }
  if (ast._tag === "Objects") {
    rule.fields = ast.propertySignatures.map(p => ({ key: p.name, rule: walk(p.type) })).filter(f => f.rule);
    if (!decode) rule.fields.sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const [index] = ast.indexSignatures;
    if (index) {
      if (!decode) rule.keys = walk(index.parameter);
      rule.values = walk(index.type);
    }
  }
  if (ast._tag === "Arrays") {
    if (ast.elements.length || ast.rest.length !== 1) throw new Error("input needs a homogeneous array");
    rule.items = walk(ast.rest[0]);
    if (decode && ast.encoding?.some(e => e.to._tag === "Objects" && e.to.indexSignatures.length)) rule.fromRecord = true;
  }
  rule.checks = (ast.checks ?? []).flatMap(c => {
    const a = c.annotations ?? {};
    if (a.expected === "a non-blank string") return [{id: "nonBlank", expected: a.expected}];
    const r = a.representation;
    if (!r) return [];
    const id = r.id.replace("effect/schema/", "");
    if (!supported.includes(id)) throw new Error(`input needs check ${r.id}`);
    if (!decode && id === "isTrimmed") return [];
    const p = r.payload ?? {};
    if (id === "isPattern" && /[^imsu]/.test(p.flags)) throw new Error(`pattern flags ${p.flags} are not supported`);
    if (decode) return [{id, expected: a.expected, ...p}];
    const checks = id === "isBetween" ? [{id:"isGreaterThanOrEqualTo",minimum:p.minimum},{id:"isLessThanOrEqualTo",maximum:p.maximum}] : [{id,...p}];
    return checks.map(check => {
      const pattern = (p.flags?.replace("u", "") ? `(?${p.flags.replace("u", "")})` : "") + p.source;
      const text = {
        isMinLength: `a value with a length of at least ${p.minLength}, got {length}`,
        isMaxLength: `a value with a length of at most ${p.maxLength}, got {length}`,
        isMaxProperties: `a value with at most ${p.maxProperties} entries, got {length}`,
        isInt: "an integer",
        isGreaterThanOrEqualTo: `a value greater than or equal to ${p.minimum}`,
        isLessThanOrEqualTo: `a value less than or equal to ${p.maximum}`,
        isPattern: `a string matching the RegExp ${pattern}`,
      }[check.id];
      return {...check, expected:text};
    });
  });
  if (!decode) {
    rule.checks.sort((a,b) => limitOrder.indexOf(a.id) - limitOrder.indexOf(b.id));
    for (const key of Object.keys(rule)) {
      if (rule[key] == null || (Array.isArray(rule[key]) && !rule[key].length)) delete rule[key];
    }
  }
  return decode || Object.keys(rule).length ? rule : null;
}
