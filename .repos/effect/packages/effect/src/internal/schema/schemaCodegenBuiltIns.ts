import { format } from "../../Formatter.ts"
import { isObject } from "../../Predicate.ts"
import type { Json } from "../../Schema.ts"
import type * as Representation from "../../SchemaRepresentation.ts"
import { literal } from "../codegen.ts"
import { errorWithPath } from "../errors.ts"

type Path = ReadonlyArray<string | number>
type PrintArgument = (value: unknown) => string | undefined

const noArguments: PrintArgument = (payload) => payload === null ? "" : undefined
const string: PrintArgument = (value) => typeof value === "string" ? literal(value) : undefined
const number: PrintArgument = (value) =>
  typeof value === "number" && Number.isFinite(value) ? literal(value) : undefined
const natural: PrintArgument = (value) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? literal(value) : undefined
const bigint: PrintArgument = (value) =>
  typeof value === "string" && /^-?(?:0|[1-9][0-9]*)$/.test(value) ? literal(BigInt(value)) : undefined
const date: PrintArgument = (value) => {
  if (typeof value !== "string") return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? `new globalThis.Date(${ms})` : undefined
}

function fields(render: PrintArgument, ...keys: ReadonlyArray<string>): PrintArgument {
  return (payload) => {
    if (!isObject(payload)) return undefined
    const args: Array<string> = []
    for (const key of keys) {
      const arg = render(payload[key])
      if (arg === undefined) return undefined
      args.push(arg)
    }
    return args.join(", ")
  }
}

function between(render: PrintArgument): PrintArgument {
  return (payload) => {
    if (!isObject(payload)) return undefined
    const minimum = render(payload.minimum)
    const maximum = render(payload.maximum)
    const { exclusiveMaximum, exclusiveMinimum } = payload
    if (
      minimum === undefined || maximum === undefined ||
      exclusiveMinimum !== undefined && exclusiveMinimum !== true ||
      exclusiveMaximum !== undefined && exclusiveMaximum !== true
    ) return undefined
    return `{ minimum: ${minimum}, maximum: ${maximum}, exclusiveMinimum: ${exclusiveMinimum}, exclusiveMaximum: ${exclusiveMaximum} }`
  }
}

const checkArguments: Record<string, PrintArgument> = {
  isTrimmed: noArguments,
  isPattern: (payload) => {
    if (!isObject(payload) || typeof payload.source !== "string" || typeof payload.flags !== "string") return undefined
    const { source, flags } = payload
    try {
      const pattern = new RegExp(source, flags)
      if (pattern.source !== source || pattern.flags !== flags) return undefined
    } catch {
      return undefined
    }
    return `new globalThis.RegExp(${literal(source)}${flags === "" ? "" : ", " + literal(flags)})`
  },
  isStringFinite: noArguments,
  isStringBigInt: noArguments,
  isStringSymbol: noArguments,
  isUUID: (payload) => {
    if (!isObject(payload)) return undefined
    const { version } = payload
    if (version === null) return ""
    return typeof version === "number" && Number.isInteger(version) && version >= 1 && version <= 8
      ? literal(version)
      : undefined
  },
  isGUID: noArguments,
  isULID: noArguments,
  isAscii: noArguments,
  isBase64: noArguments,
  isBase64Url: noArguments,
  isStartingWith: fields(string, "startsWith"),
  isEndingWith: fields(string, "endsWith"),
  isIncluding: fields(string, "includes"),
  isUppercased: noArguments,
  isLowercased: noArguments,
  isCapitalized: noArguments,
  isUncapitalized: noArguments,
  isFinite: noArguments,
  isInt: noArguments,
  isGreaterThan: fields(number, "exclusiveMinimum"),
  isGreaterThanOrEqualTo: fields(number, "minimum"),
  isLessThan: fields(number, "exclusiveMaximum"),
  isLessThanOrEqualTo: fields(number, "maximum"),
  isBetween: between(number),
  isMultipleOf: fields((value) => typeof value === "number" && value > 0 ? number(value) : undefined, "divisor"),
  isGreaterThanDate: fields(date, "exclusiveMinimum"),
  isGreaterThanOrEqualToDate: fields(date, "minimum"),
  isLessThanDate: fields(date, "exclusiveMaximum"),
  isLessThanOrEqualToDate: fields(date, "maximum"),
  isBetweenDate: between(date),
  isGreaterThanBigInt: fields(bigint, "exclusiveMinimum"),
  isGreaterThanOrEqualToBigInt: fields(bigint, "minimum"),
  isLessThanBigInt: fields(bigint, "exclusiveMaximum"),
  isLessThanOrEqualToBigInt: fields(bigint, "maximum"),
  isBetweenBigInt: between(bigint),
  isMinLength: fields(natural, "minLength"),
  isMaxLength: fields(natural, "maxLength"),
  isBetweenLength: fields(natural, "minimum", "maximum"),
  isMinCodePoints: fields(natural, "minCodePoints"),
  isMaxCodePoints: fields(natural, "maxCodePoints"),
  isBetweenCodePoints: fields(natural, "minimum", "maximum"),
  isMinSize: fields(natural, "minSize"),
  isMaxSize: fields(natural, "maxSize"),
  isBetweenSize: fields(natural, "minimum", "maximum"),
  isMinProperties: fields(natural, "minProperties"),
  isMaxProperties: fields(natural, "maxProperties"),
  isBetweenProperties: fields(natural, "minimum", "maximum"),
  isPropertyNames: noArguments,
  isUnique: noArguments,
  isUniqueKey: noArguments
}

