import * as Exit from "../../Exit.ts"
import * as Option from "../../Option.ts"
import { args } from "../core.ts"

/** @internal */
export const missing: unique symbol = Symbol.for("effect/schema/parser/missing")

/** @internal */
export { args }

/** @internal */
export type Success<A, E = never> = Exit.Success<A, E> & { readonly [args]: A }

/** @internal */
export const succeed = Exit.succeed as <A>(value: A) => Success<A>

/** @internal */
export const missingExit = succeed(missing)

// Cached success for an unchanged input. The missing symbol also brands the
// result so module copies can recognize it without sharing the Exit object.
// Resolve it before crossing an asynchronous or transformation boundary.
/** @internal */
export const sameExit: Success<unknown> = Object.assign(succeed(missing), { [missing]: true })

/** @internal */
export const isSameExit = (result: object): boolean => (result as { readonly [missing]?: boolean })[missing] === true

/** @internal */
export const toOption = <A>(value: A): Option.Option<A> => value === missing ? Option.none() : Option.some(value as A)

/** @internal */
export const fromOptionExit = <A>(option: Option.Option<A>): Success<A | typeof missing> =>
  option._tag === "None" ? missingExit : succeed(option.value)
