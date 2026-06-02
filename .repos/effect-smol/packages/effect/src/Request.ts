/**
 * The `Request` module defines typed request values for data loading with
 * `Effect.request`. A request is a description of work, not the execution of
 * that work: it records the success type, typed error, service requirements,
 * and the fields needed by a resolver to perform one logical operation.
 *
 * Requests are designed to be paired with a `RequestResolver`, which receives
 * pending request entries, batches or caches them when possible, and completes
 * each entry with a result. This lets calling code ask for data declaratively
 * while resolver code owns the backend-specific loading logic.
 *
 * **Mental model**
 *
 * - `Request<A, E, R>` describes one operation that succeeds with `A`, fails
 *   with `E`, and may require services `R`
 * - Constructors such as {@link of}, {@link tagged}, {@link Class}, and
 *   {@link TaggedClass} attach the request marker and structural behavior
 *   expected by the request runtime
 * - A resolver receives {@link Entry} values; each entry contains the original
 *   request, the captured context, and a completion callback
 * - Completion helpers such as {@link succeed}, {@link fail},
 *   {@link failCause}, {@link complete}, and {@link completeEffect} turn
 *   resolver results into the `Exit` expected by the waiting fiber
 *
 * **Common tasks**
 *
 * - Define request shapes with {@link Request}, {@link Class}, or
 *   {@link TaggedClass}
 * - Build lightweight request constructors with {@link of} or {@link tagged}
 * - Check unknown values with {@link isRequest}
 * - Complete pending resolver entries with {@link succeed}, {@link fail},
 *   {@link failCause}, {@link complete}, or {@link completeEffect}
 * - Extract request type members with {@link Success}, {@link Error},
 *   {@link Services}, and {@link Result}
 *
 * **Gotchas**
 *
 * - Creating a request value does not run anything; it must be submitted with
 *   `Effect.request` and handled by a resolver
 * - Resolver implementations must complete every {@link Entry} they receive,
 *   otherwise the fiber waiting for that request will not receive a value
 * - Cached and deduplicated requests depend on request identity and structural
 *   equality, so include only stable fields that describe the logical operation
 *
 * @since 2.0.0
 */
import type * as Cause from "./Cause.ts"
import type * as Context from "./Context.ts"
import type * as Effect from "./Effect.ts"
import * as Equal from "./Equal.ts"
import type * as Exit from "./Exit.ts"
import { dual } from "./Function.ts"
import * as core from "./internal/core.ts"
import * as internalEffect from "./internal/effect.ts"
import { hasProperty } from "./Predicate.ts"
import type * as Types from "./Types.ts"

const TypeId = "~effect/Request"

/**
 * A `Request<A, E, R>` is a request from a data source for a value of type `A`
 * that may fail with an `E` and have requirements of type `R`.
 *
 * **Example** (Defining typed requests)
 *
 * ```ts
 * import type { Request } from "effect"
 *
 * // Define a request that fetches a user by ID
 * interface GetUser extends Request.Request<string, Error> {
 *   readonly _tag: "GetUser"
 *   readonly id: number
 * }
 *
 * // Define a request that fetches all users
 * interface GetAllUsers extends Request.Request<ReadonlyArray<string>, Error> {
 *   readonly _tag: "GetAllUsers"
 * }
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface Request<out A, out E = never, out R = never> extends Variance<A, E, R> {}

/**
 * Alias for any `Request`, regardless of its success, error, or service
 * requirements.
 *
 * **When to use**
 *
 * Use as a generic constraint for APIs that accept any request while preserving
 * each concrete request's success, error, and service types.
 *
 * @see {@link Request} for the request interface
 * @see {@link Success} for extracting a request's success type
 * @see {@link Error} for extracting a request's error type
 * @see {@link Services} for extracting a request's service requirements
 * @see {@link Result} for the exit type produced by completing a request
 *
 * @category models
 * @since 4.0.0
 */
export type Any = Request<any, any, any>

/**
 * Variance marker carried by every `Request`.
 *
 * **Details**
 *
 * This marker preserves the success, error, and service requirement types for
 * Effect's type-level machinery. Users normally get it by extending `Request`.
 *
 * @category models
 * @since 2.0.0
 */
