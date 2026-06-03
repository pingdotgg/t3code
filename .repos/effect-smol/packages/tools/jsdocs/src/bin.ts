#!/usr/bin/env node
import { extractJSDocsSync, loadJSDocConfig, writeJSDocModel } from "./Jsdocs.ts"

try {
  const cwd = process.cwd()
  const check = process.argv.includes("--check")
  const config = loadJSDocConfig(cwd)
  const model = extractJSDocsSync({ cwd, ...config })
  writeJSDocModel(cwd, config.output, model)
  process.stdout.write(`Wrote ${config.output}\n`)
  const diagnostics = model.files.reduce((count, file) => count + file.diagnostics.length, 0)
  if (diagnostics > 0) {
    for (const file of model.files) {
      for (const diagnostic of file.diagnostics) {
        process.stderr.write(`${file.file}: ${diagnostic.message}\n`)
      }
    }
    if (check) process.exitCode = 1
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
