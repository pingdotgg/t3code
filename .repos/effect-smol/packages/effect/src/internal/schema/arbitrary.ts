import * as Array from "../../Array.ts"
import * as Boolean from "../../Boolean.ts"
import type * as Combiner from "../../Combiner.ts"
import { memoize } from "../../Function.ts"
import * as Number from "../../Number.ts"
import * as Option from "../../Option.ts"
import * as Predicate from "../../Predicate.ts"
import type * as Schema from "../../Schema.ts"
import * as AST from "../../SchemaAST.ts"
import * as Struct from "../../Struct.ts"
import type * as FastCheck from "../../testing/FastCheck.ts"
import * as UndefinedOr from "../../UndefinedOr.ts"
import { errorWithPath } from "../errors.ts"
import * as InternalAnnotations from "./annotations.ts"

const arbitraryMemoMap = new WeakMap<AST.AST, LazyArbitraryWithContext<any>>()

function applyChecks(ast: AST.AST, filters: Array<AST.Filter<any>>, arbitrary: FastCheck.Arbitrary<any>) {
  return filters.map((filter) => (a: any) => filter.run(a, ast, AST.defaultParseOptions) === undefined).reduce(
    (acc, filter) => acc.filter(filter),
    arbitrary
  )
}

function isUniqueArrayConstraintsCustomCompare(
  constraint: Schema.Annotations.ToArbitrary.ArrayConstraints | undefined
): constraint is Schema.Annotations.ToArbitrary.ArrayConstraints & FastCheck.UniqueArrayConstraintsCustomCompare<any> {
  return constraint?.comparator !== undefined
}

function array(fc: typeof FastCheck, ctx: Schema.Annotations.ToArbitrary.Context, item: FastCheck.Arbitrary<any>) {
  const constraint = ctx.constraints?.array
  const out = isUniqueArrayConstraintsCustomCompare(constraint)
    ? fc.uniqueArray(item, constraint)
    : fc.array(item, constraint)
  if (ctx.isSuspend) {
    return fc.oneof(
      { maxDepth: 2, depthIdentifier: "" },
      fc.constant([]),
      out
    )
  }
  return out
}

const max = UndefinedOr.makeReducer(Number.ReducerMax)
const min = UndefinedOr.makeReducer(Number.ReducerMin)
const or = UndefinedOr.makeReducer(Boolean.ReducerOr)
const concat = UndefinedOr.makeReducer(Array.makeReducerConcat())

const combiner: Combiner.Combiner<any> = Struct.makeCombiner({
  isInteger: or,
  max: min,
  maxExcluded: or,
  maxLength: min,
  min: max,
  minExcluded: or,
  minLength: max,
  noDefaultInfinity: or,
  noInteger: or,
  noInvalidDate: or,
  noNaN: or,
  patterns: concat,
  comparator: or
}, {
  omitKeyWhen: Predicate.isUndefined
})

type FastCheckConstraint =
  | Schema.Annotations.ToArbitrary.StringConstraints
  | Schema.Annotations.ToArbitrary.NumberConstraints
  | Schema.Annotations.ToArbitrary.BigIntConstraints
  | Schema.Annotations.ToArbitrary.ArrayConstraints
  | Schema.Annotations.ToArbitrary.DateConstraints

function merge(
  _tag: "string" | "number" | "bigint" | "array" | "date",
  constraints: Schema.Annotations.ToArbitrary.Constraint,
  constraint: FastCheckConstraint
): Schema.Annotations.ToArbitrary.Constraint {
  const c = constraints[_tag]
  return {
    ...constraints,
    [_tag]: c ? combiner.combine(c, constraint) : constraint
  }
}

const constraintsKeys = {
  string: null,
  number: null,
  bigint: null,
  array: null,
  date: null
}

function isConstraintKey(key: string): key is keyof Schema.Annotations.ToArbitrary.Constraint {
  return key in constraintsKeys
}