export interface Variance<out A, out E, out R> {
  readonly [TypeId]: {
    readonly _A: Types.Covariant<A>
    readonly _E: Types.Covariant<E>
    readonly _R: Types.Covariant<R>
  }
}

/**
 * The constructor type returned by `Request.of` and `Request.tagged`.
 *
 * **Details**
 *
 * The constructor accepts the request's data fields, excluding request variance
 * fields and any fields already supplied by the constructor such as `_tag`, and
 * returns a value of the request type.
 *
 * **Example** (Using generated request constructors)
 *
 * ```ts
 * import { Request } from "effect"
 *
 * interface GetUser extends Request.Request<string, Error> {
 *   readonly _tag: "GetUser"
 *   readonly id: number
 * }
 *
 * // Constructor type is used internally by Request.of() and Request.tagged()
 * const GetUser = Request.tagged<GetUser>("GetUser")
 * const userRequest = GetUser({ id: 123 })
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface Constructor<R extends Request<any, any, any>, T extends keyof R = never> {
  (args: Types.VoidIfEmpty<Types.Simplify<Omit<R, T | keyof (Variance<any, any, any>)>>>): R
}

/**
 * A utility type to extract the error type from a `Request`.
 *
 * **Example** (Extracting a request error type)
 *
 * ```ts
 * import type { Request } from "effect"
 *
 * interface GetUser extends Request.Request<string, Error> {
 *   readonly id: number
 * }
 *
 * // Extract the error type from a Request using the utility
 * type UserError = Request.Error<GetUser> // Error
 * ```
 *
 * @category type-level
 * @since 2.0.0
 */
export type Error<T extends Request<any, any, any>> = [T] extends [Request<infer _A, infer _E, infer _R>] ? _E : never

/**
 * A utility type to extract the value type from a `Request`.
 *
 * **Example** (Extracting a request success type)
 *
 * ```ts
 * import type { Request } from "effect"
 *
 * interface GetUser extends Request.Request<string, Error> {
 *   readonly _tag: "GetUser"
 *   readonly id: number
 * }
 *
 * // Extract the success type from a Request using the utility
 * type UserSuccess = Request.Success<GetUser> // string
 * ```
 *
 * @category type-level
 * @since 2.0.0
 */
export type Success<T extends Request<any, any, any>> = [T] extends [Request<infer _A, infer _E, infer _R>] ? _A
  : never

/**
 * A utility type to extract the requirements type from a `Request`.
 *
 * @category type-level
 * @since 4.0.0
 */
export type Services<T extends Request<any, any, any>> = [T] extends [Request<infer _A, infer _E, infer _R>] ? _R
  : never

/**
 * A utility type to extract the result type from a `Request`.
 *
 * **Example** (Extracting a request result type)
 *
 * ```ts
 * import type { Request } from "effect"
 *
 * interface GetUser extends Request.Request<string, Error> {
 *   readonly _tag: "GetUser"
 *   readonly id: number
 * }
 *
 * // Extract the result type from a Request using the utility
 * type UserResult = Request.Result<GetUser> // Exit.Exit<string, Error>
 * ```
 *
 * @category type-level
 * @since 2.0.0
 */
export type Result<T extends Request<any, any, any>> = T extends Request<infer A, infer E, infer _R> ? Exit.Exit<A, E>
  : never

const requestVariance = Equal.byReferenceUnsafe({
  /* c8 ignore next */
  _E: (_: never) => _,
  /* c8 ignore next */
  _A: (_: never) => _,
  /* c8 ignore next */
  _R: (_: never) => _
})

/**
 * Prototype used by Effect's request constructors.
 *
 * **Details**
 *
 * This low-level value provides the structural request marker for values
 * created by `Request.of`, `Request.tagged`, `Request.Class`, and
 * `Request.TaggedClass`. Most users should use those constructors instead of
 * interacting with the prototype directly.
 *
 * @category prototypes
 * @since 4.0.0
 */
export const RequestPrototype: Request<any, any, any> = {
  ...core.StructuralProto,
  [TypeId]: requestVariance
}

