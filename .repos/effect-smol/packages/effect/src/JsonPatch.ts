/**
 * The `JsonPatch` module computes and applies deterministic patch documents for
 * JSON values. A patch is an ordered list of `add`, `remove`, and `replace`
 * operations addressed by JSON Pointer paths. Use it to describe the structural
 * difference between two JSON documents, serialize that difference, and replay
 * it without mutating the original input.
 *
 * **Mental model**
 *
 * - A {@link JsonPatch} is applied from left to right; each operation observes
 *   the document produced by the operations before it.
 * - Paths use JSON Pointer syntax. The empty path `""` targets the whole
 *   document, and `/users/0/name` targets a nested property or array element.
 * - This module implements the deterministic `add`, `remove`, and `replace`
 *   subset of RFC 6902. It does not model `test`, `move`, or `copy`.
 * - {@link get} compares JSON structure, not domain meaning. It can detect that
 *   a value changed, but it does not infer semantic edits such as array moves.
 * - {@link apply} copies changed containers and returns a new JSON value. An
 *   empty patch returns the original document reference.
 *
 * **Common tasks**
 *
 * - Compute a structural diff between two JSON values with {@link get}.
 * - Apply generated or hand-written operations with {@link apply}.
 * - Accept, store, or serialize complete patch documents as {@link JsonPatch}.
 * - Type individual operations with {@link JsonPatchOperation}.
 *
 * **Gotchas**
 *
 * - Generated patches are deterministic, but not guaranteed to be minimal.
 * - Array removals are emitted from highest index to lowest so later removals do
 *   not shift earlier targets.
 * - `"-"` is valid only as the final token for array append operations.
 * - Invalid paths, missing properties, and out-of-bounds array indices throw.
 * - Root `add` and `replace` operations replace the whole document; root
 *   `remove` is unsupported.
 *
 * **Example** (Computing and applying a patch)
 *
 * ```ts
 * import { JsonPatch } from "effect"
 *
 * const before = { title: "draft", tags: ["fp"] }
 * const after = { title: "published", tags: ["fp", "effect"] }
 *
 * const patch = JsonPatch.get(before, after)
 * // [
 * //   { op: "add", path: "/tags/1", value: "effect" },
 * //   { op: "replace", path: "/title", value: "published" }
 * // ]
 *
 * const updated = JsonPatch.apply(patch, before)
 * // { title: "published", tags: ["fp", "effect"] }
 * ```
 *
 * **See also**
 *
 * - `JsonPointer` for escaping and unescaping JSON Pointer path tokens.
 * - {@link Schema.Json} for the JSON value shape accepted by this module.
 *
 * @since 4.0.0
 */
import { format } from "./Formatter.ts"
import { escapeToken, unescapeToken } from "./JsonPointer.ts"
import * as Predicate from "./Predicate.ts"
import type * as Schema from "./Schema.ts"

/**
 * A single JSON Patch operation.
 *
 * **When to use**
 *
 * Use to manually construct patch operations, accept patch operations from
 * callers, or type-check patch operation structures.
 *
 * **Details**
 *
 * Represents one transformation step in a JSON Patch document. This is a subset
 * of RFC 6902, restricted to operations that can be applied deterministically
 * without additional context. All fields are readonly, paths use JSON Pointer
 * syntax, and the empty string `""` refers to the root document. Operations are
 * discriminated by the `op` field, and the optional `description` field can be
 * used for documentation.
 *
 * **Example** (All operation types)
 *
 * ```ts
 * import { JsonPatch } from "effect"
 *
 * const addOp: JsonPatch.JsonPatchOperation = {
 *   op: "add",
 *   path: "/users/-",
 *   value: { id: 1, name: "Alice" }
 * }
 *
 * const removeOp: JsonPatch.JsonPatchOperation = {
 *   op: "remove",
 *   path: "/users/0"
 * }
 *
 * const replaceOp: JsonPatch.JsonPatchOperation = {
 *   op: "replace",
 *   path: "/users/0/name",
 *   value: "Bob"
 * }
 * ```
 *
 * @see {@link JsonPatch} for the array of operations forming a complete patch
 * @see {@link get} to compute operations automatically from value differences
 * @see {@link apply} to apply operations to transform documents
 * @category models
 * @since 4.0.0
 */