function invalidPayload(id: string, path: Path): never {
  throw errorWithPath(`Invalid representation payload for ${id}`, [...path, "representation", "payload"])
}

function checkArity(id: string, actual: number, expected: number, path: Path): void {
  if (actual !== expected) {
    throw errorWithPath(`Invalid number of schema arguments for ${id}: expected ${expected}, got ${actual}`, path)
  }
}

/** @internal */
export function resolveCheck(check: Representation.Check, path: Path): Representation.Generation.Check | undefined {
  const { annotations, representation: repr } = check
  if (annotations && "toCode" in annotations) return annotations.toCode as Representation.Generation.Check | undefined
  if (check._tag !== "Filter" || !repr?.id.startsWith("effect/schema/")) return undefined
  const name = repr.id.slice("effect/schema/".length)
  if (!Object.hasOwn(checkArguments, name)) return undefined
  const args = checkArguments[name](repr.payload) ?? invalidPayload(repr.id, path)
  checkArity(repr.id, repr.schemas?.length ?? 0, name === "isPropertyNames" ? 1 : 0, [
    ...path,
    "representation",
    "schemas"
  ])
  return ({ schemas }) => ({ runtime: `Schema.${name}(${schemas[0]?.runtime ?? args})` })
}

interface DeclarationRule {
  readonly type: string
  // An explicit zero distinguishes a call like ErrorInstance() from a constant like Date.
  readonly arity?: number
  readonly typeArity?: number
  readonly module?: string
  readonly runtime?: string
  readonly argument?: PrintArgument
  readonly crypto?: KeyAlgorithms
}

function options(accepts: (key: string, value: unknown) => boolean): PrintArgument {
  return (payload) => {
    if (payload === null) return ""
    if (!isObject(payload)) return undefined
    const entries = Object.entries(payload)
    return entries.length > 0 && entries.every(([key, value]) => accepts(key, value)) ? format(payload) : undefined
  }
}

interface KeyAlgorithms {
  readonly withoutHash?: ReadonlyArray<string>
  readonly withHash?: ReadonlyArray<string>
  readonly rsa?: string
  readonly rsaWithSalt?: string
}

const signature: KeyAlgorithms = {
  withoutHash: ["ed25519"],
  withHash: ["ecdsaP256", "ecdsaP384", "ecdsaP521"],
  rsa: "rsaPkcs1v15",
  rsaWithSalt: "rsaPss"
}
const keyAgreement: KeyAlgorithms = { withoutHash: ["x25519", "ecdhP256", "ecdhP384", "ecdhP521"] }

