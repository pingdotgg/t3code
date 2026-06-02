import * as ChildProcess from "node:child_process"
import * as Fs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import { performance } from "node:perf_hooks"

interface FenceInfo {
  readonly language: string
  readonly noCheck: boolean
  readonly runnable: boolean
  readonly deterministic: boolean
}

interface Example {
  readonly file: string
  readonly startLine: number
  readonly code: string
  readonly noCheck: boolean
  readonly runnable: boolean
  readonly deterministic: boolean
}

interface GeneratedExample extends Example {
  readonly generatedFile: string
}

interface OpenFence {
  readonly startLine: number
  readonly info: FenceInfo
  readonly lines: Array<string>
}

interface RunResult {
  readonly status: number
  readonly message: string
}

const files = process.argv.slice(2)

if (files.length === 0) {
  console.error("Usage: node scripts/check-cookbook-schedule.ts <markdown-file...>")
  process.exit(1)
}

const outputDirectory = Path.join("scratchpad", ".markdown-examples")

function parseFenceInfo(info: string): FenceInfo {
  const parts = info.trim().split(/\s+/).filter(Boolean)
  const language = parts[0] ?? ""
  const metadata = new Set(parts.slice(1))
  return {
    language,
    noCheck: metadata.has("no-check"),
    runnable: metadata.has("runnable"),
    deterministic: metadata.has("deterministic")
  }
}

function isTypeScript(language: string): boolean {
  return language === "ts" || language === "typescript"
}

function hasNoCheckComment(lines: ReadonlyArray<string>, index: number): boolean {
  let previous = index - 1
  while (previous >= 0 && (lines[previous] ?? "").trim() === "") {
    previous--
  }
  return /^<!--\s*no-check:\s*.+-->$/.test(lines[previous] ?? "")
}

function extractExamples(file: string): Array<Example> {
  const lines = Fs.readFileSync(file, "utf8").split(/\r?\n/)
  const examples: Array<Example> = []
  let open: OpenFence | undefined = undefined

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""

    if (!line.startsWith("```")) {
      if (open !== undefined) {
        open.lines.push(line)
      }
      continue
    }

    if (open === undefined) {
      const info = parseFenceInfo(line.slice(3))
      if (isTypeScript(info.language) && info.noCheck && !hasNoCheckComment(lines, index)) {
        throw new Error(
          `${file}:${index + 1} has a no-check TypeScript fence without a preceding <!-- no-check: ... --> comment`
        )
      }
      open = {
        startLine: index + 1,
        info,
        lines: []
      }
      continue
    }

    if (isTypeScript(open.info.language)) {
      examples.push({
        file,
        startLine: open.startLine,
        code: open.lines.join("\n"),
        noCheck: open.info.noCheck,
        runnable: open.info.runnable,
        deterministic: open.info.deterministic
      })
    }
    open = undefined
  }

  if (open !== undefined) {
    throw new Error(`${file}:${open.startLine} has an unclosed code fence`)
  }

  return examples
}

function sanitizeFileName(file: string): string {
  return file.replaceAll(Path.sep, "_").replaceAll(/[^a-zA-Z0-9_.-]/g, "_")
}

function run(command: string, args: Array<string>): number {
  const result = ChildProcess.spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32"
  })

  if (result.error !== undefined) {
    throw result.error
  }

  return result.status ?? 1
}

function stripAnsi(text: string): string {
  const escape = String.fromCharCode(27)
  return text.replace(new RegExp(`${escape}\\[[0-9;]*m`, "g"), "")
}

function normalizeOutput(text: string): string {
  return stripAnsi(text).trimEnd()
}

function variableOutputLine(example: Example): number {
  return example.code.split("\n").findIndex((line) => line.trim().startsWith("// Output may vary:"))
}

function hasVariableOutputMarker(example: Example): boolean {
  return variableOutputLine(example) !== -1
}

function variableOutputSample(example: Example): Array<string> {
  const lines = example.code.split("\n")
  const outputLine = variableOutputLine(example)

  if (outputLine === -1) {
    return []
  }

  const output: Array<string> = []
  for (const line of lines.slice(outputLine + 1)) {
    const match = /^\/\/ ?(.*)$/.exec(line)
    if (match === null) {
      if (line.trim() === "") {
        continue
      }
      break
    }
    output.push(match[1] ?? "")
  }

  return output
}

