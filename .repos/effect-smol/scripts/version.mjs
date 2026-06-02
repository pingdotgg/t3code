import * as Fs from "node:fs"
import Package from "../packages/effect/package.json" with { type: "json" }

const tpl = Fs.readFileSync("./scripts/version.template.txt").toString("utf8")

Fs.writeFileSync(
  "packages/effect/src/internal/version.ts",
  tpl.replace(/VERSION/g, Package.version)
)
