/**
 * Inspection protocol for stable string, JSON, and Node.js representations.
 *
 * This module is the small bridge used by Effect data types to explain
 * themselves in logs, REPLs, test failures, and JSON-like diagnostics. Implement
 * `Inspectable` or extend {@link Class} when a value should expose one
 * representation to `toString`, `toJSON`, and Node's `util.inspect`; use
 * {@link toJson} and {@link toStringUnknown} when formatting values supplied by
 * user code.
 *
 * ## Mental model
 *
 * Inspectable values choose their own JSON representation. {@link BaseProto}
 * and {@link Class} derive `toString()` from that representation with the
 * formatter and expose the same value through {@link NodeInspectSymbol}.
 * {@link toJson} is defensive: it calls zero-argument `toJSON` methods,
 * recurses through arrays, returns `"[toJSON threw]"` if a custom serializer
 * fails, and applies redaction to other values.
 *
 * ## Common tasks
 *
 * - Extend {@link Class} for classes that only need to define `toJSON`.
 * - Reuse {@link BaseProto} for object prototypes that should share standard
 *   inspection behavior.
 * - Format unknown diagnostic values with {@link toStringUnknown}.
 * - Implement {@link NodeInspectSymbol} when integrating directly with
 *   Node.js inspection.
 *
 * ## Gotchas
 *
 * `toJson` is meant for inspection, not canonical persistence. It catches
 * `toJSON` failures, does not deeply traverse arbitrary objects, and may
 * replace redactable values according to current redaction behavior. Keep
 * custom `toJSON` implementations side-effect free so logging and debugging do
 * not change program state.
 *
 * **Example** (Creating inspectable values)
 *
 * ```ts
 * import { Inspectable } from "effect"
 *
 * class User extends Inspectable.Class {
 *   constructor(
 *     readonly id: number,
 *     readonly name: string
 *   ) {
 *     super()
 *   }
 *
 *   toJSON() {
 *     return {
 *       _tag: "User",
 *       id: this.id,
 *       name: this.name,
 *     }
 *   }
 * }
 *
 * const user = new User(1, "Alice")
 * console.log(user.toString())
 * console.log(user[Inspectable.NodeInspectSymbol]())
 * ```
 *
 * @since 2.0.0
 */
import { format, formatJson } from "./Formatter.ts"
import * as Predicate from "./Predicate.ts"
import { redact } from "./Redactable.ts"

/**
 * Defines the symbol used by Node.js for custom object inspection.
 *
 * **When to use**
 *
 * Use to implement Node.js custom inspection for a value.
 *
 * **Details**
 *
 * This symbol is recognized by Node.js's `util.inspect()` function and the REPL
 * for custom object representation. When an object has a method with this symbol,
 * it will be called to determine how the object should be displayed.
 *
 * **Example** (Defining custom Node inspection)
 *
 * ```ts
 * import { Inspectable } from "effect"
 *
 * class CustomObject {
 *   constructor(private value: string) {}
 *
 *   [Inspectable.NodeInspectSymbol]() {
 *     return `CustomObject(${this.value})`
 *   }
 * }
 *
 * const obj = new CustomObject("hello")
 * console.log(obj) // Displays: CustomObject(hello)
 * ```
 *
 * @category symbols
 * @since 2.0.0
 */
export const NodeInspectSymbol = Symbol.for("nodejs.util.inspect.custom")

/**
 * The type of the Node.js inspection symbol used for custom object inspection.
 * This symbol type is used to implement custom inspection behavior in Node.js
 * environments.
 *
 * **When to use**
 *
 * Use to type methods keyed by the Node.js custom inspection symbol.
 *
 * **Example** (Typing custom Node inspection)
 *
 * ```ts
 * import { Inspectable } from "effect"
 *
 * class CustomObject {
 *   constructor(private value: string) {}
 *
 *   [Inspectable.NodeInspectSymbol]() {
 *     return `CustomObject(${this.value})`
 *   }
 * }
 *
 * const obj = new CustomObject("test")
 * console.log(obj) // CustomObject(test)
 * ```
 *
 * @category symbols
 * @since 2.0.0
 */
export type NodeInspectSymbol = typeof NodeInspectSymbol

/**
 * Interface for objects that can be inspected and provide custom string representations.
 *
 * **When to use**
 *
 * Use to define values with custom string, JSON, and Node.js inspection output.
 *
 * **Details**
 *
 * Objects implementing this interface can control how they appear in debugging contexts,
 * JSON serialization, and Node.js inspection. This is particularly useful for creating
 * custom data types that display meaningful information during development.
 *
 * **Example** (Implementing inspectable objects)
 *
 * ```ts
 * import { Formatter, Inspectable } from "effect"
 *
 * class Result implements Inspectable.Inspectable {
 *   constructor(
 *     private readonly tag: "Success" | "Failure",
 *     private readonly value: unknown
 *   ) {}
 *
 *   toString(): string {
 *     return Formatter.format(this.toJSON())
 *   }
 *
 *   toJSON() {
 *     return { _tag: this.tag, value: this.value }
 *   }
 *
 *   [Inspectable.NodeInspectSymbol]() {
 *     return this.toJSON()
 *   }
 * }
 *
 * const success = new Result("Success", 42)
 * console.log(success.toString()) // Pretty formatted JSON
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface Inspectable {
  toString(): string
  toJSON(): unknown
  [NodeInspectSymbol](): unknown
}

/**
 * Converts a value to a JSON-serializable representation safely.
 *
 * **When to use**
 *
 * Use when you need a safe, JSON-serializable representation of a value
 * without risking unhandled errors.
 *
 * **Details**
 *
 * This function attempts to extract JSON data from objects that implement the
 * `toJSON` method, recursively processes arrays, and handles errors gracefully.
 * For objects that don't have a `toJSON` method, it applies redaction to
 * protect sensitive information.
 *
 * @see {@link toStringUnknown} for converting unknown values to strings
 *
 * @category converting
 * @since 4.0.0
 */
