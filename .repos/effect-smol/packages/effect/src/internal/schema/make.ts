import * as Pipeable from "../../Pipeable.ts"
import type * as Schema from "../../Schema.ts"
import * as SchemaAST from "../../SchemaAST.ts"
import * as SchemaParser from "../../SchemaParser.ts"

/** @internal */
export const TypeId = "~effect/Schema/Schema"

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
  const self = Object.setPrototypeOf(Schema, SchemaProto)
  if (
    options &&
    (Object.hasOwn(options, "name") || Object.hasOwn(options, "length") || Object.hasOwn(options, "__proto__"))
  ) {
    Object.defineProperties(self, Object.getOwnPropertyDescriptors({ ...options }))
  } else {
    Object.assign(self, options)
  }
  self.ast = ast
  self.rebuild = (ast: SchemaAST.AST) => make(ast, options)
  self.makeEffect = SchemaParser.makeEffect(self)
  self.make = SchemaParser.make(self)
  self.makeOption = SchemaParser.makeOption(self)
  return self
}