/** @internal */
export function constraintContext(
  filters: Array<AST.Filter<any>>
): (ctx: Schema.Annotations.ToArbitrary.Context) => Schema.Annotations.ToArbitrary.Context {
  const annotations = filters.map((filter) => filter.annotations?.toArbitraryConstraint).filter(
    Predicate.isNotUndefined
  )
  return (ctx) => {
    const constraints = annotations.reduce((acc: Schema.Annotations.ToArbitrary.Constraint, c) => {
      const keys = Object.keys(c)
      for (const key of keys) {
        if (isConstraintKey(key)) {
          acc = merge(key, acc, c[key]!)
        }
      }
      return acc
    }, ctx.constraints || {})
    return { ...ctx, constraints }
  }
}

function resetContext(ctx: Schema.Annotations.ToArbitrary.Context): Schema.Annotations.ToArbitrary.Context {
  return { ...ctx, constraints: undefined }
}

function toIntegerConstraints(
  constraint: Schema.Annotations.ToArbitrary.NumberConstraints
): FastCheck.IntegerConstraints {
  const out: FastCheck.IntegerConstraints = {}
  if (constraint.min !== undefined) {
    out.min = constraint.minExcluded ? Math.floor(constraint.min) + 1 : Math.ceil(constraint.min)
  }
  if (constraint.max !== undefined) {
    out.max = constraint.maxExcluded ? Math.ceil(constraint.max) - 1 : Math.floor(constraint.max)
  }
  return out
}

interface LazyArbitraryWithContext<T> {
  (fc: typeof FastCheck, ctx: Schema.Annotations.ToArbitrary.Context): FastCheck.Arbitrary<T>
}

/** @internal */
export function getFilters(checks: AST.Checks | undefined): Array<AST.Filter<any>> {
  if (checks) {
    return checks.flatMap((check) => {
      switch (check._tag) {
        case "Filter":
          return [check]
        case "FilterGroup":
          return getFilters(check.checks)
      }
    })
  }
  return []
}

/** @internal */
export const memoized = memoize((ast: AST.AST): LazyArbitraryWithContext<any> => {
  return recur(ast, [])
})

function recur(ast: AST.AST, path: ReadonlyArray<PropertyKey>): LazyArbitraryWithContext<any> {
  // ---------------------------------------------
  // handle Override annotation
  // ---------------------------------------------
  const annotation = InternalAnnotations.resolve(ast)?.toArbitrary as
    | Schema.Annotations.ToArbitrary.Declaration<any, ReadonlyArray<Schema.Top>>
    | undefined
  if (annotation) {
    const typeParameters = AST.isDeclaration(ast) ? ast.typeParameters.map((tp) => recur(tp, path)) : []
    const filters = getFilters(ast.checks)
    const f = constraintContext(filters)
    return (fc, ctx) =>
      applyChecks(
        ast,
        filters,
        annotation(typeParameters.map((tp) => tp(fc, resetContext(ctx))))(fc, f(ctx))
      )
  }
  if (ast.checks) {
    const filters = getFilters(ast.checks)
    const f = constraintContext(filters)
    const lawc = recur(AST.replaceChecks(ast, undefined), path)
    return (fc, ctx) => applyChecks(ast, filters, lawc(fc, f(ctx)))
  }
  return base(ast, path)
}

