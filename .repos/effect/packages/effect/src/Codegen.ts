/**
 * Builds TypeScript modules with a mutable `Module` builder and structured code fragments.
 *
 * Keep references as bindings while composing code. A module allocates declaration
 * names, resolves import aliases, orders eager dependencies, and prints the result.
 * Compose snippets with `code` and use `join` for lists with explicit separators.
 * Raw strings are emitted unchanged; the builder does not parse arbitrary source.
 *
 * @stability experimental
 * @since 4.1.5
 */
import * as InternalCodegen from "./internal/codegen.ts"
import * as SchemaCodegen from "./internal/schema/schemaCodegen.ts"
import { hasProperty } from "./Predicate.ts"
import type * as SchemaRepresentation from "./SchemaRepresentation.ts"

/**
 * A reference to a declaration or import whose identity is independent of its printed name.
 *
 * **Gotchas**
 *
 * Bindings throw on string coercion. Embed them with `code` and render the containing module.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export interface Binding {
  readonly _tag: "Binding"
  readonly preferredName: string
  readonly toString: () => never
}

interface ImportBinding extends Binding {
  readonly import: Import
}

/**
 * A declaration binding with a name allocated in its owning module.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export interface DeclarationBinding extends Binding {
  readonly name: string
}

// Object fragments throw on string coercion to prevent accidental "[object Object]" output.
// Compose them with `code` so bindings and import aliases are resolved during rendering.
/**
 * Source text that retains declaration and import references until rendering.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export type Fragment = string | Binding | {
  readonly _tag: "Parts"
  readonly parts: ReadonlyArray<Fragment>
  readonly toString: () => never
} | {
  readonly _tag: "Deferred"
  readonly render: (render: Render) => string
  readonly toString: () => never
}

/**
 * A function that resolves a fragment using the current module names and imports.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export type Render = (fragment: Fragment) => string

/**
 * A fragment, primitive, or nested collection accepted by the code template helpers.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export type CodeHole = Fragment | number | ReadonlyArray<CodeHole> | undefined | null | false

/**
 * A structured import request with its preferred local name and optional import attributes.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export interface Import {
  readonly module: string
  readonly kind: "Namespace" | "Default" | "Named"
  readonly imported: string
  readonly local: string
  readonly typeOnly: boolean
  readonly attributes: string
}

interface Declaration {
  readonly binding: Binding
  readonly fragments: ReadonlyArray<Fragment>
  readonly dependencies: ReadonlyArray<Binding>
}

const keywords = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "any",
  "boolean",
  "bigint",
  "never",
  "number",
  "object",
  "string",
  "symbol",
  "unknown",
  "undefined",
  "intrinsic",
  "eval",
  "arguments"
])

function binding(preferredName: string): Binding {
  return { _tag: "Binding", preferredName, toString: InternalCodegen.cannotCoerce }
}

function importKey(input: Import): string {
  return JSON.stringify([input.module, input.kind, input.imported, input.attributes])
}

function imported(input: Import): ImportBinding {
  return { ...binding(input.local), import: input }
}

/**
 * Creates a namespace import binding that can be shared across generated modules.
 *
 * @stability experimental
 * @category constructors
 * @since 4.1.5
 */
export function importNamespace(
  module: string,
  local: string,
  options?: { readonly typeOnly?: boolean | undefined }
): Binding {
  return imported({
    module,
    local,
    kind: "Namespace",
    imported: "*",
    typeOnly: options?.typeOnly === true,
    attributes: ""
  })
}

/**
 * Creates a named import binding that can be shared across generated modules.
 *
 * @stability experimental
 * @category constructors
 * @since 4.1.5
 */
export function importNamed(
  module: string,
  name: string,
  options?: { readonly typeOnly?: boolean | undefined }
): Binding {
  return imported({
    module,
    local: name,
    kind: "Named",
    imported: name,
    typeOnly: options?.typeOnly === true,
    attributes: ""
  })
}

/**
 * Creates a default import binding that can be shared across generated modules.
 *
 * @stability experimental
 * @category constructors
 * @since 4.1.5
 */
