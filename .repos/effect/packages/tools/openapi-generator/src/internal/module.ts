/** @internal */
import * as Codegen from "effect/Codegen"

export const namespaceImport = (module: string, local: string, typeOnly = false): Codegen.Import => ({
  module,
  local,
  typeOnly,
  kind: "Namespace",
  imported: "*",
  attributes: ""
})

export const namedImport = (module: string, name: string, typeOnly = false): Codegen.Import => ({
  module,
  local: name,
  typeOnly,
  kind: "Named",
  imported: name,
  attributes: ""
})

export const printImports = (imports: ReadonlyArray<Codegen.Import>): string => {
  const module = new Codegen.Module()
  return module.finalize(imports.map((input) => module.addImport(input))).imports.join("\n")
}
