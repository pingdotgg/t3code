import * as Array from "../../Array.ts"
import * as Boolean from "../../Boolean.ts"
import type * as Combiner from "../../Combiner.ts"
import * as Equal from "../../Equal.ts"
import { memoize } from "../../Function.ts"
import * as Number from "../../Number.ts"
import * as Option from "../../Option.ts"
import * as Order from "../../Order.ts"
import * as Predicate from "../../Predicate.ts"
import type * as Schema from "../../Schema.ts"
import * as SchemaAST from "../../SchemaAST.ts"
import * as Struct from "../../Struct.ts"
import type * as FastCheck from "../../testing/FastCheck.ts"
import * as UndefinedOr from "../../UndefinedOr.ts"
import { errorWithPath } from "../errors.ts"
import * as InternalRecord from "../record.ts"
import * as InternalAnnotations from "./annotations.ts"

const arbitraryMemoMap = new WeakMap<SchemaAST.AST, LazyArbitraryWithContext<any>>()
const suspendDepthIdentifierMap = new WeakMap<SchemaAST.Suspend, FastCheck.DepthIdentifier>()
const emptyRecursionStack: RecursionStack = []

type RecursionStack = ReadonlyArray<SchemaAST.Suspend>

type Context = Schema.Annotations.ToArbitrary.Context
type Constraint = Schema.Annotations.ToArbitrary.GenerationConstraint
type OrderedConstraint = Schema.Annotations.ToArbitrary.OrderedConstraint<any>
type ArbitraryFilter = Schema.Annotations.ToArbitrary.Filter

type Lazy<T> = (fc: typeof FastCheck, ctx: Context, recursionStack: RecursionStack) => FastCheck.Arbitrary<T>
type LazyOption<T> = (
  fc: typeof FastCheck,
  ctx: Context,
  recursionStack: RecursionStack
) => FastCheck.Arbitrary<T> | undefined

function arbitraryError(what: string) {
  return new Error(`Unable to derive an arbitrary for ${what}`)
}

const entryComparator = ([a]: readonly [any, any], [b]: readonly [any, any]) => Equal.equals(a, b)

function applyChecks(ast: SchemaAST.AST, filters: Array<SchemaAST.Filter<any>>, arbitrary: FastCheck.Arbitrary<any>) {
  return filters.reduce(
    (acc, filter) => acc.filter((a) => filter.run(a, ast, SchemaAST.defaultParseOptions) === undefined),
    arbitrary
  )
}

function validateArrayConstraints(constraint: FastCheck.ArrayConstraints | undefined, label: string) {
  if (
    constraint?.minLength !== undefined && constraint.maxLength !== undefined &&
    constraint.minLength > constraint.maxLength
  ) {
    throw arbitraryError(`${label} constraints`)
  }
}

function lengthToFastCheckConstraints(
  constraint: { readonly minLength?: number | undefined; readonly maxLength?: number | undefined } | undefined
) {
  return constraint === undefined || (constraint.minLength === undefined && constraint.maxLength === undefined)
    ? undefined
    : {
      ...(constraint.minLength !== undefined ? { minLength: constraint.minLength } : {}),
      ...(constraint.maxLength !== undefined ? { maxLength: constraint.maxLength } : {})
    }
}

function arrayWithConstraints(
  fc: typeof FastCheck,
  item: FastCheck.Arbitrary<any>,
  constraint: FastCheck.ArrayConstraints | undefined,
  comparator?: ((a: any, b: any) => boolean) | undefined
) {
  return comparator
    ? fc.uniqueArray(item, { ...constraint, comparator })
    : fc.array(item, constraint)
}

function array(fc: typeof FastCheck, ctx: Context, item: FastCheck.Arbitrary<any>, terminal = false) {
  const constraint = ctx.constraint
  const arrayConstraints = lengthToFastCheckConstraints(constraint)
  validateArrayConstraints(arrayConstraints, "array")
  return arrayWithConstraints(
    fc,
    item,
    terminal ? { ...arrayConstraints, maxLength: arrayConstraints?.minLength ?? 0 } : arrayConstraints,
    constraint?.unique ? Equal.equals : undefined
  )
}

