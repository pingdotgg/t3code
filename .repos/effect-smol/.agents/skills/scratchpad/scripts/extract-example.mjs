#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path"

const usage = `Usage:
  node .agents/skills/scratchpad/scripts/extract-example.mjs <source-path> <line> [--mode auto|preserve] [--runner <identifier>] [--out-dir <dir>]

Examples:
  node .agents/skills/scratchpad/scripts/extract-example.mjs packages/effect/src/Schedule.ts 9
  node .agents/skills/scratchpad/scripts/extract-example.mjs packages/effect/src/Schedule.ts 9 --mode preserve
  node .agents/skills/scratchpad/scripts/extract-example.mjs packages/effect/src/Schedule.ts 9 --runner myProgram
`

const args = process.argv.slice(2)
const sourcePath = args[0]
const lineInput = args[1]
let mode = "auto"
let runner = undefined
let outDir = "scratchpad"

for (let index = 2; index < args.length; index++) {
  const arg = args[index]
  if (arg === "--mode") {
    mode = args[++index]
  } else if (arg === "--runner") {
    runner = args[++index]
  } else if (arg === "--out-dir") {
    outDir = args[++index]
  } else {
    fail(`Unknown option: ${arg}`)
  }
}

if (!sourcePath || !lineInput) {
  fail(usage)
}

if (mode !== "auto" && mode !== "preserve") {
  fail(`Invalid --mode: ${mode}`)
}

if (runner !== undefined && !/^[A-Za-z_$][\w$]*$/.test(runner)) {
  fail(`Invalid --runner identifier: ${runner}`)
}

const line = Number.parseInt(lineInput, 10)

if (!Number.isSafeInteger(line) || line < 1) {
  fail(`Invalid line number: ${lineInput}`)
}

const resolvedSourcePath = resolve(sourcePath)
const source = readFileSync(resolvedSourcePath, "utf8")
const sourceLines = source.split(/\r?\n/)
const examples = findExamples(sourceLines)

if (examples.length === 0) {
  fail(`No JSDoc examples found in ${sourcePath}`)
}

const example = chooseExample(examples, line)
const hasRunner = /\bEffect\.run[A-Za-z]*\s*\(/.test(example.code)
const programRunner = /^\s*(?:export\s+)?(?:const|let|var)\s+program\s*=/m.test(example.code)

let code = example.code.trimEnd()
let runnerStatus = "none"

if (runner !== undefined) {
  code = appendRunner(code, runner)
  runnerStatus = `appended:${runner}`
} else if (mode === "auto") {
  if (hasRunner) {
    runnerStatus = "already-present"
  } else if (programRunner) {
    code = appendRunner(code, "program")
    runnerStatus = "appended:program"
  } else {
    const payload = {
      status: "needs-runner",
      title: example.title,
      sourcePath: displayPath(resolvedSourcePath),
      titleLine: example.titleLine,
      codeStartLine: example.codeStartLine,
      codeEndLine: example.codeEndLine
    }
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`)
    process.exit(2)
  }
}

mkdirSync(outDir, { recursive: true })

const outputPath = uniqueOutputPath(outDir, resolvedSourcePath, example.title)
writeFileSync(outputPath, `${code}\n`, "utf8")

process.stdout.write(
  `${JSON.stringify(
    {
      outputPath: displayPath(resolve(outputPath)),
      title: example.title,
      sourcePath: displayPath(resolvedSourcePath),
      titleLine: example.titleLine,
      codeStartLine: example.codeStartLine,
      codeEndLine: example.codeEndLine,
      runner: runnerStatus
    },
    null,
    2
  )}\n`
)

function findExamples(lines) {
  const examples = []
  let blockStart = -1
  let block = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]

    if (blockStart === -1 && line.includes("/**")) {
      blockStart = index
      block = [line]
      if (line.includes("*/")) {
        collectExamples(examples, block, blockStart)
        blockStart = -1
      }
      continue
    }

    if (blockStart !== -1) {
      block.push(line)
      if (line.includes("*/")) {
        collectExamples(examples, block, blockStart)
        blockStart = -1
      }
    }
  }

  return examples
}

function collectExamples(examples, block, blockStart) {
  const cleaned = block.map(cleanJSDocLine)

  for (let index = 0; index < cleaned.length; index++) {
    const line = cleaned[index]
    const titleMatch = line.match(/\*\*Example\*\*(?:\s*\(([^)]+)\))?/)

    if (titleMatch === null) {
      continue
    }

    const title = titleMatch[1]?.trim() || `example-${blockStart + index + 1}`
    const fenceStart = findFenceStart(cleaned, index + 1)

    if (fenceStart === -1) {
      continue
    }

    const fenceEnd = findFenceEnd(cleaned, fenceStart + 1)

    if (fenceEnd === -1) {
      continue
    }

    examples.push({
      title,
      titleLine: blockStart + index + 1,
      codeStartLine: blockStart + fenceStart + 2,
      codeEndLine: blockStart + fenceEnd,
      code: cleaned.slice(fenceStart + 1, fenceEnd).join("\n")
    })

    index = fenceEnd
  }
}

function findFenceStart(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index++) {
    const trimmed = lines[index].trim()

    if (trimmed.startsWith("**Example**")) {
      return -1
    }

    if (/^```(?:ts|typescript)?\s*$/.test(trimmed)) {
      return index
    }
  }

  return -1
}

function findFenceEnd(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index++) {
    if (lines[index].trim() === "```") {
      return index
    }
  }

  return -1
}

function cleanJSDocLine(line) {
  return line.replace(/^\s*\/\*\*\s?/, "").replace(/^\s*\*\/\s?$/, "").replace(/^\s*\* ?/, "")
}

function chooseExample(examples, line) {
  const containing = examples.find((example) => example.titleLine <= line && line <= example.codeEndLine)

  if (containing !== undefined) {
    return containing
  }

  const following = examples.find((example) => line < example.titleLine)

  if (following !== undefined) {
    return following
  }

  return examples[examples.length - 1]
}

function appendRunner(code, identifier) {
  return `${code.trimEnd()}\n\nEffect.runPromise(${identifier}).then(console.log, console.error)`
}

function uniqueOutputPath(directory, source, title) {
  const sourceName = basename(source, extname(source))
  const titleSlug = slug(title) || "example"
  const base = `${sourceName}-${titleSlug}`
  let candidate = join(directory, `${base}.ts`)
  let suffix = 2

  while (existsSync(candidate)) {
    candidate = join(directory, `${base}-${suffix}.ts`)
    suffix++
  }

  return candidate
}

function slug(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function displayPath(path) {
  return isAbsolute(path) ? relative(process.cwd(), path) || "." : path
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
