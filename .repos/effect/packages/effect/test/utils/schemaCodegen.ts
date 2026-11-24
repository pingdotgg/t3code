import { assert } from "@effect/vitest"
import { Codegen, type SchemaRepresentation } from "effect"

export function makeModule(document: SchemaRepresentation.MultiDocument): Codegen.Module {
  const module = new Codegen.Module()
  module.addSchemas(
    Object.fromEntries(document.representations.map((representation, i) => ["TestRoot" + i, representation])),
    { references: document.references }
  )
  return module
}

export function declarationNames(module: Codegen.Module): ReadonlyArray<string> {
  const output = module.finalize()
  return output.declarations.map(({ binding }) => output.names.get(binding)!)
}

export function declaration(module: Codegen.Module, name: string): ReadonlyArray<string> {
  const output = module.finalize()
  const entry = output.declarations.find(({ binding }) => output.names.get(binding) === name)
  assert.isDefined(entry, "Missing declaration: " + name)
  return entry!.fragments
}

export function assertSchemas(
  module: Codegen.Module,
  expected: Readonly<Record<string, SchemaRepresentation.Code>>,
  imports: ReadonlyArray<string> = ["import * as Schema from \"effect/Schema\""]
): void {
  const output = module.finalize()
  assert.sameMembers([...output.imports], [...imports])
  assert.deepStrictEqual(
    Object.fromEntries(output.declarations.map(({ binding, fragments }) => [output.names.get(binding)!, fragments])),
    Object.fromEntries(
      Object.entries(expected).map(([name, code]) => [name, [
        `export type ${name} = ${code.Type}`,
        `export const ${name} = ${code.runtime}`
      ]])
    )
  )
}
