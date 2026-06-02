/**
 * @since 2.0.0
 */

import type { NonEmptyArray } from "../Array.ts"

/** @internal */
export const isArrayNonEmpty = <A>(self: ReadonlyArray<A>): self is NonEmptyArray<A> => self.length > 0