export function importDefault(
  module: string,
  local: string,
  options?: { readonly typeOnly?: boolean | undefined }
): Binding {
  return imported({
    module,
    local,
    kind: "Default",
    imported: "default",
    typeOnly: options?.typeOnly === true,
    attributes: ""
  })
}

/**
 * Combines source text and bindings without resolving their names.
 *
 * @stability experimental
 * @category constructors
 * @since 4.1.5
 */
export const code: (strings: TemplateStringsArray, ...values: ReadonlyArray<CodeHole>) => Fragment =
  InternalCodegen.code

/**
 * Joins code fragments with a source-text separator.
 *
 * @stability experimental
 * @category combining
 * @since 4.1.5
 */
export const join: (values: ReadonlyArray<CodeHole>, separator: string) => Fragment = InternalCodegen.join

/**
 * Defers source construction until its bindings can be rendered.
 *
 * @stability experimental
 * @category constructors
 * @since 4.1.5
 */
export const deferred: (render: (render: Render) => string) => Fragment = InternalCodegen.deferred

/**
 * Indents nonempty lines after the first line of a fragment by two spaces.
 *
 * @stability experimental
 * @category transforming
 * @since 4.1.5
 */
export function indent(content: CodeHole): Fragment {
  const fragment = code`${content}`
  return deferred((render) => render(fragment).replace(/\n(?=[^\n])/g, "\n  "))
}

/**
 * Formats a primitive as a JavaScript literal, qualifying non-finite numbers with globalThis.
 *
 * @stability experimental
 * @category formatting
 * @since 4.1.5
 */
export const literal: (value: string | number | bigint | boolean | null | undefined) => string = InternalCodegen.literal

const isIdentifier = (name: string): boolean => /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u.test(name)

/**
 * Formats an object property key, using a computed key for __proto__.
 *
 * @stability experimental
 * @category formatting
 * @since 4.1.5
 */
export function propertyKey(name: string): string {
  return name === "__proto__" ? `[${literal(name)}]` : isIdentifier(name) ? name : literal(name)
}

/**
 * Formats text as a JSDoc comment and escapes embedded comment terminators.
 *
 * @stability experimental
 * @category formatting
 * @since 4.1.5
 */
export function docComment(text: string | ReadonlyArray<string>): string {
  const lines = (typeof text === "string" ? [text] : text)
    .flatMap((line) => line.split(/\r\n?|\n/))
    .map((line) => line.trimEnd().replaceAll("*/", "*\\/"))
  while (lines[0] === "") lines.shift()
  while (lines[lines.length - 1] === "") lines.pop()
  if (lines.length === 0) return ""
  return lines.length === 1
    ? `/** ${lines[0]} */\n`
    : `/**\n${lines.map((line) => line === "" ? " *" : ` * ${line}`).join("\n")}\n */\n`
}