export type JsonPatchOperation =
  | {
    readonly op: "add"
    /**
     * JSON Pointer to the target location. For arrays, the last token may be `-`
     * to append.
     *
     * **When to use**
     *
     * Use to identify where the `add` operation inserts its value.
     */
    readonly path: string
    readonly value: Schema.Json
    readonly description?: string
  }
  | {
    readonly op: "remove"
    /**
     * JSON Pointer to the target location.
     *
     * **When to use**
     *
     * Use to identify which location the `remove` operation deletes.
     */
    readonly path: string
    readonly description?: string
  }
  | {
    readonly op: "replace"
    /**
     * JSON Pointer to the target location. Use `""` to replace the root document.
     *
     * **When to use**
     *
     * Use to identify which location the `replace` operation overwrites.
     */
    readonly path: string
    readonly value: Schema.Json
    readonly description?: string
  }

/**
 * A JSON Patch document (an ordered list of operations).
 *
 * **When to use**
 *
 * Use to store, serialize, pass, or validate complete patch documents.
 *
 * **Details**
 *
 * Represents a complete transformation as a readonly sequence of immutable
 * operations. Operations are applied sequentially from first to last, and later
 * operations observe the document state produced by earlier operations. An empty
 * array represents a no-op patch and returns the original document.
 *
 * **Example** (Multi-operation patch)
 *
 * ```ts
 * import { JsonPatch } from "effect"
 *
 * const patch: JsonPatch.JsonPatch = [
 *   { op: "add", path: "/items/-", value: "apple" },
 *   { op: "replace", path: "/count", value: 5 },
 *   { op: "remove", path: "/oldField" }
 * ]
 *
 * const result = JsonPatch.apply(patch, { count: 3, oldField: "value" })
 * // { count: 5, items: ["apple"] }
 * ```
 *
 * @see {@link JsonPatchOperation} for individual operation types
 * @see {@link get} to generate patches from value differences
 * @see {@link apply} to execute patches to transform documents
 * @category models
 * @since 4.0.0
 */
export type JsonPatch = ReadonlyArray<JsonPatchOperation>

/**
 * Computes a structural patch that transforms `oldValue` into `newValue`.
 *
 * **When to use**
 *
 * Use to compute differences between JSON documents, detect structural
 * changes, or create deterministic update operations from before and after
 * states.
 *
 * **Details**
 *
 * Generates a structural diff between two JSON values, producing a patch that
 * yields `newValue` when applied to `oldValue`. It returns an empty array when
 * values are identical, recursively diffs nested structures, emits root
 * `replace` operations for primitive changes, and processes object keys in
 * sorted order for stable output.
 *
 * **Gotchas**
 *
 * Arrays are compared by index position, with no move or copy detection. Array
 * removals are emitted from highest to lowest index to prevent index shifting.
 * The output is deterministic but not guaranteed to be minimal.
 *
 * **Example** (Computing object diff)
 *
 * ```ts
 * import { JsonPatch } from "effect"
 *
 * const oldValue = { users: [{ id: 1, name: "Alice" }], count: 1 }
 * const newValue = { users: [{ id: 1, name: "Bob" }, { id: 2, name: "Charlie" }], count: 2 }
 *
 * const patch = JsonPatch.get(oldValue, newValue)
 * // [
 * //   { op: "replace", path: "/users/0/name", value: "Bob" },
 * //   { op: "add", path: "/users/1", value: { id: 2, name: "Charlie" } },
 * //   { op: "replace", path: "/count", value: 2 }
 * // ]
 * ```
 *
 * @see {@link apply} to apply the generated patch to a document
 * @see {@link JsonPatchOperation} for the operation types in the patch
 * @category transforming
 * @since 4.0.0
 */
