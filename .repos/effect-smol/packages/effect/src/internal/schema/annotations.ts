import { memoize } from "../../Function.ts"
import type * as Schema from "../../Schema.ts"
import type * as AST from "../../SchemaAST.ts"

/** @internal */
export function resolve(ast: AST.AST): Schema.Annotations.Annotations | undefined {
  return ast.checks ? ast.checks[ast.checks.length - 1].annotations : ast.annotations
}

/** @internal */
export function resolveAt<A>(key: string) {
  return (ast: AST.AST): A | undefined => resolve(ast)?.[key] as A | undefined
}

/** @internal */
export const resolveIdentifier = resolveAt<string>("identifier")

/** @internal */
export const resolveTitle = resolveAt<string>("title")

/** @internal */
export const resolveDescription = resolveAt<string>("description")

/** @internal */
export const resolveBrands = resolveAt<ReadonlyArray<string>>("brands")

/** @internal */
export const getExpected = memoize((ast: AST.AST): string => {
  const identifier = resolveIdentifier(ast)
  if (typeof identifier === "string") return identifier
  return ast.getExpected(getExpected)
})

/** @internal */
export function collectBrands(annotations: Schema.Annotations.Annotations | undefined): ReadonlyArray<string> {
  return annotations !== undefined && Array.isArray(annotations.brands) ? annotations.brands : []
}