function appendArray(
  fc: typeof FastCheck,
  out: FastCheck.Arbitrary<Array<any>>,
  len: number,
  rest: FastCheck.Arbitrary<ReadonlyArray<any>>
) {
  return out.chain((as) => as.length < len ? fc.constant(as) : rest.map((rest) => [...as, ...rest]))
}

function appendObjectEntries(
  out: FastCheck.Arbitrary<any>,
  entries: FastCheck.Arbitrary<Array<readonly [PropertyKey, any]>>
) {
  return out.chain((o) => entries.map((entries) => ({ ...Object.fromEntries(entries), ...o })))
}

const max = UndefinedOr.makeReducer(Number.ReducerMax)
const min = UndefinedOr.makeReducer(Number.ReducerMin)
const or = UndefinedOr.makeReducer(Boolean.ReducerOr)
const concat = UndefinedOr.makeReducer(Array.makeReducerConcat())

const combiner: Combiner.Combiner<any> = Struct.makeCombiner({
  integer: or,
  maxLength: min,
  minLength: max,
  noInfinity: or,
  noNaN: or,
  patterns: concat,
  unique: or
}, {
  omitKeyWhen: Predicate.isUndefined
})

function mergeOrderedBound<T>(
  order: Order.Order<T>,
  self: T | undefined,
  selfExclusive: boolean | undefined,
  that: T | undefined,
  thatExclusive: boolean | undefined,
  takeComparison: -1 | 1
): readonly [T | undefined, boolean | undefined] {
  if (that === undefined || self === undefined) {
    return that === undefined ? [self, selfExclusive] : [that, thatExclusive]
  }
  const comparison = order(self, that)
  return comparison === takeComparison
    ? [that, thatExclusive]
    : comparison === 0
    ? [self, selfExclusive || thatExclusive]
    : [self, selfExclusive]
}

function mergeOrderedConstraints(self: OrderedConstraint | undefined, that: OrderedConstraint) {
  if (self === undefined) {
    return that
  }
  if (self.order !== that.order) {
    throw new Error("Cannot merge ordered arbitrary constraints with different Order instances")
  }

  const [minimum, exclusiveMinimum] = mergeOrderedBound(
    self.order,
    self.minimum,
    self.exclusiveMinimum,
    that.minimum,
    that.exclusiveMinimum,
    -1
  )
  const [maximum, exclusiveMaximum] = mergeOrderedBound(
    self.order,
    self.maximum,
    self.exclusiveMaximum,
    that.maximum,
    that.exclusiveMaximum,
    1
  )

  return {
    order: self.order,
    ...(minimum !== undefined ? { minimum } : {}),
    ...(exclusiveMinimum !== undefined ? { exclusiveMinimum } : {}),
    ...(maximum !== undefined ? { maximum } : {}),
    ...(exclusiveMaximum !== undefined ? { exclusiveMaximum } : {})
  }
}

function mergeConstraint(self: Constraint | undefined, that: Constraint): Constraint {
  const { ordered: selfOrdered, ...selfRest } = self ?? {}
  const { ordered: thatOrdered, ...thatRest } = that
  const ordered = thatOrdered === undefined
    ? selfOrdered
    : mergeOrderedConstraints(selfOrdered, thatOrdered)
  const out = combiner.combine(selfRest, thatRest)
  return {
    ...out,
    ...(ordered === undefined ? {} : { ordered })
  }
}

function collectChecks(checks: SchemaAST.Checks | undefined) {
  const filters: Array<SchemaAST.Filter<any>> = []
  const arbitraries: Array<ArbitraryFilter> = []
  function visit(check: SchemaAST.Check<any>) {
    if (check.annotations?.arbitrary) {
      arbitraries.push(check.annotations.arbitrary)
    }
    if (check._tag !== "Filter") {
      for (const child of check.checks) {
        visit(child)
      }
    } else {
      filters.push(check)
    }
  }
  checks?.forEach(visit)
  return { filters, arbitraries }
}

function constraintContext(arbitraries: Array<ArbitraryFilter>): (ctx: Context) => Context {
  const constraintAnnotations = arbitraries.map(({ constraint }) => constraint).filter(Predicate.isNotUndefined)
  return (ctx) => {
    const constraint = constraintAnnotations.reduce(
      (acc: Constraint | undefined, c) => mergeConstraint(acc, c),
      ctx.constraint
    )
    return { ...ctx, constraint }
  }
}

