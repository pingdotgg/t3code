import * as Predicate from "effect/Predicate"

/** @internal */
export function lookup(document: unknown, tokens: ReadonlyArray<string>): unknown {
  let target = document
  for (const token of tokens) {
    if (!Predicate.isObjectOrArray(target) || !Object.hasOwn(target, token)) return undefined
    if (Array.isArray(target)) {
      const index = Number(token)
      if (!/^(0|[1-9]\d*)$/.test(token) || index >= target.length) return undefined
      target = target[index]
    } else {
      target = target[token]
    }
  }
  return target
}