const declarations: Record<string, DeclarationRule> = {
  "effect/schema/Json": { type: "Schema.Json" },
  "effect/schema/MutableJson": { type: "Schema.MutableJson" },
  "effect/schema/Error": {
    type: "globalThis.Error",
    runtime: "Schema.ErrorInstance",
    arity: 0,
    argument: options((key, value) => (key === "includeStack" || key === "excludeCause") && value === true)
  },
  "effect/schema/RegExp": { type: "globalThis.RegExp" },
  "effect/schema/URL": { type: "globalThis.URL" },
  "effect/schema/Date": { type: "globalThis.Date" },
  "effect/schema/File": { type: "globalThis.File" },
  "effect/schema/FormData": { type: "globalThis.FormData" },
  "effect/schema/URLSearchParams": { type: "globalThis.URLSearchParams" },
  "effect/schema/Uint8Array": { type: "globalThis.Uint8Array" },
  "effect/schema/ReadonlyMap": { type: "globalThis.ReadonlyMap", arity: 2 },
  "effect/schema/ReadonlySet": { type: "globalThis.ReadonlySet", arity: 1 },
  "effect/schema/BigDecimal": { type: "BigDecimal.BigDecimal" },
  "effect/schema/Rational": { type: "Rational.Rational" },
  "effect/schema/ByteSize": { type: "ByteSize.ByteSize" },
  "effect/schema/CauseReason": { type: "Cause.Reason", arity: 2, typeArity: 1 },
  "effect/schema/Cause": { type: "Cause.Cause", arity: 2, typeArity: 1 },
  "effect/schema/Chunk": { type: "Chunk.Chunk", arity: 1 },
  "effect/schema/DateTimeUtc": { type: "DateTime.Utc" },
  "effect/schema/TimeZoneOffset": { type: "DateTime.TimeZone.Offset" },
  "effect/schema/TimeZoneNamed": { type: "DateTime.TimeZone.Named" },
  "effect/schema/TimeZone": { type: "DateTime.TimeZone" },
  "effect/schema/DateTimeZoned": { type: "DateTime.Zoned" },
  "effect/schema/Duration": { type: "Duration.Duration" },
  "effect/schema/Exit": { type: "Exit.Exit", arity: 3, typeArity: 2 },
  "effect/schema/Graph": {
    type: "Graph.Graph",
    arity: 2,
    argument: (kind) => kind === "directed" || kind === "undirected" ? literal(kind) : undefined
  },
  "effect/schema/HashMap": { type: "HashMap.HashMap", arity: 2 },
  "effect/schema/HashSet": { type: "HashSet.HashSet", arity: 1 },
  "effect/schema/Option": { type: "Option.Option", arity: 1 },
  "effect/schema/Redacted": {
    type: "Redacted.Redacted",
    arity: 1,
    argument: options((key, value) =>
      key === "label" ? typeof value === "string" : key === "disallowJsonEncode" && value === true
    )
  },
  "effect/schema/Result": { type: "Result.Result", arity: 2 },
  "effect/schema/SemVer": { type: "SemVer.SemVer" },
  "effect/schema/SemVerRange": { type: "SemVerRange.SemVerRange" },
  "effect/http/Cookie": { type: "Cookies.Cookie", module: "effect/http/Cookies" },
  "effect/http/Cookies": { type: "Cookies.Cookies", module: "effect/http/Cookies" },
  "effect/http/Headers": { type: "Headers.Headers", module: "effect/http/Headers" },
  "effect/http/UrlParams": { type: "UrlParams.UrlParams", module: "effect/http/UrlParams" },
  "effect/http/PersistedFile": {
    type: "Multipart.PersistedFile",
    module: "effect/http/Multipart",
    runtime: "Multipart.PersistedFileSchema"
  },
  "effect/crypto/MacKey": {
    type: "Mac.Key",
    crypto: { withHash: ["hmacSha1", "hmacSha256", "hmacSha384", "hmacSha512"] }
  },
  "effect/crypto/AeadKey": {
    type: "Aead.Key",
    crypto: { withoutHash: ["aes128Gcm", "aes256Gcm", "chacha20Poly1305", "xchacha20Poly1305"] }
  },
  "effect/crypto/CipherKey": {
    type: "Cipher.Key",
    crypto: { withoutHash: ["aes128Ctr", "aes256Ctr", "aes128Cbc", "aes256Cbc"] }
  },
  "effect/crypto/SignaturePublicKey": { type: "Signature.PublicKey", crypto: signature },
  "effect/crypto/SignaturePrivateKey": { type: "Signature.PrivateKey", crypto: signature },
  "effect/crypto/KeyAgreementPublicKey": { type: "KeyAgreement.PublicKey", crypto: keyAgreement },
  "effect/crypto/KeyAgreementPrivateKey": { type: "KeyAgreement.PrivateKey", crypto: keyAgreement },
  "effect/crypto/KeyWrapKey": { type: "KeyWrap.Key", crypto: { withoutHash: ["aes128Kw", "aes256Kw"] } },
  "effect/crypto/KeyWrapPublicKey": { type: "KeyWrap.PublicKey", crypto: { rsa: "rsaOaep" } },
  "effect/crypto/KeyWrapPrivateKey": { type: "KeyWrap.PrivateKey", crypto: { rsa: "rsaOaep" } }
}