function resetContext(ctx: Context) {
  return { ...ctx, constraint: undefined }
}

function objectEntriesConstraints(ast: SchemaAST.Objects, constraint: Constraint | undefined, requiredKeys: number) {
  if (constraint === undefined || (constraint.minLength === undefined && constraint.maxLength === undefined)) {
    return undefined
  }
  if (
    constraint.minLength !== undefined &&
    ast.indexSignatures.length === 0 &&
    constraint.minLength > ast.propertySignatures.length
  ) {
    throw arbitraryError("object property constraints")
  }
  const out: FastCheck.ArrayConstraints = {}
  if (constraint.minLength !== undefined) {
    out.minLength = Math.max(0, constraint.minLength - requiredKeys)
  }
  if (constraint.maxLength !== undefined) {
    out.maxLength = constraint.maxLength - requiredKeys
    if (out.maxLength < 0) {
      throw arbitraryError("object property constraints")
    }
  }
  validateArrayConstraints(out, "object property")
  return out
}

function objectWithOptionalCount(
  fc: typeof FastCheck,
  pss: Record<PropertyKey, FastCheck.Arbitrary<any>>,
  orderedNames: ReadonlyArray<PropertyKey>,
  requiredKeys: ReadonlyArray<PropertyKey>,
  optionalNames: ReadonlyArray<PropertyKey>,
  constraint: Constraint
) {
  const requiredCount = requiredKeys.length
  if (constraint.maxLength !== undefined && constraint.maxLength < requiredCount) {
    throw arbitraryError("object property constraints")
  }
  const minOptional = constraint.minLength === undefined ? 0 : Math.max(0, constraint.minLength - requiredCount)
  const maxOptional = constraint.maxLength === undefined
    ? optionalNames.length
    : Math.min(optionalNames.length, constraint.maxLength - requiredCount)
  if (minOptional > maxOptional) {
    throw arbitraryError("object property constraints")
  }
  const full = fc.record<any>(pss, { requiredKeys: [...requiredKeys, ...optionalNames] })
  const chosen = fc.shuffledSubarray([...optionalNames], { minLength: minOptional, maxLength: maxOptional })
  return fc.tuple(full, chosen).map(([base, names]) => {
    const keep = new Set<PropertyKey>([...requiredKeys, ...names])
    const out: Record<PropertyKey, any> = {}
    for (const name of orderedNames) {
      if (keep.has(name)) {
        InternalRecord.assignProperty(out, name, base[name])
      }
    }
    return out
  })
}

function toRangeConstraints<T extends number | bigint>(
  ordered: OrderedConstraint | undefined,
  min: (value: T, excluded: boolean) => T,
  max: (value: T, excluded: boolean) => T,
  error: string
) {
  const out: { min?: T; max?: T } = {}
  if (ordered?.minimum !== undefined) {
    out.min = min(ordered.minimum as T, ordered.exclusiveMinimum === true)
  }
  if (ordered?.maximum !== undefined) {
    out.max = max(ordered.maximum as T, ordered.exclusiveMaximum === true)
  }
  if (out.min !== undefined && out.max !== undefined && out.min > out.max) {
    throw arbitraryError(error)
  }
  return out
}

function toIntegerConstraints(ordered: OrderedConstraint | undefined) {
  return toRangeConstraints<number>(
    ordered,
    (minimum, excluded) => excluded ? Math.floor(minimum) + 1 : Math.ceil(minimum),
    (maximum, excluded) => excluded ? Math.ceil(maximum) - 1 : Math.floor(maximum),
    "integer constraints"
  )
}

