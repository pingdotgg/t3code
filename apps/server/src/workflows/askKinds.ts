// Bodies run only when a run reaches them, so a file is read for the kinds its `ask`s name.
import type { WorkflowDefinition } from "./workflow.ts";

/** How far past `ask(` a call is read; a longer one is left to the check when it runs. */
const CALL_READ = 4_000;
const CLOSES: Readonly<Record<string, string>> = { "(": ")", "{": "}", "[": "]" };

/** The literal `kind` of the options of the `ask(` call that starts at `from`, and where it is. */
const literalKind = (
  source: string,
  from: number,
): { readonly kind: string; readonly at: number } | undefined => {
  const end = Math.min(source.length, from + CALL_READ);
  const open: Array<string> = ["("];
  let i = from;
  while (i < end && open.length > 0) {
    const char = source[i]!;
    if (char === '"' || char === "'" || char === "`") {
      const close = source.indexOf(char, i + 1);
      if (close === -1 || close >= end) return undefined;
      i = close + 1;
      continue;
    }
    if (char === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
      const close =
        source[i + 1] === "/" ? source.indexOf("\n", i) : source.indexOf("*/", i + 2) + 1;
      if (close <= 0) return undefined;
      i = close + 1;
      continue;
    }
    if (char in CLOSES) open.push(char);
    else if (char === ")" || char === "}" || char === "]") open.pop();
    // Only the options object's own `kind`, not one inside its `data`.
    else if (open.length === 2 && open[1] === "{" && source.startsWith("kind", i)) {
      const before = source[i - 1] ?? "";
      const match = /^kind\s*:\s*(["'])([^"'\\\n]*)\1/.exec(source.slice(i, i + 200));
      if (match !== null && !/[\w$.]/.test(before)) return { kind: match[2]!, at: i };
    }
    i++;
  }
  return undefined;
};

/**
 * Every `ask(…, { kind: "…" })` in `source` whose literal kind none of `declared` holds, with
 * its line. A kind that is not a literal is left to the check when the `ask` runs.
 */
export const undeclaredAskKinds = (
  source: string,
  declared: ReadonlySet<string>,
): ReadonlyArray<{ readonly kind: string; readonly line: number }> => {
  const found: Array<{ kind: string; line: number }> = [];
  for (const call of source.matchAll(/(?<![\w$])ask\s*\(/g)) {
    // A call commented out on its line is not one.
    if (source.slice(source.lastIndexOf("\n", call.index) + 1, call.index).includes("//")) continue;
    const named = literalKind(source, call.index + call[0].length);
    if (named === undefined || declared.has(named.kind)) continue;
    found.push({ kind: named.kind, line: source.slice(0, named.at).split("\n").length });
  }
  return found;
};

/** Why `source` does not load: its first `ask` with a kind none of its workflows declare. */
export const undeclaredAskKindProblem = (
  source: string,
  definitions: ReadonlyArray<WorkflowDefinition>,
): string | undefined => {
  const declared = [
    ...new Set(definitions.flatMap((definition) => definition.asks.map((ask) => ask.kind))),
  ];
  const [found] = undeclaredAskKinds(source, new Set(declared));
  if (found === undefined) return undefined;
  const named =
    definitions.length === 1 ? `workflow ${definitions[0]!.name}` : "no workflow in this file";
  return `An ask on line ${found.line} has kind ${JSON.stringify(found.kind)}, which ${named} does not declare in its \`asks\`. ${
    declared.length === 0
      ? "Declare it there."
      : `Declared: ${declared.map((kind) => JSON.stringify(kind)).join(", ")}.`
  }`;
};