const digestSuffixes = new Map([
  ["MD5", "Md5"],
  ["SHA-1", "Sha1"],
  ["SHA-256", "Sha256"],
  ["SHA-384", "Sha384"],
  ["SHA-512", "Sha512"]
])

function cryptoKey(
  name: string,
  type: string,
  algorithms: KeyAlgorithms,
  payload: Json
): Representation.Generation.DeclarationOutput | undefined {
  if (!isObject(payload) || typeof payload.name !== "string") return undefined
  const { hash, modulusLength, saltLength } = payload
  const suffix = typeof hash === "string" ? digestSuffixes.get(hash) : undefined
  if (hash !== undefined && suffix === undefined) return undefined
  const digest = suffix === undefined ? undefined : `Digest.${suffix.toLowerCase()}`
  const family = type.split(".")[0]
  const imports = [`import * as ${family} from "effect/crypto/${family}"`]
  if (digest !== undefined) imports.push("import * as Digest from \"effect/crypto/Digest\"")
  let algorithm: string
  if (modulusLength === undefined) {
    const names = digest === undefined ? algorithms.withoutHash : algorithms.withHash
    if (!names?.includes(payload.name) || saltLength !== undefined) return undefined
    algorithm = `${family}.${payload.name}`
    if (digest !== undefined) algorithm = `{ ...${algorithm}, hash: ${digest} }`
  } else {
    const factory = saltLength === undefined ? algorithms.rsa : algorithms.rsaWithSalt
    if (
      factory === undefined || digest === undefined || !Number.isFinite(modulusLength) ||
      saltLength !== undefined && !Number.isFinite(saltLength)
    ) return undefined
    const salt = saltLength === undefined ? "" : `, saltLength: ${saltLength}`
    algorithm = `${family}.${factory}({ hash: ${digest}, modulusLength: ${modulusLength}${salt} })`
    if (payload.name !== factory + suffix) algorithm = `{ ...${algorithm}, name: ${literal(payload.name)} }`
  }
  return { runtime: `Schema.${name}(${algorithm})`, Type: type, importDeclarations: imports }
}

/** @internal */
export function resolveDeclaration(
  node: Representation.Declaration,
  path: Path
): Representation.Generation.Declaration | undefined {
  const { annotations, representation: repr } = node
  if (annotations && "toCode" in annotations) {
    return annotations.toCode as Representation.Generation.Declaration | undefined
  }
  if (!repr || !Object.hasOwn(declarations, repr.id)) return undefined
  const { id, payload } = repr
  const name = id.slice(id.lastIndexOf("/") + 1)
  const rule = declarations[id]
  checkArity(id, node.typeParameters.length, rule.arity ?? 0, [...path, "typeParameters"])
  if (rule.crypto) {
    const output = cryptoKey(name, rule.type, rule.crypto, payload) ?? invalidPayload(id, path)
    return () => output
  }
  return ({ typeParameters }) => {
    const args = typeParameters.map((p) => p.runtime)
    const types = typeParameters.slice(0, rule.typeArity).map((p) => p.Type)
    const argument = (rule.argument ?? noArguments)(payload) ?? invalidPayload(id, path)
    if (id === "effect/schema/Graph") {
      args.unshift(argument)
      types.push(argument)
    } else if (argument !== "") {
      args.push(argument)
    }
    const runtime = rule.runtime ?? `Schema.${name}`
    const namespace = rule.type.split(".")[0]
    return {
      runtime: rule.arity === undefined ? runtime : `${runtime}(${args.join(", ")})`,
      Type: types.length > 0 ? `${rule.type}<${types.join(", ")}>` : rule.type,
      importDeclarations: namespace === "globalThis" || namespace === "Schema" ? [] : [
        `import * as ${namespace} from "${rule.module ?? "effect/" + namespace}"`
      ]
    }
  }
}