export const toJson = (input: unknown): unknown => {
  try {
    if (
      Predicate.hasProperty(input, "toJSON") &&
      Predicate.isFunction(input["toJSON"]) &&
      input["toJSON"].length === 0
    ) {
      return input.toJSON()
    } else if (Array.isArray(input)) {
      return input.map(toJson)
    }
  } catch {
    return "[toJSON threw]"
  }
  return redact(input)
}

/**
 * Converts an unknown value to a string for diagnostics.
 *
 * **When to use**
 *
 * Use to produce a diagnostic string from a value whose runtime type is unknown.
 *
 * **Details**
 *
 * Strings are returned unchanged. Objects are formatted as JSON using the
 * provided whitespace setting when possible, and values that cannot be
 * formatted are converted with `String`.
 *
 * @category converting
 * @since 2.0.0
 */
export const toStringUnknown = (u: unknown, whitespace: number | string | undefined = 2): string => {
  if (typeof u === "string") {
    return u
  }
  try {
    return typeof u === "object" ? formatJson(u, { space: whitespace }) : String(u)
  } catch {
    return String(u)
  }
}

/**
 * A base prototype object that implements the {@link Inspectable} interface.
 *
 * **When to use**
 *
 * Use as a prototype for plain objects that should share standard inspectable behavior.
 *
 * **Details**
 *
 * This object provides default implementations for the {@link Inspectable} methods.
 * It can be used as a prototype for objects that want to be inspectable,
 * or as a mixin to add inspection capabilities to existing objects.
 *
 * **Example** (Using the base inspectable prototype)
 *
 * ```ts
 * import { Inspectable } from "effect"
 *
 * // Use as prototype
 * const myObject = Object.create(Inspectable.BaseProto)
 * myObject.name = "example"
 * myObject.value = 42
 *
 * console.log(myObject.toString()) // Pretty printed representation
 *
 * // Or extend in a constructor
 * function MyClass(this: any, name: string) {
 *   this.name = name
 * }
 * MyClass.prototype = Object.create(Inspectable.BaseProto)
 * MyClass.prototype.constructor = MyClass
 * ```
 *
 * @category prototypes
 * @since 2.0.0
 */
export const BaseProto: Inspectable = {
  toJSON() {
    return toJson(this)
  },
  [NodeInspectSymbol]() {
    return this.toJSON()
  },
  toString() {
    return format(this.toJSON())
  }
}

/**
 * Provides an abstract base class that implements the Inspectable interface.
 *
 * **When to use**
 *
 * Use as a base class for inspectable objects that define their own JSON representation.
 *
 * **Details**
 *
 * This class provides a convenient way to create inspectable objects by extending it.
 * Subclasses only need to implement the `toJSON()` method, and they automatically
 * get proper `toString()` and Node.js inspection support.
 *
 * **Example** (Extending the inspectable base class)
 *
 * ```ts
 * import { Inspectable } from "effect"
 *
 * class User extends Inspectable.Class {
 *   constructor(
 *     public readonly id: number,
 *     public readonly name: string,
 *     public readonly email: string
 *   ) {
 *     super()
 *   }
 *
 *   toJSON() {
 *     return {
 *       _tag: "User",
 *       id: this.id,
 *       name: this.name,
 *       email: this.email
 *     }
 *   }
 * }
 *
 * const user = new User(1, "Alice", "alice@example.com")
 * console.log(user.toString()) // Pretty printed JSON with _tag, id, name, email
 * console.log(user) // In Node.js, shows the same formatted output
 * ```
 *
 * @category classes
 * @since 2.0.0
 */
export abstract class Class {
  /**
   * Returns a JSON representation of this object.
   *
   * **When to use**
   *
   * Use to provide the JSON representation consumed by inherited inspection methods.
   *
   * **Details**
   *
   * Subclasses must implement this method to define how the object
   * should be serialized for debugging and inspection purposes.
   *
   * @since 2.0.0
   */
  abstract toJSON(): unknown
  /**
   * Node.js custom inspection method.
   *
   * **When to use**
   *
   * Use to expose the class JSON representation to Node.js inspection.
   *
   * @since 2.0.0
   */
  [NodeInspectSymbol]() {
    return this.toJSON()
  }
  /**
   * Returns a formatted string representation of this object.
   *
   * **When to use**
   *
   * Use to format the class JSON representation as a string.
   *
   * @since 2.0.0
   */
  toString() {
    return format(this.toJSON())
  }
}