function expectedOutput(example: Example): string {
  const lines = example.code.split("\n")
  const outputLine = lines.findIndex((line) => line.trim() === "// Output:")

  if (outputLine === -1) {
    throw new Error(`${example.file}:${example.startLine} is deterministic but has no // Output: comment`)
  }

  const output: Array<string> = []
  for (const line of lines.slice(outputLine + 1)) {
    const match = /^\/\/ ?(.*)$/.exec(line)
    if (match === null) {
      if (line.trim() === "") {
        continue
      }
      break
    }
    output.push(match[1] ?? "")
  }

  return output.join("\n")
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)}ms`
  }
  return `${(milliseconds / 1000).toFixed(1)}s`
}

function runExample(example: GeneratedExample): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = ChildProcess.spawn("node", [example.generatedFile], {
      shell: process.platform === "win32"
    })
    const stdout: Array<Buffer> = []
    const stderr: Array<Buffer> = []

    if (child.stdout === null || child.stderr === null) {
      reject(new Error("Expected child process stdio streams"))
      return
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk)
    })
    child.on("error", reject)
    child.on("close", (status) => {
      const actualStdout = Buffer.concat(stdout).toString("utf8")
      const actualStderr = Buffer.concat(stderr).toString("utf8")
      const normalizedStdout = normalizeOutput(actualStdout)

      if ((status ?? 1) !== 0) {
        resolve({
          status: status ?? 1,
          message: [
            `${example.file}:${example.startLine} failed while running`,
            actualStdout,
            actualStderr
          ].filter((part) => part.length > 0).join("\n")
        })
        return
      }

      if (example.deterministic) {
        const expected = expectedOutput(example)
        if (normalizedStdout !== normalizeOutput(expected)) {
          resolve({
            status: 1,
            message: [
              `${example.file}:${example.startLine} output did not match // Output:`,
              "Expected:",
              expected,
              "Actual:",
              normalizedStdout
            ].join("\n")
          })
          return
        }
      } else if (hasVariableOutputMarker(example) && normalizedStdout.length === 0) {
        resolve({
          status: 1,
          message: `${example.file}:${example.startLine} is marked // Output may vary: but produced no stdout`
        })
        return
      }

      resolve({ status: 0, message: "" })
    })
  })
}

async function runExamples(examples: ReadonlyArray<GeneratedExample>): Promise<Array<RunResult>> {
  const concurrency = Math.max(1, Math.min(Os.availableParallelism(), examples.length))
  const startedAt = performance.now()
  let next = 0
  let completed = 0
  const results: Array<RunResult> = []

  if (examples.length > 0) {
    console.error(`Running ${examples.length} runnable example(s) with concurrency ${concurrency}`)
  }

  function elapsed(): string {
    return formatDuration(performance.now() - startedAt)
  }

  function reportProgress(): void {
    if (completed === examples.length || completed % 10 === 0) {
      console.error(`Ran ${completed}/${examples.length} runnable example(s) in ${elapsed()}`)
    }
  }

  async function worker(workerId: number): Promise<void> {
    while (next < examples.length) {
      const index = next++
      const example = examples[index]!
      const exampleStartedAt = performance.now()
      console.error(`Worker ${workerId}: ${example.file}:${example.startLine} started at ${elapsed()}`)
      results[index] = await runExample(example)
      completed++
      console.error(
        `Worker ${workerId}: ${example.file}:${example.startLine} finished in ${
          formatDuration(performance.now() - exampleStartedAt)
        }`
      )
      reportProgress()
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index + 1)))
  return results
}

Fs.rmSync(outputDirectory, { recursive: true, force: true })
Fs.mkdirSync(outputDirectory, { recursive: true })

try {
  const examples = files.flatMap(extractExamples)
  const checkedExamples = examples.filter((example) => !example.noCheck)

  const generatedFiles: Array<GeneratedExample> = checkedExamples.map((example, index) => {
    const generatedFile = Path.join(
      outputDirectory,
      `${String(index + 1).padStart(3, "0")}-${sanitizeFileName(example.file)}-L${example.startLine}.ts`
    )
    Fs.writeFileSync(
      generatedFile,
      `// Generated from ${example.file}:${example.startLine}\n${example.code}\n`
    )
    return { ...example, generatedFile }
  })

  if (generatedFiles.length > 0) {
    const status = run("pnpm", [
      "exec",
      "tsc",
      "--noEmit",
      "--skipLibCheck",
      "--moduleResolution",
      "bundler",
      "--module",
      "esnext",
      "--target",
      "es2022",
      "--lib",
      "esnext,dom",
      "--types",
      "node",
      "--strict",
      "--ignoreConfig",
      "--allowImportingTsExtensions",
      ...generatedFiles.map((example) => example.generatedFile)
    ])

    if (status !== 0) {
      process.exit(status)
    }
  }

  const runnableExamples = generatedFiles.filter((example) => example.runnable)
  const deterministicExamples = runnableExamples.filter((example) => example.deterministic)
  for (const example of runnableExamples) {
    if (!example.deterministic && !hasVariableOutputMarker(example)) {
      console.error(
        `${example.file}:${example.startLine} is runnable but has neither deterministic metadata nor // Output may vary:`
      )
      process.exit(1)
    }
    if (!example.deterministic && variableOutputSample(example).length === 0) {
      console.error(`${example.file}:${example.startLine} has // Output may vary: but no sample output lines`)
      process.exit(1)
    }
  }

  const results = await runExamples(runnableExamples)
  const failed = results.filter((result) => result.status !== 0)
  for (const result of failed) {
    console.error(result.message)
  }
  if (failed.length > 0) {
    process.exit(1)
  }

  console.log(
    `Checked ${checkedExamples.length} TypeScript example(s) from ${files.length} Markdown file(s); ran ${runnableExamples.length}; compared ${deterministicExamples.length}`
  )
} finally {
  Fs.rmSync(outputDirectory, { recursive: true, force: true })
}
