import jsdocs from "./rules/jsdocs.ts"
import noBigIntLiterals from "./rules/no-bigint-literals.ts"
import noImportFromBarrelPackage from "./rules/no-import-from-barrel-package.ts"
import noJsExtensionImports from "./rules/no-js-extension-imports.ts"
import noOpaqueInstanceFields from "./rules/no-opaque-instance-fields.ts"

export default {
  meta: {
    name: "effect"
  },
  rules: {
    "no-bigint-literals": noBigIntLiterals,
    "no-import-from-barrel-package": noImportFromBarrelPackage,
    "no-js-extension-imports": noJsExtensionImports,
    "no-opaque-instance-fields": noOpaqueInstanceFields,
    "jsdocs": jsdocs
  }
}