function base(ast: AST.AST, path: ReadonlyArray<PropertyKey>): LazyArbitraryWithContext<any> {
  switch (ast._tag) {
    case "Never":
    case "Declaration":
      throw errorWithPath(`Unsupported AST ${ast._tag}`, path)
    case "Null":
      return (fc) => fc.constant(null)
    case "Void":
    case "Undefined":
      return (fc) => fc.constant(undefined)
    case "Unknown":
    case "Any":
      return (fc) => fc.anything()
    case "String":
      return (fc, ctx) => {
        const constraint = ctx.constraints?.string
        const patterns = constraint?.patterns
        if (patterns) {
          return fc.oneof(...patterns.map((pattern) => fc.stringMatching(new RegExp(pattern))))
        }
        return fc.string(constraint)
      }
    case "Number":
      return (fc, ctx) => {
        const constraint = ctx.constraints?.number
        if (constraint?.isInteger) {
          return fc.integer(toIntegerConstraints(constraint))
        }
        return fc.float(constraint)
      }
    case "Boolean":
      return (fc) => fc.boolean()
    case "BigInt":
      return (fc, ctx) => fc.bigInt(ctx.constraints?.bigint ?? {})
    case "Symbol":
      return (fc) => fc.string().map(Symbol.for)
    case "Literal":
      return (fc) => fc.constant(ast.literal)
    case "UniqueSymbol":
      return (fc) => fc.constant(ast.symbol)
    case "ObjectKeyword":
      return (fc) => fc.oneof(fc.object(), fc.array(fc.anything()))
    case "Enum":
      return recur(AST.enumsToLiterals(ast), path)
    case "TemplateLiteral":
      return (fc) => fc.stringMatching(AST.getTemplateLiteralRegExp(ast))
    case "Arrays":
      return (fc, ctx) => {
        const reset = resetContext(ctx)
        // ---------------------------------------------
        // handle elements
        // ---------------------------------------------
        const elements: Array<FastCheck.Arbitrary<Option.Option<any>>> = ast.elements.map((e, i) => {
          const out = recur(e, [...path, i])(fc, reset)
          if (!AST.isOptional(e)) {
            return out.map(Option.some)
          }
          return out.chain((a) => fc.boolean().map((b) => b ? Option.some(a) : Option.none()))
        })
        let out = fc.tuple(...elements).map(Array.getSomes)
        // ---------------------------------------------
        // handle rest element
        // ---------------------------------------------
        if (Array.isReadonlyArrayNonEmpty(ast.rest)) {
          const len = ast.elements.length
          const [head, ...tail] = ast.rest.map((r, i) => recur(r, [...path, len + i])(fc, reset))

          const rest = array(fc, ast.elements.length === 0 ? ctx : reset, head)
          out = out.chain((as) => {
            if (as.length < len) {
              return fc.constant(as)
            }
            return rest.map((rest) => [...as, ...rest])
          })
          // ---------------------------------------------
          // handle post rest elements
          // ---------------------------------------------
          if (tail.length > 0) {
            const t = fc.tuple(...tail)
            out = out.chain((as) => {
              if (as.length < len) {
                return fc.constant(as)
              }
              return t.map((rest) => [...as, ...rest])
            })
          }
        }
        return out
      }
    case "Objects":
      return (fc, ctx) => {
        const reset = resetContext(ctx)
        // ---------------------------------------------
        // handle property signatures
        // ---------------------------------------------
        const pss: any = {}
        const requiredKeys: Array<PropertyKey> = []
        for (const ps of ast.propertySignatures) {
          const name = ps.name
          if (!AST.isOptional(ps.type)) {
            requiredKeys.push(name)
          }
          pss[name] = recur(ps.type, [...path, name])(fc, reset)
        }
        let out = fc.record<any>(pss, { requiredKeys })
        // ---------------------------------------------
        // handle index signatures
        // ---------------------------------------------
        for (const is of ast.indexSignatures) {
          const entry = fc.tuple(recur(is.parameter, path)(fc, reset), recur(is.type, path)(fc, reset))
          const entries = array(fc, ast.propertySignatures.length === 0 ? ctx : reset, entry)
          out = out.chain((o) => {
            return entries.map((entries) => {
              return {
                ...Object.fromEntries(entries),
                ...o
              }
            })
          })
        }
        return out
      }
    case "Union":
      return (fc, ctx) => fc.oneof(...ast.types.map((ast) => recur(ast, path)(fc, ctx)))
    case "Suspend": {
      const memo = arbitraryMemoMap.get(ast)

      if (memo) return memo

      const get = AST.memoizeThunk(() => recur(ast.thunk(), path))
      const out: LazyArbitraryWithContext<any> = (fc, ctx) =>
        fc.constant(null).chain(() => get()(fc, { ...ctx, isSuspend: true }))

      arbitraryMemoMap.set(ast, out)

      return out
    }
  }
}