function toFloatConstraints(constraint: Constraint | undefined, ordered: OrderedConstraint | undefined) {
  const out: FastCheck.FloatConstraints = {
    ...(constraint?.noInfinity ? { noDefaultInfinity: true } : {}),
    ...(constraint?.noNaN ? { noNaN: true } : {}),
    ...(ordered?.minimum !== undefined ? { min: ordered.minimum as number } : {}),
    ...(ordered?.exclusiveMinimum !== undefined ? { minExcluded: ordered.exclusiveMinimum } : {}),
    ...(ordered?.maximum !== undefined ? { max: ordered.maximum as number } : {}),
    ...(ordered?.exclusiveMaximum !== undefined ? { maxExcluded: ordered.exclusiveMaximum } : {})
  }
  if (
    out.min !== undefined &&
    out.max !== undefined &&
    (out.min > out.max || (out.min === out.max && (out.minExcluded || out.maxExcluded)))
  ) {
    throw arbitraryError("number constraints")
  }
  return out
}

function toBigIntConstraints(ordered: OrderedConstraint | undefined) {
  return toRangeConstraints<bigint>(
    ordered,
    (minimum, excluded) => excluded ? minimum + BigInt(1) : minimum,
    (maximum, excluded) => excluded ? maximum - BigInt(1) : maximum,
    "the ordered bigint constraints"
  )
}

interface LazyArbitraryWithContext<T> {
  (fc: typeof FastCheck, ctx: Context, recursionStack?: RecursionStack): FastCheck.Arbitrary<T>
  readonly terminal: (
    fc: typeof FastCheck,
    ctx: Context,
    recursionStack?: RecursionStack
  ) => FastCheck.Arbitrary<T> | undefined
}

function makeLazy<T>(normal: Lazy<T>, terminal: LazyOption<T>): LazyArbitraryWithContext<T> {
  const out =
    ((fc, ctx, recursionStack = emptyRecursionStack) => normal(fc, ctx, recursionStack)) as LazyArbitraryWithContext<T>
  ;(out as { terminal: LazyOption<T> }).terminal = (fc, ctx, recursionStack = emptyRecursionStack) =>
    terminal(fc, ctx, recursionStack)
  return out
}

function same<T>(f: Lazy<T>) {
  return makeLazy(f, f)
}

function getSuspendRecursion(fc: typeof FastCheck, ast: SchemaAST.Suspend) {
  const depthIdentifier = suspendDepthIdentifierMap.get(ast) ?? fc.createDepthIdentifier()
  suspendDepthIdentifierMap.set(ast, depthIdentifier)
  return { maxDepth: 2, depthIdentifier }
}

function oneOf<T>(fc: typeof FastCheck, arbitraries: ReadonlyArray<FastCheck.Arbitrary<T>>) {
  return arbitraries.length === 0 ? undefined : arbitraries.length === 1 ? arbitraries[0] : fc.oneof(...arbitraries)
}

const finiteNumberConstraint: Constraint = {
  noInfinity: true,
  noNaN: true
}

function finiteNumberContext(ctx: Context): Context {
  return {
    ...ctx,
    constraint: finiteNumberConstraint
  }
}

function applyCandidates(
  fc: typeof FastCheck,
  ctx: Context,
  arbitraries: Array<ArbitraryFilter>,
  base: FastCheck.Arbitrary<any> | undefined
) {
  const weighted: Array<FastCheck.WeightedArbitrary<any>> = base === undefined
    ? []
    : [{ arbitrary: base, weight: 1 }]
  for (const { candidate } of arbitraries) {
    if (!candidate) {
      continue
    }
    const arbitrary = candidate.make(fc, ctx)
    if (arbitrary === undefined) {
      continue
    }
    const weight = candidate.weight ?? 1
    if (!globalThis.Number.isInteger(weight) || weight <= 0) {
      throw arbitraryError("a candidate with an invalid weight")
    }
    weighted.push({ arbitrary, weight })
  }
  return weighted.length === 0 ? undefined : weighted.length === 1 ? weighted[0].arbitrary : fc.oneof(...weighted)
}

function applyFilterLayer(
  ast: SchemaAST.AST,
  checks: ReturnType<typeof collectChecks>,
  fc: typeof FastCheck,
  ctx: Context,
  base: FastCheck.Arbitrary<any> | undefined
) {
  const out = applyCandidates(fc, ctx, checks.arbitraries, base)
  return out === undefined ? undefined : applyChecks(ast, checks.filters, out)
}

