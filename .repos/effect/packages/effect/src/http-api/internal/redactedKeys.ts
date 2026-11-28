import type * as Schema from "../../Schema.ts"
import * as SchemaAST from "../../SchemaAST.ts"

/**
 * Returns the wire keys of a params, query or headers schema whose values hold
 * a `Redacted`, or `undefined` when a `Redacted` is present but the wire keys
 * are unknown, so the caller redacts everything.
 *
 * Keys are only known for a struct whose keys are encoded as is.
 *
 * @internal
 */
export const getRedactedKeys = (schema: Schema.Top | undefined): ReadonlyArray<string> | undefined => {
  if (schema === undefined) return []
  const ast = schema.ast
  if (!SchemaAST.isObjects(ast) || ast.encoding !== undefined) return hasRedacted(ast, new Set()) ? undefined : []
  if (ast.indexSignatures.some((is) => hasRedacted(is.type, new Set()))) return undefined
  return ast.propertySignatures.filter((ps) => hasRedacted(ps.type, new Set())).map((ps) => String(ps.name))
}

const hasRedacted = (ast: SchemaAST.AST, seen: Set<SchemaAST.AST>): boolean => {
  const go = (ast: SchemaAST.AST) => hasRedacted(ast, seen)
  switch (ast._tag) {
    case "Declaration":
      return (ast.annotations as Schema.Annotations.Declaration<unknown, readonly []> | undefined)?.representation
            ?.id === "effect/schema/Redacted" || ast.typeParameters.some(go)
    case "Objects":
      return ast.propertySignatures.some((ps) => go(ps.type)) || ast.indexSignatures.some((is) => go(is.type))
    case "Union":
      return ast.types.some(go)
    case "Arrays":
      return ast.elements.some(go) || ast.rest.some(go)
    case "Suspend":
      if (seen.has(ast)) return false
      seen.add(ast)
      return go(ast.thunk())
    default:
      return false
  }
}
