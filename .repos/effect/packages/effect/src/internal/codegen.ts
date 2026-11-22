import type { CodeHole, Fragment, Render } from "../Codegen.ts"

/** @internal */
export function cannotCoerce(): never {
  throw new Error("Code fragments must be rendered by their module")
}

function append(value: CodeHole, parts: Array<Fragment>): void {
  if (value === undefined || value === null || value === false || value === "") return
  if (Array.isArray(value)) {
    for (const item of value) append(item, parts)
  } else {
    parts.push(typeof value === "number" ? String(value) : value as Fragment)
  }
}

/** @internal */
export function code(strings: TemplateStringsArray, ...values: ReadonlyArray<CodeHole>): Fragment {
  const parts: Array<Fragment> = []
  for (let i = 0; i < strings.length; i++) {
    append(strings[i], parts)
    append(values[i], parts)
  }
  return { _tag: "Parts", parts, toString: cannotCoerce }
}

/** @internal */
export function join(values: ReadonlyArray<CodeHole>, separator: string): Fragment {
  const parts: Array<Fragment> = []
  for (let i = 0; i < values.length; i++) {
    if (i > 0) parts.push(separator)
    append(values[i], parts)
  }
  return { _tag: "Parts", parts, toString: cannotCoerce }
}

/** @internal */
export function deferred(render: (render: Render) => string): Fragment {
  return { _tag: "Deferred", render, toString: cannotCoerce }
}

/** @internal */
export function literal(value: string | number | bigint | boolean | null | undefined): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "bigint") return `${value}n`
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "globalThis.NaN"
    if (value === Infinity) return "globalThis.Infinity"
    if (value === -Infinity) return "-globalThis.Infinity"
    if (Object.is(value, -0)) return "-0"
  }
  return String(value)
}
