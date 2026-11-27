import * as Arr from "../../Array.ts"
import type { Binding, DeclarationBinding, Fragment, Import, Module } from "../../Codegen.ts"
import { format, formatPropertyKey } from "../../Formatter.ts"
import type * as Schema from "../../Schema.ts"
import type * as SchemaRepresentation from "../../SchemaRepresentation.ts"
import { code, deferred, join, literal } from "../codegen.ts"
import { errorWithPath } from "../errors.ts"
import * as InternalAnnotations from "./annotations.ts"
import * as CodeExpression from "./codeExpression.ts"
import * as CodeImports from "./codeImports.ts"

type Path = ReadonlyArray<string | number>
type CheckRepresentationAnnotation = SchemaRepresentation.CheckRepresentationAnnotation<
  SchemaRepresentation.Representation
>

interface Code {
  readonly runtime: Fragment
  readonly Type: Fragment
}

function makeFragments(runtime: Fragment, Type: Fragment): Code {
  return { runtime, Type }
}

function formatObjectLiteralKey(key: PropertyKey, formatted = formatPropertyKey(key)): string {
  return key === "__proto__" ? `[${formatted}]` : formatted
}

function renderEmittableAnnotation(input: unknown): string | undefined {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "boolean" ||
    typeof input === "number" ||
    typeof input === "bigint"
  ) return literal(input)
  if (typeof input === "symbol") {
    const key = globalThis.Symbol.keyFor(input)
    return key === undefined ? undefined : `globalThis.Symbol.for(${format(key)})`
  }
  if (typeof input !== "object") return undefined
  if (Array.isArray(input)) {
    const values: Array<string> = []
    for (const value of input) {
      const rendered = renderEmittableAnnotation(value)
      if (rendered === undefined) return undefined
      values.push(rendered)
    }
    return `[${values.join(", ")}]`
  }

  const prototype = Object.getPrototypeOf(input)
  // Plain objects from other realms also have a prototype whose prototype is null.
  if (
    prototype !== null &&
    prototype !== Object.prototype &&
    Object.getPrototypeOf(prototype) !== null
  ) return undefined

  const entries: Array<string> = []
  for (const [key, value] of Object.entries(input)) {
    const rendered = renderEmittableAnnotation(value)
    if (rendered === undefined) return undefined
    entries.push(`${formatObjectLiteralKey(key)}: ${rendered}`)
  }
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`
}

// Leading checks that turn a bare `Schema.Number` into a built-in schema.
const canonicalNumberChecks: Record<string, string> = {
  [`.isFinite().annotate({ "expected": "a finite number" })`]: ".Finite",
  [".isInt()"]: ".Int",
  [`.isInt().annotate({ "expected": "an integer" })`]: ".Int"
}

function renderAnnotations(
  annotations: Schema.Annotations.Annotations | undefined
): string | undefined {
  if (annotations === undefined) return undefined
  const entries: Array<string> = []
  for (const [key, value] of Object.entries(annotations)) {
    if (InternalAnnotations.annotationExcludedKeys.has(key)) continue
    const rendered = renderEmittableAnnotation(value)
    if (rendered !== undefined) entries.push(`${formatObjectLiteralKey(key)}: ${rendered}`)
  }
  return entries.length === 0 ? undefined : `{ ${entries.join(", ")} }`
}

/** @internal */
export function sanitizeJavaScriptIdentifier(input: string): string {
  if (input.length === 0) return "_"
  const out = input.replace(/[^A-Za-z0-9_$]/gu, "_")
  const first = out[0]
  return first >= "a" && first <= "z"
    ? first.toUpperCase() + out.slice(1)
    : first >= "0" && first <= "9"
    ? `_${out}`
    : out
}

function isSimpleLiveLiteral(
  representation: SchemaRepresentation.Representation
): representation is SchemaRepresentation.Literal {
  return representation._tag === "Literal" && representation.checks.length === 0 &&
    representation.annotations === undefined
}

interface SymbolDeclaration {
  readonly binding: DeclarationBinding
  runtime: boolean
}

const schemaNamespace: Import = {
  module: "effect/Schema",
  kind: "Namespace",
  imported: "*",
  local: "Schema",
  typeOnly: false,
  attributes: ""
}

const moduleSymbols = new WeakMap<Module, Map<symbol, SymbolDeclaration>>()

/** @internal */
export function addSchemas(
  module: Module,
  schemas: Readonly<Record<string, SchemaRepresentation.Representation>>,
  options?: {
    readonly references?: SchemaRepresentation.References | undefined
    readonly typeOnly?: boolean | undefined
  }
): ReadonlyMap<string, DeclarationBinding> {
  const typeOnly = options?.typeOnly === true
  const schemaImport = module.addImport(schemaNamespace)
  const definitions = options?.references ?? {}
  const references = new Map(
    Object.keys(definitions).map(($ref) => [$ref, freshIdentifier($ref)])
  )
  const symbols = moduleSymbols.get(module) ?? new Map<symbol, SymbolDeclaration>()
  moduleSymbols.set(module, symbols)
  const parsedImports = new Map<string, CodeImports.Imports>()
  let callbackIndex = 0
  let dependencies = new Set<Binding>()
  let suspendDepth = 0
  for (const [$ref, binding] of references) {
    defineSchema(binding, definitions[$ref], ["references", $ref])
  }
  const bindings = new Map<string, DeclarationBinding>()
  for (const [index, [name, representation]] of Object.entries(schemas).entries()) {
    const existing = representation._tag === "Reference" && representation.$ref === name
      ? references.get(name)
      : undefined
    if (existing !== undefined) {
      bindings.set(name, existing)
    } else {
      const binding = module.declare(name)
      defineSchema(binding, representation, ["representations", index])
      bindings.set(name, binding)
    }
  }
  return bindings

  function defineSchema(
    binding: DeclarationBinding,
    representation: SchemaRepresentation.Representation,
    path: Path
  ): void {
    dependencies = new Set()
    const fragments = recur(representation, path)
    module.define(binding, [
      code`export type ${binding} = ${fragments.Type}`,
      ...(typeOnly ? [] : [code`export const ${binding} = ${fragments.runtime}`])
    ], [...dependencies])
  }

  function dependOn(binding: DeclarationBinding): DeclarationBinding {
    if (suspendDepth === 0) dependencies.add(binding)
    return binding
  }

  function freshIdentifier(seed: string): DeclarationBinding {
    return module.declare(sanitizeJavaScriptIdentifier(seed))
  }

  function compileCallback(
    inputs: ReadonlyArray<Code>,
    callback: (
      inputs: ReadonlyArray<SchemaRepresentation.Code>
    ) => SchemaRepresentation.Generation.DeclarationOutput | SchemaRepresentation.Generation.CheckOutput,
    path: Path
  ): Code {
    const references = new Map<string, Fragment>([["Schema", schemaImport]])
    const id = callbackIndex++
    // Supplied expressions keep their identities even when the callback imports the same names.
    const parameters = inputs.map((input, index) => {
      const runtime = `__effect_codegen_${id}_${index}_runtime`
      const Type = `__effect_codegen_${id}_${index}_Type`
      references.set(runtime, input.runtime)
      references.set(Type, input.Type)
      return { runtime, Type }
    })
    const output = callback(parameters)
    const imports = new Map<string, Import>()
    for (const [index, source] of (output.importDeclarations ?? []).entries()) {
      try {
        let parsed = parsedImports.get(source)
        if (parsed === undefined) {
          parsed = CodeImports.parse(source)
          parsedImports.set(source, parsed)
        }
        for (const imported of parsed) {
          if (imported.kind === "SideEffect") {
            module.addSideEffect(imported.module, imported.attributes)
            continue
          }
          if (references.has(imported.local) && imported.local !== "Schema" && !imports.has(imported.local)) {
            throw new Error("Import shadows a callback argument")
          }
          const previous = imports.get(imported.local)
          if (
            previous !== undefined && (
              previous.module !== imported.module || previous.kind !== imported.kind ||
              previous.imported !== imported.imported || previous.attributes !== imported.attributes
            )
          ) {
            throw new Error(`Conflicting imports for ${imported.local}`)
          }
          const input = previous === undefined
            ? imported
            : { ...imported, typeOnly: previous.typeOnly && imported.typeOnly }
          imports.set(imported.local, input)
          references.set(imported.local, module.addImport(input))
        }
      } catch (error) {
        throw errorWithPath(error instanceof Error ? error.message : String(error), [
          ...path,
          "importDeclarations",
          index
        ])
      }
    }
    const parse = (source: string, kind: "runtime" | "Type") => {
      try {
        return CodeExpression.parse(source, references, kind)
      } catch (error) {
        throw errorWithPath(error instanceof Error ? error.message : String(error), [...path, kind])
      }
    }
    return makeFragments(parse(output.runtime, "runtime"), "Type" in output ? parse(output.Type, "Type") : "never")
  }

  function addSymbol(symbol: symbol): DeclarationBinding {
    const existing = symbols.get(symbol)
    if (existing !== undefined) {
      existing.runtime ||= !typeOnly
      return dependOn(existing.binding)
    }
    const identifier = freshIdentifier("_symbol")
    const key = globalThis.Symbol.keyFor(symbol)
    const description = symbol.description
    const declaration: SymbolDeclaration = { binding: identifier, runtime: !typeOnly }
    symbols.set(symbol, declaration)
    const runtime = key === undefined
      ? `globalThis.Symbol(${description === undefined ? "" : format(description)})`
      : `globalThis.Symbol.for(${format(key)})`
    module.define(identifier, [deferred((render) =>
      declaration.runtime
        ? `const ${render(identifier)} = ${runtime}`
        : `declare const ${render(identifier)}: unique symbol`
    )])
    return dependOn(identifier)
  }

  function annotationSchemas(
    representation: CheckRepresentationAnnotation | undefined,
    path: Path
  ): ReadonlyArray<Code> {
    return representation?.schemas?.map((schema, index) => recur(schema, [...path, "schemas", index])) ?? []
  }

  function runtimeAnnotate(
    annotations: Schema.Annotations.Annotations | undefined,
    method: "annotate" | "annotateKey" = "annotate"
  ): string {
    const rendered = renderAnnotations(annotations)
    return rendered === undefined ? "" : `.${method}(${rendered})`
  }

  function unionOptionsRuntime(options: NonNullable<SchemaRepresentation.Union["options"]>): string {
    if (!Object.hasOwn(options, "mode")) return "{}"
    return `{ mode: ${options.mode === undefined ? "undefined" : format(options.mode)} }`
  }

  function compileCheck(
    check: SchemaRepresentation.Check,
    path: Path
  ): Fragment {
    const callback = check.annotations?.toCode
    let runtime: Fragment
    if (callback !== undefined) {
      const schemas = annotationSchemas(check.representation, [...path, "representation"])
      runtime = compileCallback(
        schemas,
        (schemas) => (callback as SchemaRepresentation.Generation.Check)({ schemas }),
        [...path, "annotations", "toCode"]
      ).runtime
    } else if (check._tag === "Filter") {
      throw errorWithPath("Missing toCode callback", [...path, "annotations", "toCode"])
    } else {
      runtime = code`${schemaImport}.makeFilterGroup([${
        join(check.checks.map((child, index) => compileCheck(child, [...path, "checks", index])), ", ")
      }])`
    }
    runtime = code`${runtime}${runtimeAnnotate(check.annotations)}`
    if (check._tag === "Filter" && check.aborted) runtime = code`${runtime}.abort()`
    return runtime
  }

  function applyNode(
    base: Code,
    representation: Exclude<SchemaRepresentation.Representation, SchemaRepresentation.Reference>,
    path: Path
  ): Code {
    let runtime = code`${base.runtime}${runtimeAnnotate(representation.annotations)}`
    for (let index = 0; index < representation.checks.length; index++) {
      const check = representation.checks[index]
      const compiledCheck = compileCheck(check, [...path, "checks", index])
      // Only collapse a bare number's leading canonical check.
      const current = runtime
      runtime = deferred((render) => {
        const base = render(current)
        const check = render(compiledCheck)
        const namespace = render(schemaImport)
        const suffix = check.startsWith(namespace + ".") ? check.slice(namespace.length) : ""
        return base === `${namespace}.Number` && Object.hasOwn(canonicalNumberChecks, suffix)
          ? namespace + canonicalNumberChecks[suffix]
          : `${base}.check(${check})`
      })
    }
    return makeFragments(runtime, base.Type)
  }

  function recur(
    representation: SchemaRepresentation.Representation,
    path: Path
  ): Code {
    if (representation._tag === "Reference") {
      const identifier = references.get(representation.$ref)
      if (identifier === undefined) {
        throw errorWithPath(`Invalid reference ${representation.$ref}`, [...path, "$ref"])
      }
      return makeFragments(dependOn(identifier), identifier)
    }
    return applyNode(on(representation, path), representation, path)
  }

  function on(
    representation: Exclude<SchemaRepresentation.Representation, SchemaRepresentation.Reference>,
    path: Path
  ): Code {
    switch (representation._tag) {
      case "Declaration": {
        const callback = representation.annotations?.toCode
        if (callback === undefined) {
          throw errorWithPath("Missing toCode callback", [...path, "annotations", "toCode"])
        }
        const typeParameters = representation.typeParameters.map((typeParameter, index) =>
          recur(typeParameter, [...path, "typeParameters", index])
        )
        return compileCallback(
          typeParameters,
          (typeParameters) => (callback as SchemaRepresentation.Generation.Declaration)({ typeParameters }),
          [...path, "annotations", "toCode"]
        )
      }
      case "Suspend": {
        suspendDepth++
        const thunk = recur(representation.thunk, [...path, "thunk"])
        suspendDepth--
        return makeFragments(
          code`${schemaImport}.suspend((): ${schemaImport}.Codec<${thunk.Type}> => ${thunk.runtime})`,
          thunk.Type
        )
      }
      case "Null":
        return makeFragments(code`${schemaImport}.Null`, "null")
      case "Undefined":
        return makeFragments(code`${schemaImport}.Undefined`, "undefined")
      case "Void":
        return makeFragments(code`${schemaImport}.Void`, "void")
      case "Never":
        return makeFragments(code`${schemaImport}.Never`, "never")
      case "Unknown":
        return makeFragments(code`${schemaImport}.Unknown`, "unknown")
      case "Any":
        return makeFragments(code`${schemaImport}.Any`, "any")
      case "String":
        return makeFragments(code`${schemaImport}.String`, "string")
      case "Number":
        return makeFragments(code`${schemaImport}.Number`, "number")
      case "Boolean":
        return makeFragments(code`${schemaImport}.Boolean`, "boolean")
      case "BigInt":
        return makeFragments(code`${schemaImport}.BigInt`, "bigint")
      case "Symbol":
        return makeFragments(code`${schemaImport}.Symbol`, "symbol")
      case "Literal": {
        const literal = format(representation.literal)
        return makeFragments(code`${schemaImport}.Literal(${literal})`, literal)
      }
      case "UniqueSymbol": {
        const identifier = addSymbol(representation.symbol)
        return makeFragments(code`${schemaImport}.UniqueSymbol(${identifier})`, code`typeof ${identifier}`)
      }
      case "ObjectKeyword":
        return makeFragments(code`${schemaImport}.ObjectKeyword`, "object")
      case "Enum": {
        const identifier = freshIdentifier("_Enum")
        module.define(identifier, [
          code`${typeOnly ? "declare " : ""}enum ${identifier} { ${
            representation.enums.map(([name, value]) => `${format(name)} = ${format(value)}`).join(", ")
          } }`
        ])
        dependOn(identifier)
        return makeFragments(code`${schemaImport}.Enum(${identifier})`, identifier)
      }
      case "TemplateLiteral": {
        const parts = representation.parts.map((part, index) => recur(part, [...path, "parts", index]))
        const Type = code`\`${join(parts.map((part) => code`\${${part.Type}}`), "")}\``
        return makeFragments(
          code`${schemaImport}.TemplateLiteral([${join(parts.map((part) => part.runtime), ", ")}])`,
          Type
        )
      }
      case "Arrays": {
        const elements = representation.elements.map((element, index) => {
          const type = recur(element.type, [...path, "elements", index, "type"])
          return makeFragments(
            code`${element.isOptional ? code`${schemaImport}.optionalKey(` : ""}${type.runtime}${
              element.isOptional ? ")" : ""
            }${runtimeAnnotate(element.annotations, "annotateKey")}`,
            element.isOptional ? code`(${type.Type})?` : type.Type
          )
        })
        const rest = representation.rest.map((item, index) => recur(item, [...path, "rest", index]))
        if (!Arr.isArrayNonEmpty(rest)) {
          return makeFragments(
            code`${schemaImport}.Tuple([${join(elements.map((element) => element.runtime), ", ")}])`,
            code`readonly [${join(elements.map((element) => element.Type), ", ")}]`
          )
        }
        const item = rest[0]
        if (elements.length === 0 && rest.length === 1) {
          return makeFragments(
            code`${schemaImport}.Array(${item.runtime})`,
            code`globalThis.ReadonlyArray<${item.Type}>`
          )
        }
        const types = [
          ...elements.map((element) => element.Type),
          code`...globalThis.Array<${item.Type}>`,
          ...rest.slice(1).map((item) => item.Type)
        ]
        return makeFragments(
          code`${schemaImport}.TupleWithRest(${schemaImport}.Tuple([${
            join(elements.map((element) => element.runtime), ", ")
          }]), [${join(rest.map((item) => item.runtime), ", ")}])`,
          code`readonly [${join(types, ", ")}]`
        )
      }
      case "Objects": {
        const properties = representation.propertySignatures.map((property, index) => {
          const isSymbol = typeof property.name === "symbol"
          const name = isSymbol
            ? code`[${addSymbol(property.name)}]`
            : formatPropertyKey(property.name)
          const type = recur(property.type, [...path, "propertySignatures", index, "type"])
          let runtime = type.runtime
          if (property.isMutable) runtime = code`${schemaImport}.mutableKey(${runtime})`
          if (property.isOptional) runtime = code`${schemaImport}.optionalKey(${runtime})`
          runtime = code`${runtime}${runtimeAnnotate(property.annotations, "annotateKey")}`
          const runtimeName = property.name === "__proto__" ? code`[${name}]` : name
          const typeName = code`${property.isMutable ? "" : "readonly "}${name}${property.isOptional ? "?" : ""}`
          return makeFragments(code`${runtimeName}: ${runtime}`, code`${typeName}: ${type.Type}`)
        })
        const indexSignatures = representation.indexSignatures.map((signature, index) => ({
          parameter: recur(signature.parameter, [...path, "indexSignatures", index, "parameter"]),
          type: recur(signature.type, [...path, "indexSignatures", index, "type"])
        }))
        const propertyRuntimes = join(properties.map((property) => property.runtime), ", ")
        const propertyTypes = join(properties.map((property) => property.Type), ", ")
        if (indexSignatures.length === 0) {
          return makeFragments(
            code`${schemaImport}.Struct({ ${propertyRuntimes} })`,
            code`{ ${propertyTypes} }`
          )
        }
        if (properties.length === 0 && indexSignatures.length === 1) {
          const signature = indexSignatures[0]
          return makeFragments(
            code`${schemaImport}.Record(${signature.parameter.runtime}, ${signature.type.runtime})`,
            code`{ readonly [x: ${signature.parameter.Type}]: ${signature.type.Type} }`
          )
        }
        const indexRuntimes = join(
          indexSignatures.map((signature) =>
            code`${schemaImport}.Record(${signature.parameter.runtime}, ${signature.type.runtime})`
          ),
          ", "
        )
        const indexTypes = indexSignatures.map((signature) =>
          code`readonly [x: ${signature.parameter.Type}]: ${signature.type.Type}`
        )
        return makeFragments(
          code`${schemaImport}.StructWithRest(${schemaImport}.Struct({ ${propertyRuntimes} }), [${indexRuntimes}])`,
          properties.length === 0
            ? code`{ ${join(indexTypes, ", ")} }`
            : join([code`{ ${propertyTypes} }`, ...indexTypes.map((indexType) => code`{ ${indexType} }`)], " & ")
        )
      }
      case "Union": {
        if (representation.options === undefined && representation.types.length === 0) {
          return makeFragments(code`${schemaImport}.Never`, "never")
        }
        if (representation.options === undefined && representation.types.every(isSimpleLiveLiteral)) {
          const literals = representation.types.map((literal) => format(literal.literal))
          return literals.length === 1
            ? makeFragments(code`${schemaImport}.Literal(${literals[0]})`, literals[0])
            : makeFragments(code`${schemaImport}.Literals([${literals.join(", ")}])`, literals.join(" | "))
        }
        const types = representation.types.map((type, index) => recur(type, [...path, "types", index]))
        const options = representation.options === undefined
          ? ""
          : `, ${unionOptionsRuntime(representation.options)}`
        return makeFragments(
          code`${schemaImport}.Union([${join(types.map((type) => type.runtime), ", ")}]${options})`,
          types.length === 0 ? "never" : join(types.map((type) => type.Type), " | ")
        )
      }
    }
  }
}