export function get(oldValue: Schema.Json, newValue: Schema.Json): JsonPatch {
  if (Object.is(oldValue, newValue)) return []
  const patches: Array<JsonPatchOperation> = []

  if (Array.isArray(oldValue) && Array.isArray(newValue)) {
    const len1 = oldValue.length
    const len2 = newValue.length

    // Compare shared prefix by index
    const shared = Math.min(len1, len2)
    for (let i = 0; i < shared; i++) {
      const path = `/${i}`
      const patch = get(oldValue[i], newValue[i])
      for (const op of patch) {
        prefixPathInPlace(op, path)
        patches.push(op)
      }
    }

    // Remove from end to start so later indices do not shift.
    for (let i = len1 - 1; i >= len2; i--) {
      patches.push({ op: "remove", path: `/${i}` })
    }

    // Add from beginning to end.
    for (let i = len1; i < len2; i++) {
      patches.push({ op: "add", path: `/${i}`, value: newValue[i] })
    }

    return patches
  }

  if (isJsonObject(oldValue) && isJsonObject(newValue)) {
    const keys1 = Object.keys(oldValue)
    const keys2 = Object.keys(newValue)
    const allKeys = Array.from(new Set([...keys1, ...keys2])).sort()

    for (const key of allKeys) {
      const esc = escapeToken(key)
      const path = `/${esc}`
      const hasKey1 = Object.hasOwn(oldValue, key)
      const hasKey2 = Object.hasOwn(newValue, key)

      if (hasKey1 && hasKey2) {
        const patch = get(oldValue[key], newValue[key])
        for (const op of patch) {
          prefixPathInPlace(op, path)
          patches.push(op)
        }
      } else if (!hasKey1 && hasKey2) {
        patches.push({ op: "add", path, value: newValue[key] })
      } else if (hasKey1 && !hasKey2) {
        patches.push({ op: "remove", path })
      }
    }

    return patches
  }

  patches.push({ op: "replace", path: "", value: newValue })
  return patches
}

/**
 * Applies a JSON Patch to a JSON document.
 *
 * **When to use**
 *
 * Use to execute patches generated by {@link get}, transform documents
 * with manually constructed patches, or process patch operations from external
 * sources.
 *
 * **Details**
 *
 * Executes patch operations sequentially, so later operations see changes made
 * by earlier operations. It never mutates the input document; array and object
 * operations copy the affected containers. An empty patch returns the original
 * reference, and a root replace (`path: ""`) returns the provided value
 * directly.
 *
 * **Gotchas**
 *
 * Invalid paths, missing properties, and out-of-bounds array indices throw
 * errors.
 *
 * **Example** (Applying a patch)
 *
 * ```ts
 * import { JsonPatch } from "effect"
 *
 * const document = { items: [1, 2, 3], total: 6 }
 * const patch: JsonPatch.JsonPatch = [
 *   { op: "add", path: "/items/-", value: 4 },
 *   { op: "replace", path: "/total", value: 10 }
 * ]
 *
 * const result = JsonPatch.apply(patch, document)
 * // { items: [1, 2, 3, 4], total: 10 }
 * ```
 *
 * @see {@link get} to generate patches from value differences
 * @see {@link JsonPatchOperation} for the operation types being applied
 * @category transforming
 * @since 4.0.0
 */
export function apply(patch: JsonPatch, oldValue: Schema.Json): Schema.Json {
  let doc = oldValue

  for (const op of patch) {
    switch (op.op) {
      case "replace": {
        doc = op.path === "" ? op.value : setAt(doc, op.path, op.value, "replace")
        break
      }
      case "add": {
        doc = addAt(doc, op.path, op.value)
        break
      }
      case "remove": {
        doc = setAt(doc, op.path, undefined, "remove")
        break
      }
    }
  }

  return doc
}

// Mutates op.path in place for perf; safe because child ops are freshly created and not shared.
function prefixPathInPlace(op: JsonPatchOperation, parent: string): void {
  ;(op as any).path = op.path === "" ? parent : parent + op.path
}

function isJsonObject(value: unknown): value is Schema.JsonObject {
  return Predicate.isObject(value)
}

/**
 * Tokenize a JSON Pointer into unescaped reference tokens.
 *
 * - `""` (empty pointer) refers to the root and returns `[]`
 * - Non-empty pointers must start with `/`
 */
function tokenize(pointer: string): Array<string> {
  if (pointer === "") return []
  if (pointer.charCodeAt(0) !== 47 /* "/" */) {
    throw new Error(`Invalid JSON Pointer, it must start with "/": ${format(pointer)}`)
  }
  return pointer.split("/").slice(1).map(unescapeToken)
}