/**
 * Checks whether a value is a `Request`.
 *
 * **Example** (Checking request values)
 *
 * ```ts
 * import { Request } from "effect"
 *
 * declare const User: unique symbol
 * declare const UserNotFound: unique symbol
 * type User = typeof User
 * type UserNotFound = typeof UserNotFound
 *
 * interface GetUser extends Request.Request<User, UserNotFound> {
 *   readonly _tag: "GetUser"
 *   readonly id: string
 * }
 * const GetUser = Request.tagged<GetUser>("GetUser")
 *
 * const request = GetUser({ id: "123" })
 * console.log(Request.isRequest(request)) // true
 * console.log(Request.isRequest("not a request")) // false
 * ```
 *
 * @category guards
 * @since 2.0.0
 */
export const isRequest = (u: unknown): u is Request<unknown, unknown, unknown> => hasProperty(u, TypeId)

/**
 * Creates a constructor function for a specific Request type.
 *
 * **Example** (Creating untagged request constructors)
 *
 * ```ts
 * import { Request } from "effect"
 *
 * declare const UserProfile: unique symbol
 * declare const ProfileError: unique symbol
 * type UserProfile = typeof UserProfile
 * type ProfileError = typeof ProfileError
 *
 * interface GetUserProfile extends Request.Request<UserProfile, ProfileError> {
 *   readonly id: string
 *   readonly includeSettings: boolean
 * }
 *
 * const GetUserProfile = Request.of<GetUserProfile>()
 *
 * const request = GetUserProfile({
 *   id: "user-123",
 *   includeSettings: true
 * })
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const of = <R extends Request<any, any, any>>(): Constructor<R> => (args) =>
  Object.assign(Object.create(RequestPrototype), args)

/**
 * Creates a constructor function for a tagged Request type. The tag is automatically
 * added to the request, making it useful for discriminated unions.
 *
 * **Example** (Creating tagged request constructors)
 *
 * ```ts
 * import { Request } from "effect"
 *
 * declare const User: unique symbol
 * declare const UserNotFound: unique symbol
 * declare const Post: unique symbol
 * declare const PostNotFound: unique symbol
 * type User = typeof User
 * type UserNotFound = typeof UserNotFound
 * type Post = typeof Post
 * type PostNotFound = typeof PostNotFound
 *
 * interface GetUser extends Request.Request<User, UserNotFound> {
 *   readonly _tag: "GetUser"
 *   readonly id: string
 * }
 *
 * interface GetPost extends Request.Request<Post, PostNotFound> {
 *   readonly _tag: "GetPost"
 *   readonly id: string
 * }
 *
 * const GetUser = Request.tagged<GetUser>("GetUser")
 * const GetPost = Request.tagged<GetPost>("GetPost")
 *
 * const userRequest = GetUser({ id: "user-123" })
 * const postRequest = GetPost({ id: "post-456" })
 *
 * // _tag is automatically set
 * console.log(userRequest._tag) // "GetUser"
 * console.log(postRequest._tag) // "GetPost"
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const tagged = <R extends Request<any, any, any> & { _tag: string }>(
  tag: R["_tag"]
): Constructor<R, "_tag"> =>
(args) => {
  const request = Object.create(RequestPrototype)
  if (args) Object.assign(request, args)
  request._tag = tag
  return request
}

/**
 * Defines request types with TypeScript classes.
 *
 * **Details**
 *
 * Subclasses pass their data fields to `super`, and instances are marked as
 * `Request` values while retaining the provided readonly fields.
 *
 * **Example** (Defining request classes)
 *
 * ```ts
 * import { Request } from "effect"
 *
 * class GetUser extends Request.Class<{ id: number }, string, Error> {
 *   constructor(readonly id: number) {
 *     super({ id })
 *   }
 * }
 *
 * const getUserRequest = new GetUser(123)
 * console.log(getUserRequest.id) // 123
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const Class: new<A extends Record<string, any>, Success, Error = never, Context = never>(
  args: Types.Equals<Omit<A, keyof Request<unknown, unknown>>, {}> extends true ? void
    : { readonly [P in keyof A as P extends keyof Request<any, any, any> ? never : P]: A[P] }
) => Request<Success, Error, Context> & Readonly<A> = (function() {
  function Class(this: any, args: any) {
    if (args) {
      Object.assign(this, args)
    }
  }
  Class.prototype = RequestPrototype
  return Class as any
})()

/**
 * Creates a class constructor for requests with a fixed `_tag` field.
 *
 * **Details**
 *
 * Use this when defining class-based request types that should participate in
 * tagged unions or tag-based request resolvers.
 *
 * **Example** (Defining tagged request classes)
 *
 * ```ts
 * import { Request } from "effect"
 *
 * class GetUserById
 *   extends Request.TaggedClass("GetUserById")<{ id: number }, string, Error>
 * {}
 *
 * const request = new GetUserById({ id: 123 })
 * console.log(request._tag) // "GetUserById"
 * console.log(request.id) // 123
 * ```
 *
 * @category constructors
 * @since 2.0.0
 */
