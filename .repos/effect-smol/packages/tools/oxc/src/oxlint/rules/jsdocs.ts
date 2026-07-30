import * as Jsdocs from "@effect/jsdocs/Jsdocs"
import * as fs from "node:fs"
import * as path from "node:path"
import type { CreateRule, ESTree, Visitor } from "oxlint"

interface RuleOptions {
  readonly model?: string
}

interface CachedModel {
  readonly result: ReturnType<typeof Jsdocs.readJSDocModel>
  readonly filesByPath: ReadonlyMap<string, ReadonlyArray<unknown>[number]>
  readonly mtimeMs: number
  readonly size: number
}

const modelCache = new Map<string, CachedModel>()

function getSourceText(context: {
  readonly sourceCode: { readonly text?: string; getText(node?: unknown): string }
}): string {
  return context.sourceCode.text ?? context.sourceCode.getText()
}

function getCwd(context: { readonly cwd?: string; getCwd?: () => string }): string {
  return context.cwd ?? context.getCwd?.() ?? process.cwd()
}

function normalizePathName(filename: string): string {
  return filename.split(path.sep).join("/")
}

function readCachedModel(modelPath: string): CachedModel["result"] {
  if (!fs.existsSync(modelPath)) return { _tag: "Failure", error: "missing" }
  const stats = fs.statSync(modelPath)
  const cached = modelCache.get(modelPath)
  if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.result
  const result = Jsdocs.readJSDocModel(modelPath)
  modelCache.set(modelPath, {
    result,
    filesByPath: result._tag === "Success" ? new Map(result.value.files.map((file) => [file.file, file])) : new Map(),
    mtimeMs: stats.mtimeMs,
    size: stats.size
  })
  return result
}

function getCachedFile(
  modelPath: string,
  file: string
): ReturnType<typeof Jsdocs.readJSDocModel> extends infer R
  ? R extends { readonly _tag: "Success"; readonly value: { readonly files: ReadonlyArray<infer A> } } ? A | undefined
  : never
  : never
{
  return modelCache.get(modelPath)?.filesByPath.get(file) as never
}

function rangeNode(range: readonly [number, number]): { readonly range: [number, number] } {
  return { range: [range[0], range[1]] }
}

const rule: CreateRule = {
  meta: {
    type: "problem",
    docs: { description: "Enforce Effect's public API JSDoc structure" },
    schema: [
      {
        type: "object",
        properties: {
          model: { type: "string" }
        },
        additionalProperties: false
      }
    ]
  },
  create(context) {
    const options = (context.options[0] as RuleOptions | undefined) ?? {}
    const source = getSourceText(context)
    const cwd = getCwd(context)
    const modelPath = path.resolve(cwd, options.model ?? ".data/jsdocs.json")
    const result = readCachedModel(modelPath)
    if (result._tag === "Failure") {
      if (result.error === "missing") return {} as Visitor
      return {
        Program(node: ESTree.Node) {
          context.report({ node, message: result.error })
        }
      } as Visitor
    }
    const relative = normalizePathName(path.relative(cwd, context.filename))
    const file = getCachedFile(modelPath, relative)
    if (file === undefined) return {} as Visitor
    return {
      Program(node: ESTree.Node) {
        if (file.hash !== Jsdocs.sourceHash(source)) {
          context.report({ node, message: "JSDoc model is stale for this file; run `pnpm jsdocs`" })
          return
        }
        for (const diagnostic of file.diagnostics) {
          context.report({ node: rangeNode(diagnostic.range), message: diagnostic.message })
        }
      }
    } as Visitor
  }
}

export default rule