function normalizeDerivation<T>(
  output: Schema.Annotations.ToArbitrary.Output<T>,
  hasTypeParameters: boolean
) {
  if (!(typeof output === "object" && output !== null && "arbitrary" in output)) {
    return { arbitrary: output, terminal: hasTypeParameters ? undefined : output }
  }
  const terminal = "terminal" in output ? output.terminal : hasTypeParameters ? undefined : output.arbitrary
  return {
    arbitrary: output.arbitrary,
    terminal
  }
}

function makeTypeParameters(
  typeParameters: ReadonlyArray<LazyArbitraryWithContext<any>>,
  fc: typeof FastCheck,
  ctx: Context,
  recursionStack: RecursionStack,
  lazyNormal: boolean
) {
  return typeParameters.map((tp) => ({
    arbitrary: lazyNormal ? fc.constant(null).chain(() => tp(fc, ctx, recursionStack)) : tp(fc, ctx, recursionStack),
    terminal: tp.terminal(fc, ctx, recursionStack)
  }))
}

type BaseBuilder = (
  fc: typeof FastCheck,
  ctx: Context,
  nextCtx: Context,
  recursionStack: RecursionStack
) => FastCheck.Arbitrary<any> | undefined

function filterLayer(
  ast: SchemaAST.AST,
  checks: ReturnType<typeof collectChecks>,
  normalBase: BaseBuilder,
  terminalBase: BaseBuilder
): LazyArbitraryWithContext<any> {
  const f = constraintContext(checks.arbitraries)
  return makeLazy((fc, ctx, recursionStack) => {
    const nextCtx = f(ctx)
    return applyFilterLayer(ast, checks, fc, nextCtx, normalBase(fc, ctx, nextCtx, recursionStack))!
  }, (fc, ctx, recursionStack) => {
    const nextCtx = f(ctx)
    return applyFilterLayer(ast, checks, fc, nextCtx, terminalBase(fc, ctx, nextCtx, recursionStack))
  })
}

/** @internal */
export const memoized = memoize((ast: SchemaAST.AST) => recur(ast, []))

function recur(ast: SchemaAST.AST, path: ReadonlyArray<PropertyKey>): LazyArbitraryWithContext<any> {
  // ---------------------------------------------
  // handle annotations
  // ---------------------------------------------
  const annotation = InternalAnnotations.resolve(ast)?.toArbitrary as
    | Schema.Annotations.ToArbitrary.Declaration<any, ReadonlyArray<Schema.Top>>
    | undefined
  if (annotation) {
    const typeParameters = SchemaAST.isDeclaration(ast) ? ast.typeParameters.map((tp) => recur(tp, path)) : []
    const checks = collectChecks(ast.checks)
    const derive = (lazyNormal: boolean): BaseBuilder => (fc, ctx, nextCtx, recursionStack) =>
      normalizeDerivation(
        annotation(makeTypeParameters(typeParameters, fc, resetContext(ctx), recursionStack, lazyNormal))(fc, nextCtx),
        typeParameters.length > 0
      )[lazyNormal ? "terminal" : "arbitrary"]
    return filterLayer(ast, checks, derive(false), derive(true))
  }
  if (ast.checks) {
    const checks = collectChecks(ast.checks)
    const lawc = recur(SchemaAST.replaceChecks(ast, undefined), path)
    return filterLayer(
      ast,
      checks,
      (fc, _ctx, nextCtx, recursionStack) => lawc(fc, nextCtx, recursionStack),
      (fc, _ctx, nextCtx, recursionStack) => lawc.terminal(fc, nextCtx, recursionStack)
    )
  }
  return base(ast, path)
}

