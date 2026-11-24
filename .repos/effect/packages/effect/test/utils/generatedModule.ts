import { execFile } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { transformWithOxc } from "vite"

const moduleDirectory = dirname(fileURLToPath(import.meta.url))

export async function withGeneratedModule<Module>(
  source: string,
  use: (module: Module) => void | Promise<void>
): Promise<void> {
  const directory = mkdtempSync(join(moduleDirectory, ".generated-module-"))
  try {
    const file = join(directory, "module.mjs")
    // Transpile only: enum artifacts need more than Node's type stripping.
    const { code } = await transformWithOxc(source, "module.ts", {
      typescript: { onlyRemoveTypeImports: true },
      sourcemap: false
    })
    writeFileSync(file, code)
    const module: Module = await import(pathToFileURL(file).href)
    await use(module)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Check all generated modules in one compiler invocation. */
export async function checkGeneratedModules(sources: ReadonlyMap<string, string>): Promise<void> {
  const directory = mkdtempSync(join(moduleDirectory, ".generated-types-"))
  try {
    for (const [name, source] of sources) writeFileSync(join(directory, `${name}.ts`), source)
    const config = join(directory, "tsconfig.json")
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          lib: ["ESNext", "DOM", "DOM.Iterable"],
          strict: true,
          exactOptionalPropertyTypes: true,
          verbatimModuleSyntax: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          skipLibCheck: true,
          types: []
        },
        include: ["*.ts"]
      })
    )
    try {
      await promisify(execFile)(join(moduleDirectory, "../../../../node_modules/.bin/tsc"), [
        "-p",
        config,
        "--pretty",
        "false"
      ], { timeout: 60_000, maxBuffer: 1024 * 1024 })
    } catch (error) {
      const output = error as Error & { stdout?: string; stderr?: string }
      throw new Error([output.message, output.stdout, output.stderr].filter(Boolean).join("\n"), { cause: error })
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
