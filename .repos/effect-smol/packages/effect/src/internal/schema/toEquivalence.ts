import * as Equal from "../../Equal.ts"
import * as Equivalence from "../../Equivalence.ts"
import { memoize } from "../../Function.ts"
import * as Predicate from "../../Predicate.ts"
import type * as Schema from "../../Schema.ts"
import * as SchemaAST from "../../SchemaAST.ts"
import * as SchemaParser from "../../SchemaParser.ts"
import * as InternalAnnotations from "./annotations.ts"

/** @internal */
export const toEquivalence = memoize((ast: SchemaAST.AST): Equivalence.Equivalence<any> => {
  return recur(ast, [])
})

function recur(ast: SchemaAST.AST, path: ReadonlyArray<PropertyKey>): Equivalence.Equivalence<any> {
  // ---------------------------------------------
  // handle annotations
  // ---------------------------------------------
  const annotation = InternalAnnotations.resolve(ast)?.["toEquivalence"] as
    | Schema.Annotations.ToEquivalence.Declaration<any, ReadonlyArray<any>>
    | undefined
  if (annotation) {
    return annotation(SchemaAST.isDeclaration(ast) ? ast.typeParameters.map((tp) => recur(tp, path)) : [])
  }
  switch (ast._tag) {
    case "Never":
      return Equivalence.strictEqual()
    case "Declaration":
    case "Null":
    case "Undefined":
    case "Void":
    case "Unknown":
    case "Any":
    case "String":
    case "Number":
    case "Boolean":
    case "BigInt":
    case "Symbol":
    case "Literal":
    case "UniqueSymbol":
    case "ObjectKeyword":
    case "Enum":
    case "TemplateLiteral":
      return Equal.equals
    case "Arrays": {
      const elements = ast.elements.map((e, i) => recur(e, [...path, i]))
      const len = ast.elements.length
      const rest = ast.rest.map((r, i) => recur(r, [...path, len + i]))
      return Equivalence.make((a, b) => {
        if (!Array.isArray(a) || !Array.isArray(b)) {
          return false
        }
        const len = a.length
        if (len !== b.length) {
          return false
        }
        // ---------------------------------------------
        // handle elements
        // ---------------------------------------------
        let i = 0
        for (; i < Math.min(len, ast.elements.length); i++) {
          if (!elements[i](a[i], b[i])) {
            return false
          }
        }
        // ---------------------------------------------
        // handle rest element
        // ---------------------------------------------
        if (rest.length > 0) {
          const [head, ...tail] = rest
          for (; i < len - tail.length; i++) {
            if (!head(a[i], b[i])) {
              return false
            }
          }
          // ---------------------------------------------
          // handle post rest elements
          // ---------------------------------------------
          for (let j = 0; j < tail.length; j++) {
            if (!tail[j](a[i + j], b[i + j])) {
              return false
            }
          }
        }
        return true
      })
    }
    case "Objects": {
      if (ast.propertySignatures.length === 0 && ast.indexSignatures.length === 0) {
        return Equal.equals
      }
      const propertySignatures = ast.propertySignatures.map((ps) => recur(ps.type, [...path, ps.name]))
      const indexSignatures = ast.indexSignatures.map((is) => recur(is.type, path))
      return Equivalence.make((a, b) => {
        if (!Predicate.isObject(a) || !Predicate.isObject(b)) {
          return false
        }
        // ---------------------------------------------
        // handle property signatures
        // ---------------------------------------------
        for (let i = 0; i < propertySignatures.length; i++) {
          const ps = ast.propertySignatures[i]
          const name = ps.name
          const aHas = Object.hasOwn(a, name)
          const bHas = Object.hasOwn(b, name)
          if (SchemaAST.isOptional(ps.type)) {
            if (aHas !== bHas) {
              return false
            }
          }
          if (aHas && bHas && !propertySignatures[i](a[name], b[name])) {
            return false
          }
        }
        // ---------------------------------------------
        // handle index signatures
        // ---------------------------------------------
        for (let i = 0; i < indexSignatures.length; i++) {
          const is = ast.indexSignatures[i]
          const aKeys = SchemaAST.getIndexSignatureKeys(a, is.parameter)
          const bKeys = SchemaAST.getIndexSignatureKeys(b, is.parameter)

          if (aKeys.length !== bKeys.length) return false

          for (let j = 0; j < aKeys.length; j++) {
            const key = aKeys[j]
            if (!Object.hasOwn(b, key) || !indexSignatures[i](a[key], b[key])) {
              return false
            }
          }
        }
        return true
      })
    }
    case "Union": {
      const types = SchemaAST.toType(ast).types
      const compiled = new Map(
        types.map((candidate, i) =>
          [candidate, [SchemaParser._is(candidate), recur(ast.types[i], path)] as const] as const
        )
      )
      return Equivalence.make((a, b) => {
        const candidates = SchemaAST.getCandidates(a, types)
        for (let i = 0; i < candidates.length; i++) {
          const [is, equivalence] = compiled.get(candidates[i])!
          if (is(a) && is(b)) {
            return equivalence(a, b)
          }
        }
        return false
      })
    }
    case "Suspend": {
      const get = SchemaAST.memoizeThunk(() => recur(ast.thunk(), path))
      return Equivalence.make((a, b) => get()(a, b))
    }
  }
}