function base(ast: SchemaAST.AST, path: ReadonlyArray<PropertyKey>): LazyArbitraryWithContext<any> {
  switch (ast._tag) {
    case "Never":
    case "Declaration":
      throw errorWithPath(`Unsupported AST ${ast._tag}`, path)
    case "Null":
      return same((fc) => fc.constant(null))
    case "Void":
    case "Undefined":
      return same((fc) => fc.constant(undefined))
    case "Unknown":
    case "Any":
      return same((fc) => fc.anything())
    case "String":
      return same((fc, ctx) => {
        const constraint = ctx.constraint
        const patterns = constraint?.patterns
        return patterns
          ? fc.oneof(...patterns.map((pattern) => fc.stringMatching(new RegExp(pattern))))
          : fc.string(lengthToFastCheckConstraints(constraint))
      })
    case "Number":
      return same((fc, ctx) => {
        const constraint = ctx.constraint
        const ordered = constraint?.ordered?.order === Order.Number ? constraint.ordered : undefined
        return constraint?.integer
          ? fc.integer(toIntegerConstraints(ordered))
          : fc.float(toFloatConstraints(constraint, ordered))
      })
    case "Boolean":
      return same((fc) => fc.boolean())
    case "BigInt":
      return same((fc, ctx) => {
        const ordered = ctx.constraint?.ordered?.order === Order.BigInt ? ctx.constraint.ordered : undefined
        return fc.bigInt(toBigIntConstraints(ordered))
      })
    case "Symbol":
      return same((fc) => fc.string().map(Symbol.for))
    case "Literal":
      return same((fc) => fc.constant(ast.literal))
    case "UniqueSymbol":
      return same((fc) => fc.constant(ast.symbol))
    case "ObjectKeyword":
      return same((fc) => fc.oneof(fc.object(), fc.array(fc.anything())))
    case "Enum":
      return recur(SchemaAST.enumsToLiterals(ast), path)
    case "TemplateLiteral": {
      const parts = ast.parts.map((part, i) => recur(SchemaAST.toEncoded(part), [...path, i]))
      return same((fc, ctx, recursionStack) =>
        fc.tuple(...parts.map((part) => part(fc, finiteNumberContext(ctx), recursionStack))).map((segments) =>
          segments.map((segment) => globalThis.String(segment)).join("")
        )
      )
    }
    case "Arrays": {
      const elements = ast.elements.map((ast, i) => ({
        ast,
        arbitrary: recur(ast, [...path, i])
      }))
      const len = ast.elements.length
      const rest = ast.rest.map((ast, i) => ({
        ast,
        arbitrary: recur(ast, [...path, len + i])
      }))
      const terminal: LazyOption<any> = (fc, ctx, recursionStack) => {
        const reset = resetContext(ctx)
        const elementArbitraries: Array<FastCheck.Arbitrary<Option.Option<any>>> = []
        const optionals: Array<FastCheck.Arbitrary<any> | undefined> = []
        let length = 0
        for (const element of elements) {
          const out = element.arbitrary.terminal(fc, reset, recursionStack)
          if (SchemaAST.isOptional(element.ast)) {
            optionals.push(out)
            continue
          }
          if (out === undefined) {
            return undefined
          }
          length++
          elementArbitraries.push(out.map(Option.some))
        }
        const minLength = ctx.constraint?.minLength ?? 0
        const needsRest = Array.isReadonlyArrayNonEmpty(rest) && minLength > length + optionals.length
        const optionalTarget = needsRest ? optionals.length : Math.max(0, minLength - length)
        let includedOptionals = 0
        for (const out of optionals) {
          if (includedOptionals >= optionalTarget || out === undefined) {
            elementArbitraries.push(fc.constant(Option.none()))
            continue
          }
          includedOptionals++
          length++
          elementArbitraries.push(out.map(Option.some))
        }
        if (includedOptionals < optionalTarget) {
          return undefined
        }
        let out = fc.tuple(...elementArbitraries).map(Array.getSomes)
        if (Array.isReadonlyArrayNonEmpty(rest)) {
          const [head, ...tail] = rest
          const restCtx = ast.elements.length === 0 ? ctx : reset
          const minRestLength = Math.max(0, minLength - length - tail.length)
          const headArbitrary = minRestLength === 0
            ? undefined
            : head.arbitrary.terminal(fc, reset, recursionStack)
          if (minRestLength > 0 && headArbitrary === undefined) {
            return undefined
          }
          const restArbitrary = minRestLength === 0
            ? fc.constant([])
            : array(
              fc,
              { ...restCtx, constraint: { ...restCtx.constraint, minLength: minRestLength } },
              headArbitrary!,
              true
            )
          out = appendArray(fc, out, len, restArbitrary)
          if (tail.length > 0) {
            const tailArbitraries: Array<FastCheck.Arbitrary<any>> = []
            for (const element of tail) {
              const out = element.arbitrary.terminal(fc, reset, recursionStack)
              if (out === undefined) {
                return undefined
              }
              tailArbitraries.push(out)
            }
            const t = fc.tuple(...tailArbitraries)
            out = appendArray(fc, out, len, t)
          }
        }
        return out
      }
      return makeLazy((fc, ctx, recursionStack) => {
        const reset = resetContext(ctx)
        // ---------------------------------------------
        // handle elements
        // ---------------------------------------------
        const elementArbitraries: Array<FastCheck.Arbitrary<Option.Option<any>>> = elements.map(
          ({ ast, arbitrary }) => {
            const out = arbitrary(fc, reset, recursionStack)
            return SchemaAST.isOptional(ast)
              ? out.chain((a) => fc.boolean().map((b) => b ? Option.some(a) : Option.none()))
              : out.map(Option.some)
          }
        )
        let out = fc.tuple(...elementArbitraries).map((elements) =>
          Array.getSomes(Array.takeWhile(elements, Option.isSome))
        )
        // ---------------------------------------------
        // handle rest element
        // ---------------------------------------------
        if (Array.isReadonlyArrayNonEmpty(rest)) {
          const [head, ...tail] = rest.map(({ arbitrary }) => arbitrary(fc, reset, recursionStack))

          const restArbitrary = array(fc, ast.elements.length === 0 ? ctx : reset, head)
          out = appendArray(fc, out, len, restArbitrary)
          // ---------------------------------------------
          // handle post rest elements
          // ---------------------------------------------
          if (tail.length > 0) {
            const t = fc.tuple(...tail)
            out = appendArray(fc, out, len, t)
          }
        }
        if (ctx.recursion) {
          const terminalOut = terminal(fc, ctx, recursionStack)
          if (terminalOut !== undefined) {
            return fc.oneof(ctx.recursion, terminalOut, out)
          }
        }
        return out
      }, terminal)
    }
    case "Objects": {
      const propertySignatures = ast.propertySignatures.map((ps) => ({
        ps,
        arbitrary: recur(ps.type, [...path, ps.name])
      }))
      const indexSignatures = ast.indexSignatures.map((is) => ({
        is,
        parameter: recur(is.parameter, path),
        type: recur(is.type, path)
      }))
      const terminal: LazyOption<any> = (fc, ctx, recursionStack) => {
        const reset = resetContext(ctx)
        const pss: any = {}
        const requiredKeys: Array<PropertyKey> = []
        const optionals: Array<readonly [PropertyKey, FastCheck.Arbitrary<any>]> = []
        for (const { ps, arbitrary } of propertySignatures) {
          const name = ps.name
          const out = arbitrary.terminal(fc, reset, recursionStack)
          if (SchemaAST.isOptional(ps.type)) {
            if (out !== undefined) {
              optionals.push([name, out])
            }
            continue
          }
          if (out === undefined) {
            return undefined
          }
          requiredKeys.push(name)
          InternalRecord.assignProperty(pss, name, out)
        }
        let optionalCount = Math.max(0, (ctx.constraint?.minLength ?? 0) - requiredKeys.length)
        for (const [name, out] of optionals) {
          if (optionalCount === 0) {
            break
          }
          optionalCount--
          requiredKeys.push(name)
          InternalRecord.assignProperty(pss, name, out)
        }
        if (optionalCount > 0 && ast.indexSignatures.length === 0) {
          return undefined
        }
        let out = fc.record<any>(pss, { requiredKeys })
        const entriesConstraints = objectEntriesConstraints(ast, ctx.constraint, requiredKeys.length)
        const minEntries = entriesConstraints?.minLength ?? 0
        for (const { parameter, type } of indexSignatures) {
          let entries: FastCheck.Arbitrary<Array<readonly [PropertyKey, any]>>
          if (minEntries === 0) {
            entries = fc.constant([])
          } else {
            const key = parameter.terminal(fc, reset, recursionStack)
            const value = type.terminal(fc, reset, recursionStack)
            if (key === undefined || value === undefined) {
              return undefined
            }
            entries = arrayWithConstraints(
              fc,
              fc.tuple(key, value),
              { ...entriesConstraints, maxLength: minEntries },
              entryComparator
            )
          }
          out = appendObjectEntries(out, entries)
        }
        return out
      }
      return makeLazy((fc, ctx, recursionStack) => {
        const reset = resetContext(ctx)
        // ---------------------------------------------
        // handle property signatures
        // ---------------------------------------------
        const pss: any = {}
        const orderedNames: Array<PropertyKey> = []
        const requiredKeys: Array<PropertyKey> = []
        const optionalNames: Array<PropertyKey> = []
        for (const { ps, arbitrary } of propertySignatures) {
          const name = ps.name
          orderedNames.push(name)
          if (SchemaAST.isOptional(ps.type)) {
            optionalNames.push(name)
          } else {
            requiredKeys.push(name)
          }
          InternalRecord.assignProperty(pss, name, arbitrary(fc, reset, recursionStack))
        }
        // When property-count constraints must be satisfied by selecting
        // optional keys (no index signatures are available to fill the gap),
        // generate a count-controlled subset of optional keys instead of
        // relying on fast-check's independent inclusion plus discards. This
        // enforces both bounds precisely while still varying which optionals
        // appear.
        const constraint = ctx.constraint
        if (
          optionalNames.length > 0 &&
          indexSignatures.length === 0 &&
          constraint !== undefined &&
          (constraint.minLength !== undefined || constraint.maxLength !== undefined)
        ) {
          return objectWithOptionalCount(fc, pss, orderedNames, requiredKeys, optionalNames, constraint)
        }
        let out = fc.record<any>(pss, { requiredKeys })
        const entriesConstraints = objectEntriesConstraints(ast, ctx.constraint, requiredKeys.length)
        // ---------------------------------------------
        // handle index signatures
        // ---------------------------------------------
        for (const { parameter, type } of indexSignatures) {
          const entry = fc.tuple(parameter(fc, reset, recursionStack), type(fc, reset, recursionStack))
          const entries = arrayWithConstraints(fc, entry, entriesConstraints, entryComparator)
          out = appendObjectEntries(out, entries)
        }
        return out
      }, terminal)
    }
    case "Union": {
      const types = ast.types.map((ast) => recur(ast, path))
      const terminal: LazyOption<any> = (fc, ctx, recursionStack) =>
        oneOf(fc, types.map((type) => type.terminal(fc, ctx, recursionStack)).filter(Predicate.isNotUndefined))
      return makeLazy((fc, ctx, recursionStack) => {
        const arbitraries = types.map((type) => type(fc, ctx, recursionStack))
        if (ctx.recursion) {
          const terminalOut = terminal(fc, ctx, recursionStack)
          if (terminalOut !== undefined) {
            return fc.oneof(ctx.recursion, terminalOut, ...arbitraries)
          }
        }
        const out = oneOf(fc, arbitraries)
        if (out === undefined) {
          throw arbitraryError("a union with no members")
        }
        return out
      }, terminal)
    }
    case "Suspend": {
      const memo = arbitraryMemoMap.get(ast)

      if (memo) return memo

      const get = SchemaAST.memoizeThunk(() => recur(ast.thunk(), path))
      const out = makeLazy((fc, ctx, recursionStack) => {
        const recursion = getSuspendRecursion(fc, ast)
        const nextCtx = { ...ctx, recursion }
        const nextStack = recursionStack.includes(ast) ? recursionStack : [...recursionStack, ast]
        const terminal = get().terminal(fc, nextCtx, nextStack)
        if (terminal === undefined) {
          throw errorWithPath(
            "Unable to derive an arbitrary for a recursive schema without a finite generation path",
            path
          )
        }
        return fc.oneof(
          recursion,
          terminal,
          fc.constant(null).chain(() => get()(fc, nextCtx, nextStack))
        )
      }, (fc, ctx, recursionStack) => {
        if (recursionStack.includes(ast)) {
          return undefined
        }
        const recursion = getSuspendRecursion(fc, ast)
        return get().terminal(fc, { ...ctx, recursion }, [...recursionStack, ast])
      })

      arbitraryMemoMap.set(ast, out)

      return out
    }
  }
}
