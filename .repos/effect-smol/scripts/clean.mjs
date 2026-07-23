import * as Glob from "glob"
import * as Fs from "node:fs"

const dirs = [".", ...Glob.sync("packages/*/"), ...Glob.sync("packages/sql/*/"), ...Glob.sync("packages/tools/*/"), ...Glob.sync("packages/ai/*/"), ...Glob.sync("packages/atom/*/")]
dirs.forEach((pkg) => {
  const files = [".tsbuildinfo", "tsconfig.tsbuildinfo", "docs", "build", "dist", "coverage"]

  files.forEach((file) => {
    if (pkg === "." && file === "docs") {
      return
    }

    Fs.rmSync(`${pkg}/${file}`, { recursive: true, force: true }, () => {})
  })
})

Glob.sync("docs/*/").forEach((dir) => {
  Fs.rmSync(dir, { recursive: true, force: true }, () => {})
})