/**
 * A declaration scope belonging to one generated module.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export interface Scope {
  readonly _tag: "Scope"
}

interface ScopeState extends Scope {
  readonly owner: object
  readonly taken: Set<string>
  readonly nested: Set<string>
  readonly parent: ScopeState | undefined
}

interface UsedImport {
  readonly input: Import
  readonly local: string
  runtime: boolean
}

function printImports(imports: ReadonlyArray<UsedImport | string>): ReadonlyArray<string> {
  const lines: Array<string> = []
  const groups = new Map<string, Array<UsedImport>>()
  for (const used of imports) {
    if (typeof used === "string") continue
    const { input } = used
    if (input.kind === "Named") {
      const key = JSON.stringify([input.module, input.attributes])
      const group = groups.get(key)
      if (group === undefined) groups.set(key, [used])
      else group.push(used)
    }
  }
  for (const used of imports) {
    if (typeof used === "string") {
      lines.push(used)
      continue
    }
    const { input, local, runtime } = used
    if (input.kind !== "Named") {
      lines.push(
        `import ${runtime ? "" : "type "}${input.kind === "Namespace" ? "* as " : ""}${local} from ${
          literal(input.module)
        }${input.attributes}`
      )
      continue
    }
    const key = JSON.stringify([input.module, input.attributes])
    const group = groups.get(key)
    if (group === undefined) continue
    const typeOnly = group.every((used) => !used.runtime)
    if (!typeOnly && !runtime) continue
    groups.delete(key)
    const specifiers = group.map(({ input, local, runtime }) =>
      `${typeOnly || runtime ? "" : "type "}${isIdentifier(input.imported) ? input.imported : literal(input.imported)}${
        input.imported === local ? "" : ` as ${local}`
      }`
    )
    lines.push(
      `import ${typeOnly ? "type " : ""}{ ${specifiers.join(", ")} } from ${literal(input.module)}${input.attributes}`
    )
  }
  return lines
}

/**
 * A mutable builder for a TypeScript module, with shared names, imports, and declaration ordering.
 *
 * **Details**
 *
 * Mutation methods return this builder for chaining. Allocation methods return bindings for use in code fragments.
 * Printing produces a snapshot; the builder remains open for further declarations.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export class Module {
  readonly #reserved: ReadonlySet<string>
  readonly #root: ScopeState = {
    _tag: "Scope",
    owner: {},
    taken: new Set(),
    nested: new Set(),
    parent: undefined
  }
  readonly #declarations = new Map<Binding, Declaration>()
  readonly #imports = new Map<string, ImportBinding>()
  readonly #provided = new Map<string, ImportBinding>()
  readonly #sideEffects = new Set<string>()
  readonly #importOrder: Array<ImportBinding | string> = []
  readonly #body: Array<Fragment> = []
  readonly #bindings = new Map<Binding, string>()

  /**
   * Creates an empty builder with optional names reserved for its surrounding code.
   */
  constructor(reserved: ReadonlyArray<string> = []) {
    this.#reserved = new Set([...keywords, "globalThis", ...reserved])
  }

  /**
   * Creates a nested declaration scope in a module.
   */
  scope(parent: Scope = this.#root): Scope {
    const state = this.#getScope(parent)
    const scope: ScopeState = {
      _tag: "Scope",
      owner: state.owner,
      taken: new Set(),
      nested: new Set(),
      parent: state
    }
    return scope
  }

  /**
   * Allocates a declaration binding, sanitizing and disambiguating its preferred name.
   *
   * **Details**
   *
   * Exact names throw when invalid or already reserved. Names also avoid enclosing and nested scopes.
   */
  declare(
    preferredName: string,
    options?: { readonly exact?: boolean | undefined; readonly scope?: Scope | undefined }
  ): DeclarationBinding {
    const scope = this.#getScope(options?.scope ?? this.#root)
    const takenBy = (name: string): string | undefined => {
      if (this.#reserved.has(name)) return "it is reserved"
      if (scope.nested.has(name)) return "a nested scope declares it"
      for (let current: ScopeState | undefined = scope; current !== undefined; current = current.parent) {
        if (current.taken.has(name)) {
          return current === scope
            ? "this scope declares it"
            : "an enclosing scope declares it"
        }
      }
      return undefined
    }
    if (options?.exact) {
      const reason = isIdentifier(preferredName) ? takenBy(preferredName) : "it is not an identifier"
      if (reason !== undefined) throw new Error(`Cannot declare exact name ${literal(preferredName)}: ${reason}`)
    }
    const name = options?.exact ? preferredName : allocate(preferredName, (name) => takenBy(name) !== undefined)
    const local: DeclarationBinding = { ...binding(preferredName), name }
    reserve(scope, name)
    this.#bindings.set(local, name)
    return local
  }

  /**
   * Registers a binding's declaration fragments and eager initialization dependencies.
   */
  define(binding: Binding, fragments: ReadonlyArray<Fragment>, dependencies: ReadonlyArray<Binding> = []): this {
    if (!this.#bindings.has(binding)) {
      throw new Error("Expected a declaration binding owned by this module")
    }
    if (this.#declarations.has(binding)) {
      throw new Error(`Duplicate definition: ${binding.preferredName}`)
    }
    this.#declarations.set(binding, { binding, fragments, dependencies })
    return this
  }

  /**
   * Adds named schema representations to a module and returns their declaration bindings by requested name.
   *
   * **When to use**
   *
   * Use when schemas share a generated module with other imports and declarations.
   *
   * **Details**
   *
   * Registers exported type aliases and runtime schemas, their referenced definitions, and auxiliary declarations.
   * Supply the shared reference table through `references`. Set `typeOnly` to emit types and ambient auxiliaries.
   * Returned keys preserve the requested names even when declaration names must change to avoid collisions.
   * A root that references a definition of the same name reuses that definition's binding.
   * The module remains open for further declarations; imports and initialization order are resolved when printing.
   *
   * **Gotchas**
   *
   * Recursive representations must contain explicit suspensions. Custom declarations and checks require supported
   * `toCode` callbacks. Each callback is called once and its exceptions pass through unchanged.
   * Callback output supports imports, qualified names, generic and structural types, API calls,
   * literal/object/array arguments, and zero-argument arrows. Unsupported syntax throws with its document path.
   * When another declaration eagerly uses a returned binding, include it in that declaration's dependencies.
   *
   * **Example** (Sharing names with generated schema declarations)
   *
   * ```ts import.meta.vitest
   * import { Codegen, Schema, SchemaRepresentation } from "effect"
   *
   * const module = new Codegen.Module()
   * const document = SchemaRepresentation.toRepresentation(Schema.String.ast)
   * const schemas = module.addSchemas({ User: document.representation }, {
   *   references: document.references
   * })
   * const user = schemas.get("User")!
   * const alias = module.declare("User")
   * const source = module
   *   .define(alias, [Codegen.code`export const ${alias} = ${user}`], [user])
   *   .print()
   *
   * source.includes("export const User1 = User") // => true
   * ```
   *
   * @see {@link Module.define} for adding surrounding declarations
   */
  addSchemas(schemas: Readonly<Record<string, SchemaRepresentation.Representation>>, options?: {
    readonly references?: SchemaRepresentation.References | undefined
    readonly typeOnly?: boolean | undefined
  }): ReadonlyMap<string, DeclarationBinding> {
    return SchemaCodegen.addSchemas(this, schemas, options)
  }

  /**
   * Registers a structured import request and returns its binding.
   */
  addImport(input: Import): Binding {
    const key = JSON.stringify([importKey(input), input.local, input.typeOnly])
    const existing = this.#imports.get(key)
    if (existing !== undefined) return existing
    const result = imported(input)
    this.#imports.set(key, result)
    this.#importOrder.push(result)
    return result
  }

  /**
   * Registers a fixed import binding supplied by surrounding code without emitting its import declaration.
   */
  provideImport(input: Import): Binding {
    const key = importKey(input)
    const existing = this.#provided.get(key)
    if (existing !== undefined && existing.import.local === input.local) return existing
    const root = this.#root
    if (
      existing !== undefined || this.#reserved.has(input.local) || root.taken.has(input.local) ||
      root.nested.has(input.local)
    ) {
      throw new Error(`Conflicting predefined import: ${input.local}`)
    }
    const result = imported(input)
    reserve(root, input.local)
    this.#provided.set(key, result)
    return result
  }

  /**
   * Registers a side-effect import, preserving its first registration order.
   */
  addSideEffect(module: string, attributes = ""): this {
    const source = `import ${literal(module)}${attributes}`
    if (!this.#sideEffects.has(source)) {
      this.#sideEffects.add(source)
      this.#importOrder.push(source)
    }
    return this
  }

  /**
   * Appends a source fragment after the module's declarations.
   */
  add(fragment: Fragment): this {
    this.#body.push(fragment)
    return this
  }

  /**
   * Renders a snapshot of the module with declarations in dependency order and roots in input order.
   *
   * **Gotchas**
   *
   * Missing definitions and eager dependency cycles throw. Adding declarations later can change import
   * aliases, so render the complete module again after further changes.
   */
  finalize(roots: ReadonlyArray<Fragment> = []): {
    readonly names: ReadonlyMap<Binding, string>
    readonly declarations: ReadonlyArray<{ readonly binding: Binding; readonly fragments: ReadonlyArray<string> }>
    readonly roots: ReadonlyArray<string>
    readonly imports: ReadonlyArray<string>
    readonly body: ReadonlyArray<string>
  } {
    const visiting = new Set<Binding>()
    const visited = new Set<Binding>()
    const ordered: Array<Declaration> = []
    const visit = (binding: Binding): void => {
      if (visited.has(binding) || hasProperty(binding, "import")) return
      if (visiting.has(binding)) throw new Error(`Cyclic initialization dependency: ${binding.preferredName}`)
      const declaration = this.#declarations.get(binding)
      if (declaration === undefined) throw new Error(`Missing definition: ${binding.preferredName}`)
      visiting.add(binding)
      for (const dependency of declaration.dependencies) visit(dependency)
      visiting.delete(binding)
      visited.add(binding)
      ordered.push(declaration)
    }
    for (const binding of this.#declarations.keys()) visit(binding)

    const names = new Map(this.#bindings)
    const imports = new Map<string, UsedImport>()
    const render = this.#renderer(names, imports)
    const output = {
      names,
      declarations: ordered.map(({ binding, fragments }) => ({ binding, fragments: fragments.map(render) })),
      roots: roots.map(render),
      body: this.#body.map(render)
    }
    const orderedImports: Array<string | UsedImport> = []
    for (const entry of this.#importOrder) {
      if (typeof entry === "string") {
        orderedImports.push(entry)
      } else {
        const key = importKey(entry.import)
        const used = imports.get(key)
        if (used !== undefined && (!used.runtime || !entry.import.typeOnly)) {
          orderedImports.push(used)
          imports.delete(key)
        }
      }
    }
    return { ...output, imports: printImports([...orderedImports, ...imports.values()]) }
  }

  /**
   * Prints a module's imports, ordered declarations, and appended source as TypeScript.
   */
  print(): string {
    const output = this.finalize()
    return [
      output.imports.join("\n"),
      ...output.declarations.flatMap((declaration) => declaration.fragments),
      ...output.body
    ]
      .filter((part) => part !== "").join("\n\n") + "\n"
  }

  #getScope(scope: Scope): ScopeState {
    const state = scope as ScopeState
    if (state.owner !== this.#root.owner) throw new Error("Scope belongs to another module")
    return state
  }

  #renderer(names: Map<Binding, string>, imports: Map<string, UsedImport>): Render {
    const root = this.#root
    const taken = new Set([...this.#reserved, ...root.taken, ...root.nested])
    const cache = new Map<Fragment, string>()
    const render: Render = (fragment) => {
      if (typeof fragment === "string") return fragment
      const previous = cache.get(fragment)
      if (previous !== undefined) return previous
      let value: string
      switch (fragment._tag) {
        case "Parts":
          value = fragment.parts.map(render).join("")
          break
        case "Deferred":
          value = fragment.render(render)
          break
        case "Binding": {
          if (hasProperty(fragment, "import")) {
            const input = (fragment as ImportBinding).import
            const key = importKey(input)
            const provided = this.#provided.get(key)
            if (provided !== undefined) {
              value = provided.import.local
            } else {
              let used = imports.get(key)
              if (used === undefined) {
                const local = allocate(input.local, (name) => taken.has(name))
                taken.add(local)
                used = { input, local, runtime: false }
                imports.set(key, used)
              }
              used.runtime ||= !input.typeOnly
              value = used.local
            }
            names.set(fragment, value)
          } else {
            const name = names.get(fragment)
            if (name === undefined) throw new Error("Binding belongs to another module")
            value = name
          }
          break
        }
      }
      cache.set(fragment, value)
      return value
    }
    return render
  }
}

function reserve(scope: ScopeState, name: string): void {
  scope.taken.add(name)
  for (let current = scope.parent; current !== undefined; current = current.parent) {
    current.nested.add(name)
  }
}

function allocate(preferredName: string, isTaken: (name: string) => boolean): string {
  const base = preferredName.replace(/[^$_\u200c\u200d\p{ID_Continue}]/gu, "_") || "_"
  const valid = /^[$_\p{ID_Start}]/u.test(base) ? base : `_${base}`
  let name = valid
  let suffix = 0
  while (isTaken(name)) name = `${valid}${++suffix}`
  return name
}