export const TaggedClass = <Tag extends string>(
  tag: Tag
): new<A extends Record<string, any>, Success, Error = never, Services = never>(
  args: Types.Equals<Omit<A, keyof Request<unknown, unknown>>, {}> extends true ? void
    : { readonly [P in keyof A as P extends "_tag" | keyof Request<any, any, any> ? never : P]: A[P] }
) => Request<Success, Error, Services> & Readonly<A> & { readonly _tag: Tag } => {
  return class TaggedClass extends Class<any, any, any> {
    readonly _tag = tag
  } as any
}

/**
 * Completes a request entry with the provided result.
 *
 * **When to use**
 *
 * Use to finish a `Request.Entry` when you already have the request's final
 * `Exit` result.
 *
 * @see {@link completeEffect} for completing an entry from an effect that may succeed or fail
 * @see {@link succeed} for completing an entry with a successful value
 * @see {@link fail} for completing an entry with a typed failure
 * @see {@link failCause} for completing an entry with a failure `Cause`
 *
 * @category completion
 * @since 2.0.0
 */
export const complete: {
  <A extends Any>(result: Result<A>): (self: Entry<A>) => Effect.Effect<void>
  <A extends Any>(self: Entry<A>, result: Result<A>): Effect.Effect<void>
} = dual(
  2,
  <A extends Any>(self: Entry<A>, result: Result<A>): Effect.Effect<void> =>
    internalEffect.sync(() => self.completeUnsafe(result))
)

/**
 * Completes a request entry with the result of an effect.
 *
 * **When to use**
 *
 * Use to finish a `Request.Entry` by running an effect whose success or typed
 * failure should become the request result.
 *
 * **Details**
 *
 * If the effect succeeds, the entry is completed successfully with its value.
 * If the effect fails, the entry is completed with that failure.
 *
 * **Gotchas**
 *
 * The returned effect itself does not fail with the request error.
 *
 * @see {@link complete} for completing an entry with a prebuilt `Exit`
 * @see {@link succeed} for completing an entry with a successful value
 * @see {@link fail} for completing an entry with a typed failure
 * @see {@link failCause} for completing an entry with a failure `Cause`
 *
 * @category completion
 * @since 2.0.0
 */
export const completeEffect: {
  <A extends Any, R>(effect: Effect.Effect<Success<A>, Error<A>, R>): (self: Entry<A>) => Effect.Effect<void, never, R>
  <A extends Any, R>(self: Entry<A>, effect: Effect.Effect<Success<A>, Error<A>, R>): Effect.Effect<void, never, R>
} = dual(
  2,
  <A extends Any, R>(self: Entry<A>, effect: Effect.Effect<Success<A>, Error<A>, R>): Effect.Effect<void, never, R> =>
    internalEffect.matchEffect(effect, {
      onFailure: (error) => complete(self, core.exitFail(error) as any),
      onSuccess: (value) => complete(self, core.exitSucceed(value) as any)
    })
)

