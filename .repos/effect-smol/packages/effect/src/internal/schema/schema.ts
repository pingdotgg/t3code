import * as Cause from "../../Cause.ts"
import * as Effect from "../../Effect.ts"
import * as Pipeable from "../../Pipeable.ts"
import type * as Schema from "../../Schema.ts"
import * as SchemaAST from "../../SchemaAST.ts"
import { SchemaError } from "../../SchemaError.ts"
import type { Issue } from "../../SchemaIssue.ts"
import * as SchemaParser from "../../SchemaParser.ts"
import type * as SchemaRepresentation from "../../SchemaRepresentation.ts"

/** @internal */
export const TypeId = "~effect/Schema/Schema"

/** @internal */
export function makeDeclarationReviver<P>(
  id: string,
  payloadSchema: Schema.Decoder<P>,
  revive: SchemaRepresentation.DeclarationReviver<P>["revive"]
): SchemaRepresentation.DeclarationReviver<P> {
  return {
    id,
    payloadSchema,
    revive
  }
}

/** @internal */
export function makeFilterReviver<P>(
  id: string,
  payloadSchema: Schema.Decoder<P>,
  revive: SchemaRepresentation.FilterReviver<P>["revive"]
): SchemaRepresentation.FilterReviver<P> {
  return {
    id,
    payloadSchema,
    revive
  }
}

/** @internal */
export function makeFilterGroupReviver<P>(
  id: string,
  payloadSchema: Schema.Decoder<P>,
  revive: SchemaRepresentation.FilterGroupReviver<P>["revive"]
): SchemaRepresentation.FilterGroupReviver<P> {
  return {
    id,
    payloadSchema,
    revive
  }
}

const SchemaProto = {
  [TypeId]: TypeId,
  pipe() {
    return Pipeable.pipeArguments(this, arguments)
  },
  annotate(this: Schema.Top, annotations: Schema.Annotations.Annotations) {
    return this.rebuild(SchemaAST.annotate(this.ast, annotations))
  },
  annotateKey(this: Schema.Top, annotations: Schema.Annotations.Key<unknown>) {
    return this.rebuild(SchemaAST.annotateKey(this.ast, annotations))
  },
  check(this: Schema.Top, ...checks: readonly [SchemaAST.Check<unknown>, ...Array<SchemaAST.Check<unknown>>]) {
    return this.rebuild(SchemaAST.appendChecks(this.ast, checks))
  }
}

/** @internal */
export function make<S extends Schema.Constraint>(ast: S["ast"], options?: object): S {
  function Schema() {}
  const self = Object.defineProperties(
    Object.setPrototypeOf(Schema, SchemaProto),
    Object.getOwnPropertyDescriptors({ ...options })
  )
  self.ast = ast
  self.rebuild = (ast: SchemaAST.AST) => make(ast, options)
  const makeEffect = SchemaParser.makeEffect(self)
  self.makeEffect = (input: S["~type.make.in"], options?: Schema.MakeOptions) =>
    fromIssueEffect(makeEffect(input, options))
  self.make = SchemaParser.make(self)
  self.makeOption = SchemaParser.makeOption(self)
  return self
}

/** @internal */
export function fromIssueEffect<A, R>(
  self: Effect.Effect<A, Issue, R>
): Effect.Effect<A, SchemaError, R> {
  return Effect.catchCause(
    self,
    (cause) => Effect.failCauseSync(() => Cause.map(cause, (issue) => new SchemaError(issue)))
  )
}