/** Convert a reference token to a non-negative array index (rejects `-` and negatives). */
function toIndex(token: string): number {
  if (!/^(0|[1-9]\d*)$/.test(token)) {
    throw new Error(`Invalid array index: "${token}"`)
  }
  return Number(token)
}

function addAt(doc: Schema.Json, pointer: string, val: Schema.Json): Schema.Json {
  if (pointer === "") return val

  const resolved = resolveParent(doc, pointer)
  if (resolved === null) {
    throw new Error(`Cannot add at "${pointer}" (parent not found or not a container).`)
  }

  const { lastToken, parent, stack } = resolved

  if (Array.isArray(parent)) {
    const idx = lastToken === "-" ? parent.length : toIndex(lastToken)
    if (idx < 0 || idx > parent.length) throw new Error(`Array index out of bounds at "${pointer}".`)
    const updated = parent.slice()
    updated.splice(idx, 0, val)
    return rebuildFromStack(stack, updated)
  }

  if (isJsonObject(parent)) {
    const updated = { ...parent }
    updated[lastToken] = val
    return rebuildFromStack(stack, updated)
  }

  throw new Error(`Cannot add at "${pointer}" (parent not found or not a container).`)
}

function setAt(
  doc: Schema.Json,
  pointer: string,
  val: Schema.Json | undefined,
  mode: "replace" | "remove"
): Schema.Json {
  if (pointer === "") {
    if (mode === "remove" || val === undefined) throw new Error("Unsupported operation at the root")
    return val
  }

  const resolved = resolveParent(doc, pointer)
  if (resolved === null) {
    throw new Error(`Cannot ${mode} at "${pointer}" (parent not found or not a container).`)
  }

  const { lastToken, parent, stack } = resolved

  if (Array.isArray(parent)) {
    if (lastToken === "-") throw new Error(`"-" is not valid for ${mode} at "${pointer}".`)
    const idx = toIndex(lastToken)
    if (idx < 0 || idx >= parent.length) throw new Error(`Array index out of bounds at "${pointer}".`)
    const updated = parent.slice()
    if (mode === "remove") updated.splice(idx, 1)
    else updated[idx] = val
    return rebuildFromStack(stack, updated)
  }

  if (isJsonObject(parent)) {
    if (!Object.hasOwn(parent, lastToken)) {
      throw new Error(`Property "${lastToken}" does not exist at "${pointer}".`)
    }
    const updated = { ...parent }
    if (mode === "remove") delete updated[lastToken]
    else updated[lastToken] = val!
    return rebuildFromStack(stack, updated)
  }

  throw new Error(`Cannot ${mode} at "${pointer}" (parent not found or not a container).`)
}

type StackEntry = { readonly container: unknown; readonly token: number | string }

// Walk to the parent of `pointer`, recording the path.
// Returns null if the parent path cannot be resolved.
function resolveParent(
  doc: Schema.Json,
  pointer: string
): { readonly stack: ReadonlyArray<StackEntry>; readonly parent: unknown; readonly lastToken: string } | null {
  const tokens = tokenize(pointer)
  if (tokens.length === 0) return null // caller handles root

  const lastToken = tokens[tokens.length - 1]
  const stack: Array<StackEntry> = []
  let cur: unknown = doc

  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i]

    if (cur == null) return null

    if (Array.isArray(cur)) {
      const idx = toIndex(token)
      if (idx < 0 || idx >= cur.length) return null
      stack.push({ container: cur, token: idx })
      cur = cur[idx]
      continue
    }

    if (cur && typeof cur === "object") {
      if (!Object.hasOwn(cur, token)) return null
      stack.push({ container: cur, token })
      cur = (cur as any)[token]
      continue
    }

    return null
  }

  return { stack, parent: cur, lastToken }
}

// Rebuild the document by writing `newParent` back through `stack`.
function rebuildFromStack(stack: ReadonlyArray<StackEntry>, newParent: Schema.Json): Schema.Json {
  let acc: Schema.Json = newParent

  for (let i = stack.length - 1; i >= 0; i--) {
    const { container, token } = stack[i]

    if (Array.isArray(container)) {
      const copy = container.slice()
      copy[token as number] = acc
      acc = copy
    } else {
      const copy = { ...(container as Schema.JsonObject) }
      copy[token as string] = acc
      acc = copy
    }
  }

  return acc
}