/**
 * Completes a request entry with a typed failure.
 *
 * **When to use**
 *
 * Use to report a request-specific typed error while implementing a
 * `RequestResolver`.
 *
 * @see {@link failCause} for completing an entry with a full `Cause`
 * @see {@link complete} for completing an entry with an existing `Exit`
 * @see {@link completeEffect} for completing an entry from an effect result
 * @see {@link succeed} for completing an entry successfully
 *
 * @category completion
 * @since 2.0.0
 */
export const fail: {
  <A extends Any>(error: Error<A>): (self: Entry<A>) => Effect.Effect<void>
  <A extends Any>(self: Entry<A>, error: Error<A>): Effect.Effect<void>
} = dual(
  2,
  <A extends Any>(self: Entry<A>, error: Error<A>): Effect.Effect<void> => complete(self, core.exitFail(error) as any)
)

/**
 * Completes a request entry with a failure `Cause`.
 *
 * **When to use**
 *
 * Use when a `RequestResolver` needs to complete an entry with structured cause
 * information rather than only the request's typed error value.
 *
 * @see {@link fail} for completing an entry with a typed error value
 * @see {@link complete} for completing an entry with an existing `Exit`
 * @see {@link completeEffect} for completing an entry from an effect result
 * @see {@link succeed} for completing an entry successfully
 *
 * @category completion
 * @since 2.0.0
 */
export const failCause: {
  <A extends Any>(cause: Cause.Cause<Error<A>>): (self: Entry<A>) => Effect.Effect<void>
  <A extends Any>(self: Entry<A>, cause: Cause.Cause<Error<A>>): Effect.Effect<void>
} = dual(
  2,
  <A extends Any>(self: Entry<A>, cause: Cause.Cause<Error<A>>): Effect.Effect<void> =>
    complete(self, core.exitFailCause(cause) as any)
)

/**
 * Completes a request entry successfully with the supplied value.
 *
 * **When to use**
 *
 * Use to finish a `Request.Entry` when you have a successful value for the
 * request.
 *
 * @see {@link complete} for completing an entry with a prebuilt `Exit`
 * @see {@link completeEffect} for completing an entry from an effect result
 * @see {@link fail} for completing an entry with a typed failure
 * @see {@link failCause} for completing an entry with a failure `Cause`
 *
 * @category completion
 * @since 2.0.0
 */
export const succeed: {
  <A extends Any>(value: Success<A>): (self: Entry<A>) => Effect.Effect<void>
  <A extends Any>(self: Entry<A>, value: Success<A>): Effect.Effect<void>
} = dual(
  2,
  <A extends Any>(self: Entry<A>, value: Success<A>): Effect.Effect<void> =>
    complete(self, core.exitSucceed(value) as any)
)

/**
 * A pending request handed to a `RequestResolver`.
 *
 * **Details**
 *
 * An entry contains the original request, the fiber context needed to run it,
 * an `uninterruptible` flag used by batching and caching internals, and the
 * `completeUnsafe` callback used by resolvers to supply the final `Exit`.
 *
 * @category entry
 * @since 2.0.0
 */
export interface Entry<out R> {
  readonly request: R
  readonly context: Context.Context<
    [R] extends [Request<infer _A, infer _E, infer _R>] ? _R : never
  >
  uninterruptible: boolean
  completeUnsafe(
    exit: Exit.Exit<
      [R] extends [Request<infer _A, infer _E, infer _R>] ? _A : never,
      [R] extends [Request<infer _A, infer _E, infer _R>] ? _E : never
    >
  ): void
}

/**
 * Creates a `Request.Entry` from its component fields.
 *
 * **Details**
 *
 * This is a low-level helper for request runtime and resolver infrastructure;
 * most application code receives entries from a `RequestResolver` instead of
 * constructing them directly.
 *
 * @category entry
 * @since 2.0.0
 */
export const makeEntry = <R>(options: {
  readonly request: R
  readonly context: Context.Context<
    [R] extends [Request<infer _A, infer _E, infer _R>] ? _R : never
  >
  readonly uninterruptible: boolean
  readonly completeUnsafe: (
    exit: Exit.Exit<
      [R] extends [Request<infer _A, infer _E, infer _R>] ? _A : never,
      [R] extends [Request<infer _A, infer _E, infer _R>] ? _E : never
    >
  ) => void
}): Entry<R> => options
