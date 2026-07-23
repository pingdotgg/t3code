import * as Effect from "../../Effect.ts"
import { flow } from "../../Function.ts"
import * as Pipeable from "../../Pipeable.ts"
import type * as Schema from "../../Schema.ts"
import * as AST from "../../SchemaAST.ts"
import type { Issue } from "../../SchemaIssue.ts"
import * as Parser from "../../SchemaParser.ts"

/** @internal */
export const TypeId = "~effect/Schema/Schema"

const SchemaProto = {
  [TypeId]: TypeId,
  pipe() {
    return Pipeable.pipeArguments(this, arguments)
  },
  annotate(this: Schema.Top, annotations: Schema.Annotations.Annotations) {
    return this.rebuild(AST.annotate(this.ast, annotations))
  },
  annotateKey(this: Schema.Top, annotations: Schema.Annotations.Key<unknown>) {
    return this.rebuild(AST.annotateKey(this.ast, annotations))
  },
  check(this: Schema.Top, ...checks: readonly [AST.Check<unknown>, ...Array<AST.Check<unknown>>]) {
    return this.rebuild(AST.appendChecks(this.ast, checks))
  }
}

/** @internal */
export function make<S extends Schema.Top>(ast: S["ast"], options?: object): S {
  const self = Object.create(SchemaProto)
  if (options) {
    Object.assign(self, options)
  }
  self.ast = ast
  self.rebuild = (ast: AST.AST) => make(ast, options)
  self.makeEffect = flow(Parser.makeEffect(self), Effect.mapErrorEager((issue) => new SchemaError(issue)))
  self.make = Parser.make(self)
  self.makeOption = Parser.makeOption(self)
  return self
}

/** @internal */
export const SchemaErrorTypeId = "~effect/Schema/SchemaError"

// not internal
export class SchemaError {
  readonly [SchemaErrorTypeId] = SchemaErrorTypeId
  readonly _tag = "SchemaError"
  readonly name: string = "SchemaError"
  readonly issue: Issue
  constructor(issue: Issue) {
    this.issue = issue
  }
  get message() {
    return this.issue.toString()
  }
  toString() {
    return `SchemaError(${this.message})`
  }
}

/** @internal */
export const jsonReorder = makeReorder(getJsonPriority)

function getJsonPriority(ast: AST.AST): number {
  switch (ast._tag) {
    case "BigInt":
    case "Symbol":
    case "UniqueSymbol":
      return 0
    default:
      return 1
  }
}

/** @internal */
export function makeReorder(getPriority: (ast: AST.AST) => number) {
  return (types: ReadonlyArray<AST.AST>): ReadonlyArray<AST.AST> => {
    // Create a map of original indices for O(1) lookup
    const indexMap = new Map<AST.AST, number>()
    for (let i = 0; i < types.length; i++) {
      indexMap.set(AST.toEncoded(types[i]), i)
    }

    // Create a sorted copy of the types array
    const sortedTypes = [...types].sort((a, b) => {
      a = AST.toEncoded(a)
      b = AST.toEncoded(b)
      const pa = getPriority(a)
      const pb = getPriority(b)
      if (pa !== pb) return pa - pb
      // If priorities are equal, maintain original order (stable sort)
      return indexMap.get(a)! - indexMap.get(b)!
    })

    // Check if order changed by comparing arrays
    const orderChanged = sortedTypes.some((ast, index) => ast !== types[index])

    if (!orderChanged) return types
    return sortedTypes
  }
}
