/**
 * Resolves `intro/steps.ts` into `out/capture/intro/intro.json` for Remotion:
 *
 * - type-checks every file in `snippets/` with the real compiler: normal
 *   files must pass; `*.error.ts` files must fail, and their error is shown
 * - cuts each snippet down to its `// #region` blocks
 * - highlights code with Shiki (VS Code's Dark+ colours)
 * - turns text anchors for marks, tints and errors into line/column ranges
 *
 *   pnpm intro:build
 */
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { diffArrays } from "diff";
import { createHighlighter } from "shiki";
import { API } from "tsgo/unstable/sync";
import type {
  CodeError,
  CodeStep,
  IntroJson,
  IntroStep,
  Mark,
  RollStep,
  Token,
} from "../shared/intro.ts";
import type { CodeSpec, Find, StepSpec } from "./steps.ts";

/** Which deck to build: `intro` (intro/steps.ts) or `loop` (intro/loop.ts). */
const deckName = process.argv[2] ?? "intro";
const decks: Record<string, () => Promise<StepSpec[]>> = {
  intro: async () => (await import("./steps.ts")).steps,
  loop: async () => (await import("./loop.ts")).steps,
};
if (!decks[deckName])
  throw new Error(`unknown deck ${deckName}: expected ${Object.keys(decks).join(" | ")}`);
const steps = await decks[deckName]();

const root = path.resolve(import.meta.dirname, "..");
const snippetsDir = path.join(import.meta.dirname, "snippets");
/** Snippet diagnostics and shared assets live with the intro deck. */
const shared = path.join(root, "out", "capture", "intro");
const out = path.join(root, "out", "capture", deckName);

// ── type-check the snippets ──────────────────────────────────────────────
// With the tsgo 7.1 nightly's API: open the snippets project in a snapshot
// and read each file's diagnostics (needs Node; the API's sync channel
// doesn't run under Bun).
interface Diagnostic {
  line: number;
  col: number;
  code: string;
  message: string[];
}
interface Chain {
  text: string;
  messageChain?: Chain[];
}
const flatten = (chain: Chain, depth = 0): string[] => [
  chain.text,
  ...(chain.messageChain ?? []).flatMap((child) => flatten(child, depth + 1)),
];

// Type-checking is the slow part; skip it when no snippet changed since the last build.
const cacheFile = path.join(shared, "diagnostics.json");
/** Sub-projects with their own tsconfig (e.g. the demo's `shorty/` app), checked as a unit. */
const projects = [
  "",
  ...(await readdir(snippetsDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name),
];
const listTs = async (dir: string) =>
  (await readdir(path.join(snippetsDir, dir)))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => (dir ? `${dir}/${f}` : f));
const snippetNames = [
  ...(await Promise.all(projects.map(listTs))).flat(),
  ...projects.map((p) => (p ? `${p}/tsconfig.json` : "tsconfig.json")),
];
const stamp = (
  await Promise.all(
    snippetNames.map(async (f) => `${f}:${(await stat(path.join(snippetsDir, f))).mtimeMs}`),
  )
).join("|");
const cached = await readFile(cacheFile, "utf8").then(
  (t) => JSON.parse(t) as { stamp: string; diagnostics: [string, Diagnostic[]][] },
  () => undefined,
);
const diagnostics = new Map<string, Diagnostic[]>(
  cached?.stamp === stamp ? cached.diagnostics : [],
);
if (cached?.stamp !== stamp) {
  console.log("● type-checking intro/snippets (tsgo)");
  const api = new API({ cwd: snippetsDir });
  const configs = projects.map((p) => path.join(snippetsDir, p, "tsconfig.json"));
  const snapshot = api.createSnapshot({ openProjects: configs });
  for (const [i, dir] of projects.entries()) {
    const project = snapshot.getConfiguredProject(configs[i]!);
    if (!project) throw new Error(`could not open ${configs[i]}`);
    for (const file of await listTs(dir)) {
      const full = path.join(snippetsDir, file);
      const list = [
        ...project.program.getSyntacticDiagnostics(full),
        ...project.program.getSemanticDiagnostics(full),
      ] as unknown as (Chain & {
        code: number;
        startPosition: { line: number; character: number };
      })[];
      diagnostics.set(
        file,
        list.map((d) => ({
          line: d.startPosition.line,
          col: d.startPosition.character,
          code: `TS${d.code}`,
          message: flatten(d),
        })),
      );
    }
  }
  api.close();
  await mkdir(shared, { recursive: true });
  await writeFile(cacheFile, JSON.stringify({ stamp, diagnostics: [...diagnostics] }));
}

const snippetFiles = (await Promise.all(projects.map(listTs))).flat();
for (const file of snippetFiles) {
  const list = diagnostics.get(file) ?? [];
  const errorFile = file.endsWith(".error.ts");
  if (errorFile && list.length === 0)
    throw new Error(`${file} is expected to fail type-checking, but it passes`);
  if (!errorFile && list.length > 0) {
    throw new Error(
      `${file} must type-check:\n${list.map((d) => `  ${d.line + 1}:${d.col + 1} ${d.message.join("\n    ")}`).join("\n")}`,
    );
  }
}

// ── snippets: keep only the named regions ────────────────────────────────
const REGION = /^\s*\/\/ #(end)?region\b/;
/** Code that must be there to type-check but isn't worth showing: `/*hide*\/ … /*end*\/`. */
const HIDDEN = /\/\*hide\*\/.*?\/\*end\*\//g;
/** `// @slide code` is a comment in the real file and `code` on the slide (e.g. a stand-in closing line). */
const SLIDE_ONLY = /^(\s*)\/\/ @slide (.*)$/;
interface Cut {
  code: string;
  /** Snippet line (0-based) of each kept line. */
  origin: number[];
  regions: Map<string, [number, number]>;
}
const cut = (text: string, keep?: string[], omit: string[] = [], fold: string[] = []): Cut => {
  const lines = text.split("\n");
  const open: string[] = [];
  const kept: string[] = [];
  const origin: number[] = [];
  const regions = new Map<string, [number, number]>();
  const starts = new Map<string, number>();
  /** Lines of a folded region, collapsed to one line (like an editor fold) when it closes. */
  let folding: { name: string; lines: [string, number][] } | undefined;
  lines.forEach((line, i) => {
    const marker = line.match(/^\s*\/\/ #(end)?region\s+(\S+)/);
    if (marker) {
      const name = marker[2]!;
      if (marker[1] && folding?.name === name) {
        const body = folding.lines.filter(([l]) => l.trim());
        for (const [l, o] of folding.lines) {
          if (l.trim()) break;
          kept.push(l);
          origin.push(o);
        }
        if (body.length) {
          const first = body[0]![0].replace(/\s+$/, "");
          const last = body.at(-1)![0].trim();
          kept.push(body.length > 1 ? `${first} … ${last}` : first);
          origin.push(body[0]![1]);
        }
        folding = undefined;
      } else if (!marker[1] && fold.includes(name) && !omit.some((n) => open.includes(n))) {
        folding = { name, lines: [] };
      }
      if (marker[1]) {
        open.splice(open.lastIndexOf(name), 1);
        regions.set(name, [starts.get(name)!, kept.length - 1]);
      } else {
        open.push(name);
        starts.set(name, kept.length);
      }
      return;
    }
    if (REGION.test(line)) return;
    // Not written yet: gone without a trace.
    if (omit.some((name) => open.includes(name))) return;
    if (keep && !keep.some((name) => open.includes(name))) {
      // Skipped code shows as one "…" line, indented like the code it stands for.
      // Only inside `show` (the whole excerpt): code outside it is never on screen.
      if (line.trim() && open.includes("show") && kept.at(-1)?.trim() !== "…") {
        kept.push(`${line.match(/^\s*/)![0]}…`);
        origin.push(i);
      }
      return;
    }
    if (folding) {
      folding.lines.push([line.replace(SLIDE_ONLY, "$1$2").replace(HIDDEN, ""), i]);
      return;
    }
    kept.push(line.replace(SLIDE_ONLY, "$1$2").replace(HIDDEN, ""));
    origin.push(i);
  });
  // Drop the shared indentation and blank edges, and a "…" standing for the file's tail.
  while (kept.length && !kept[0]!.trim()) (kept.shift(), origin.shift());
  while (kept.length && (!kept.at(-1)!.trim() || kept.at(-1)!.trim() === "…"))
    (kept.pop(), origin.pop());
  return { code: kept.join("\n"), origin, regions };
};

// ── highlighting ─────────────────────────────────────────────────────────
const highlighter = await createHighlighter({
  themes: ["dark-plus"],
  langs: ["typescript", "yaml", "shellscript", "json"],
});
const PSEUDO_KEYWORDS: Record<string, string> = { construct: "#a3c473", runtime: "#e0a86b" };
const tokenize = (
  code: string,
  pseudo: boolean,
  lang: "typescript" | "yaml" | "ansi" | "shellscript" | "json" = "typescript",
): Token[][] =>
  highlighter.codeToTokens(code, { lang, theme: "dark-plus" }).tokens.map((line) =>
    line.flatMap((token) => {
      // Shiki's FontStyle.Bold is bit 2 (terminal output uses it).
      const bold = ((token.fontStyle ?? 0) & 2) !== 0 || undefined;
      if (!pseudo)
        return [
          { text: token.content, color: token.color ?? "#d4d4d4", ...(bold ? { bold } : {}) },
        ];
      // The imagined language's own keywords.
      return token.content
        .split(/\b(construct|runtime)\b/)
        .flatMap((text, i) =>
          text
            ? [{ text, color: i % 2 ? PSEUDO_KEYWORDS[text]! : (token.color ?? "#d4d4d4") }]
            : [],
        );
    }),
  );

// ── anchors ──────────────────────────────────────────────────────────────
const locate = (code: string, find: Find, title: string) => {
  const { text, nth = 1 } = typeof find === "string" ? { text: find } : find;
  let at = -1;
  for (let i = 0; i < nth; i++) {
    at = code.indexOf(text, at + 1);
    if (at < 0)
      throw new Error(`step "${title}": ${JSON.stringify(text)} not found (occurrence ${i + 1})`);
  }
  const before = code.slice(0, at);
  const line = before.split("\n").length - 1;
  return { line, col: at - (before.lastIndexOf("\n") + 1), len: text.length };
};

/** `split`: shown as one of two side-by-side panes, so it gets half the width. */
const resolveCode = async (spec: CodeSpec, split = false): Promise<CodeStep> => {
  let code: string;
  let raw: string | undefined;
  let regions = new Map<string, [number, number]>();
  let error: CodeError | undefined;
  if ("snippet" in spec.src) {
    const file = path.join(snippetsDir, spec.src.snippet);
    const text = await readFile(file, "utf8");
    const c = cut(text, spec.src.regions, spec.src.omit, spec.src.fold);
    code = c.code;
    regions = c.regions;
    const list = diagnostics.get(spec.src.snippet) ?? [];
    if (spec.src.snippet.endsWith(".error.ts") && !spec.error?.hide) {
      // The diagnostic to show: the first whose message `pick` keeps anything from.
      const d =
        (spec.error?.pick && list.find((x) => spec.error!.pick!(x.message).length > 0)) || list[0]!;
      const line = c.origin.indexOf(d.line);
      if (line < 0) throw new Error(`step "${spec.title}": the error is outside the shown regions`);
      const shown = spec.error?.pick ? spec.error.pick(d.message) : d.message.slice(0, 2);
      // Underline to the end of the error's line, like the editor's squiggle.
      const lineText = code.split("\n")[line]!;
      const indent =
        text.split("\n")[d.line]!.length -
        text.split("\n")[d.line]!.trimStart().length -
        (lineText.length - lineText.trimStart().length);
      const col = Math.max(0, d.col - indent);
      error = {
        line,
        col,
        len: Math.max(1, lineText.length - col),
        code: d.code,
        message: shown,
        below: spec.error?.below,
      };
    }
  } else {
    code = spec.src.code;
  }
  // Terminal output: marks and sizing work on the text as shown, without escapes.
  if (spec.lang === "ansi") {
    raw = code;
    code = code.replace(/\x1b\[[0-9;]*m/g, "");
  }
  const lineOf = (find: Find) => locate(code, find, spec.title).line;
  const tints = (spec.tints ?? []).map((tint) => {
    if ("region" in tint) {
      const r = regions.get(tint.region);
      if (!r) throw new Error(`step "${spec.title}": no region ${tint.region}`);
      return { from: r[0], to: r[1], tone: tint.tone };
    }
    const from = lineOf(tint.from);
    return { from, to: tint.to ? lineOf(tint.to) : from, tone: tint.tone };
  });
  const marks: Mark[] = (spec.marks ?? []).map((mark) => {
    const at = locate(code, mark.find, spec.title);
    return {
      kind: mark.kind,
      ...at,
      ...(mark.to ? { toLine: lineOf(mark.to) } : {}),
      label: mark.label,
      side: mark.side,
      tone: mark.tone,
      arrow: mark.arrow,
    };
  });
  const lines = tokenize(raw ?? code, !!spec.pseudo, spec.lang);
  const beside = spec.beside
    ? await resolveCode(
        { kind: "code", title: spec.title, group: spec.group, ...spec.beside },
        true,
      )
    : undefined;
  const besideCode = beside?.lines.map((l) => l.map((t) => t.text).join("")).join("\n") ?? "";
  const links = (spec.links ?? []).map((link) => ({
    from: locate(code, link.from, spec.title),
    to: locate(besideCode, link.to, spec.title),
    tone: link.tone,
  }));
  const underStep = spec.under
    ? await resolveCode(
        {
          kind: "code",
          title: spec.title,
          group: `${spec.group}-under`,
          file: spec.under.file,
          src: spec.under.src,
          lang: spec.under.lang,
          marks: spec.under.marks,
          fontSize: spec.fontSize,
        },
        true,
      )
    : undefined;
  const underCode = underStep?.lines.map((l) => l.map((t) => t.text).join("")).join("\n") ?? "";
  const under =
    spec.under && underStep
      ? {
          step: underStep,
          label: spec.under.label,
          links: spec.under.links?.map((link) => ({
            from: locate(underCode, link.from, spec.title),
            to: locate(besideCode, link.to, spec.title),
            tone: link.tone,
          })),
        }
      : undefined;
  const longest = Math.max(...code.split("\n").map((l) => l.length));
  // Fit the code: at most 30px, smaller for long files, larger for short snippets.
  const erroring =
    "snippet" in spec.src &&
    spec.src.snippet.endsWith(".error.ts") &&
    !spec.error?.hide &&
    !spec.error?.below;
  const available =
    split || spec.beside
      ? 760
      : spec.panel || spec.drill || spec.req || spec.bundle || erroring
        ? 1060
        : 1560;
  const fontSize =
    spec.fontSize ??
    Math.max(
      18,
      Math.min(
        34,
        Math.floor(available / (longest * 0.6)),
        Math.floor(780 / (lines.length * 1.55)),
      ),
    );
  widthFor.set(lines, available);
  return {
    kind: "code",
    title: spec.title,
    notes: spec.notes ?? "",
    group: spec.group,
    file: spec.file,
    pseudo: spec.pseudo,
    lines,
    fontSize,
    tints,
    focus: spec.focus
      ? { from: lineOf(spec.focus.from), to: lineOf(spec.focus.to ?? spec.focus.from) }
      : undefined,
    marks,
    error,
    panel: spec.panel,
    diagram: spec.diagram,
    timeline: spec.timeline,
    drill: spec.drill,
    req: spec.req,
    bundle: spec.bundle,
    beside,
    links: links.length ? links : undefined,
    under,
    aside: spec.aside,
    cross: spec.cross,
    diagramLinks: spec.diagramLinks?.map((link) => ({
      ...link,
      from: locate(code, link.from, spec.title),
    })),
    quiet: spec.quiet,
    reel: spec.reel,
    layer: spec.layer,
    frames: spec.frames ?? 30,
  };
};

/** The width each code block was fitted to, so it can be refitted after removed lines are added. */
const widthFor = new WeakMap<Token[][], number>();

const resolved: IntroStep[] = [];
for (const spec of steps) {
  if (spec.kind === "code") resolved.push(await resolveCode(spec));
  else if (spec.kind === "slide") {
    resolved.push({
      kind: "slide",
      title: spec.title,
      notes: spec.notes ?? "",
      layout: spec.layout ?? "section",
      eyebrow: spec.eyebrow,
      heading: spec.heading,
      subtitle: spec.subtitle,
      footer: spec.footer,
      frames: spec.frames ?? 60,
    });
  } else if (spec.kind === "terminal") {
    const lines = tokenize(spec.lines, false, "ansi");
    resolved.push({
      kind: "terminal",
      title: spec.title,
      notes: spec.notes ?? "",
      group: spec.group ?? "terminal",
      tabs: spec.tabs,
      active: spec.active,
      lines,
      fresh: spec.fresh ?? lines.length,
      progress: spec.progress
        ? {
            rows: spec.progress.rows,
            done: tokenize(spec.progress.done, false, "ansi"),
            at: spec.progress.at,
          }
        : undefined,
      // New lines appear two frames apart; hold until the last one has faded in (or the deploy finishes).
      frames:
        spec.frames ??
        Math.max(
          24,
          (spec.fresh ?? lines.length) * 2 + 8,
          spec.progress ? spec.progress.at + 12 : 0,
        ),
    });
  } else if (spec.kind === "roll") {
    const fill = (values: string[]) =>
      spec.template.replace(/⟨(\d+)⟩/g, (_, i) => values[Number(i)]!);
    const verify = async (values: string[], check: string) => {
      const shown = cut(await readFile(path.join(snippetsDir, check), "utf8"), ["show"]).code;
      if (shown.trim() !== fill(values).trim()) {
        throw new Error(
          `roll "${spec.title}": template doesn't match ${check}\n--- roll\n${fill(values)}\n--- snippet\n${shown}`,
        );
      }
      if ((diagnostics.get(check) ?? []).length)
        throw new Error(`roll "${spec.title}": ${check} has type errors`);
    };
    for (const value of spec.spin?.through ?? []) {
      if (!spec.spin!.check) continue;
      const values = [...spec.values];
      values[spec.spin!.slot] = value;
      await verify(values, spec.spin!.check(value));
    }
    let code = "";
    const slots: { line: number; start: number; end: number }[] = [];
    for (const part of spec.template.split(/(⟨\d+⟩)/)) {
      const m = /^⟨(\d+)⟩$/.exec(part);
      if (!m) {
        code += part;
        continue;
      }
      const value = spec.values[Number(m[1])];
      if (value === undefined || value.includes("\n"))
        throw new Error(`roll "${spec.title}": bad value for slot ${m[1]}`);
      const lines = code.split("\n");
      const start = lines.at(-1)!.length;
      slots[Number(m[1])] = { line: lines.length - 1, start, end: start + value.length };
      code += value;
    }
    if (spec.check) await verify(spec.values, spec.check);
    resolved.push({
      kind: "roll",
      title: spec.title,
      notes: spec.notes ?? "",
      group: spec.group,
      file: spec.file,
      fontSize: spec.fontSize ?? 30,
      lines: tokenize(code, false),
      slots,
      beside: spec.beside
        ? {
            file: spec.beside.file,
            lines: tokenize(spec.beside.code, false, spec.beside.lang ?? "yaml"),
          }
        : undefined,
      reel: spec.reel,
      spin: spec.spin
        ? {
            slot: spec.spin.slot,
            through: spec.spin.through,
            reelFrom: spec.reel ? spec.reel.at - spec.spin.through.length : 0,
          }
        : undefined,
      frames: spec.frames ?? (spec.spin ? 30 + spec.spin.through.length * 6 : 24),
    });
  } else if (spec.kind === "browser") {
    resolved.push({
      kind: "browser",
      title: spec.title,
      notes: spec.notes ?? "",
      url: spec.url,
      image: spec.image,
      frames: spec.frames ?? 20,
    });
  } else if (spec.kind === "pyramid") {
    const side = spec.side?.map((note) =>
      note.code ? { ...note, tokens: tokenize(note.text, false) } : note,
    );
    resolved.push({ ...spec, side, notes: spec.notes ?? "", frames: spec.frames ?? 60 });
  } else {
    resolved.push({ ...spec, notes: spec.notes ?? "", frames: spec.frames ?? 60 });
  }
}

// Diffs: when a file comes back changed, show what changed as -/+ lines.
{
  const lastOf = new Map<string, CodeStep>();
  const textOf = (line: Token[]) => line.map((t) => t.text).join("");
  steps.forEach((spec, i) => {
    const step = resolved[i]!;
    if (spec.kind !== "code" || step.kind !== "code") return;
    const key = `${step.group}|${step.file ?? ""}`;
    const prev = lastOf.get(key);
    lastOf.set(key, step);
    if (!prev || step.quiet || step.tints.length > 0 || step.beside) return;
    const before = prev.lines.filter(
      (l) =>
        !prev.diff?.[prev.lines.indexOf(l)] || prev.diff[prev.lines.indexOf(l)]!.kind !== "del",
    );
    const parts = diffArrays(before.map(textOf), step.lines.map(textOf), {
      comparator: (a: string, b: string) => a.trim() === b.trim(),
    });
    const same = parts
      .filter((p) => !p.added && !p.removed)
      .reduce((n, p) => n + p.value.filter((l: string) => l.trim()).length, 0);
    const changes = parts.some(
      (p) => (p.added || p.removed) && p.value.some((l: string) => l.trim()),
    );
    // Only an edit: when most of the code is new, it's a different snippet.
    if (!changes || same < before.filter((l) => textOf(l).trim()).length / 2) return;
    const lines: Token[][] = [];
    const diff: NonNullable<CodeStep["diff"]> = [];
    const remap = new Map<number, number>();
    let b = 0;
    let a = 0;
    for (let k = 0; k < parts.length; k++) {
      const part = parts[k]!;
      if (!part.added && !part.removed) {
        for (let n = 0; n < part.count!; n++)
          (remap.set(a, lines.length), lines.push(step.lines[a++]!), diff.push(null), b++);
      } else if (part.removed) {
        const next = parts[k + 1];
        const rewritten = next?.added && next.count === part.count ? next : undefined;
        const spans: { start: number; end: number }[] = [];
        for (let n = 0; n < part.count!; n++) {
          const old = before[b + n]!;
          if (rewritten) {
            // The part of the line that changed, when it's a small edit.
            const x = textOf(old);
            const y = textOf(step.lines[a + n]!);
            let pre = 0;
            while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
            let suf = 0;
            while (
              suf < x.length - pre &&
              suf < y.length - pre &&
              x[x.length - 1 - suf] === y[y.length - 1 - suf]
            )
              suf++;
            spans.push({ start: pre, end: y.length - suf });
            const small = pre + suf >= Math.max(x.length, y.length) * 0.4;
            void small;
          }
          // Removed lines are only shown when a step asks for them.
          if (spec.showRemoved && textOf(old).trim()) {
            const x = textOf(old);
            const y = rewritten ? textOf(step.lines[a + n]!) : "";
            let pre = 0;
            while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
            let suf = 0;
            while (
              suf < x.length - pre &&
              suf < y.length - pre &&
              x[x.length - 1 - suf] === y[y.length - 1 - suf]
            )
              suf++;
            const cut =
              rewritten && x.length - suf > pre ? { start: pre, end: x.length - suf } : {};
            lines.push(old);
            diff.push({ kind: "del", ...cut });
          }
        }
        b += part.count!;
        if (rewritten) {
          for (let n = 0; n < rewritten.count!; n++) {
            const x = textOf(before[b - part.count! + n]!);
            const y = textOf(step.lines[a]!);
            const { start, end } = spans[n]!;
            const small = y.length - (end - start) >= Math.max(x.length, y.length) * 0.4;
            remap.set(a, lines.length);
            lines.push(step.lines[a++]!);
            diff.push({ kind: "add", ...(small ? { start, end } : {}) });
          }
          k++;
        }
      } else {
        for (let n = 0; n < part.count!; n++) {
          const line = step.lines[a]!;
          remap.set(a++, lines.length);
          lines.push(line);
          diff.push(/[A-Za-z0-9]/.test(textOf(line)) ? { kind: "add" } : null);
        }
      }
    }
    // Everything that points at a line now points at where that line moved.
    const at = (n: number) => remap.get(n) ?? n;
    const available = widthFor.get(step.lines) ?? 1560;
    step.marks = step.marks.map((m) => ({
      ...m,
      line: at(m.line),
      ...(m.toLine !== undefined ? { toLine: at(m.toLine) } : {}),
    }));
    if (step.focus) step.focus = { from: at(step.focus.from), to: at(step.focus.to) };
    if (step.error) step.error = { ...step.error, line: at(step.error.line) };
    step.links = step.links?.map((l) => ({ ...l, from: { ...l.from, line: at(l.from.line) } }));
    step.diagramLinks = step.diagramLinks?.map((l) => ({
      ...l,
      from: { ...l.from, line: at(l.from.line) },
    }));
    step.lines = lines;
    step.diff = diff;
    if (!spec.fontSize) {
      const longest = Math.max(...lines.map((l) => textOf(l).length));
      step.fontSize = Math.min(
        step.fontSize,
        Math.floor(available / (longest * 0.6)),
        Math.floor(780 / (lines.length * 1.55)),
      );
    }
  });
}

// Hand-picked emphasis wins over the automatic diff.
steps.forEach((spec, i) => {
  const step = resolved[i]!;
  if (spec.kind !== "code" || step.kind !== "code" || !spec.emphasize) return;
  step.diff = step.lines.map((line) => {
    const text = line.map((t) => t.text).join("");
    return spec.emphasize!.some((e) => text.includes(e)) ? { kind: "add" as const } : null;
  });
});

// One size per sequence: a snippet keeps its size as panels and marks come and go.
const groupSize = new Map<string, number>();
steps.forEach((spec, i) => {
  const step = resolved[i]!;
  if (spec.kind !== "code" || step.kind !== "code" || spec.fontSize) return;
  groupSize.set(
    step.group,
    Math.min(
      groupSize.get(step.group) ?? Infinity,
      step.fontSize,
      step.beside?.fontSize ?? Infinity,
    ),
  );
});
steps.forEach((spec, i) => {
  const step = resolved[i]!;
  if (spec.kind === "code" && step.kind === "code" && !spec.fontSize) {
    step.fontSize = groupSize.get(step.group)!;
    if (step.beside) step.beside.fontSize = step.fontSize;
  }
  if (step.kind === "code" && step.under) step.under.step.fontSize = step.fontSize;
});
// Side panels in a sequence share one size too, so consecutive panels line up.
const besideSize = new Map<string, number>();
for (const step of resolved) {
  if (step.kind !== "code" || !step.beside) continue;
  besideSize.set(
    step.group,
    Math.min(besideSize.get(step.group) ?? Infinity, step.beside.fontSize),
  );
}
for (const step of resolved) {
  if (step.kind === "code" && step.beside) step.beside.fontSize = besideSize.get(step.group)!;
}

await mkdir(out, { recursive: true });
// A roll slot is lit only on the steps it rolls into or out of, so the eye goes to what changes.
{
  const value = (step: RollStep, k: number) => {
    const slot = step.slots[k]!;
    return step.lines[slot.line]!.map((t) => t.text)
      .join("")
      .slice(slot.start, slot.end);
  };
  for (const [i, step] of resolved.entries()) {
    if (step.kind !== "roll") continue;
    const before = resolved[i - 1];
    const after = resolved[i + 1];
    const prev = before?.kind === "roll" && before.group === step.group ? before : undefined;
    const next = after?.kind === "roll" && after.group === step.group ? after : undefined;
    step.slots = step.slots.map((slot, k) => ({
      ...slot,
      active:
        (!!prev && value(prev, k) !== value(step, k)) ||
        (!!next && value(next, k) !== value(step, k)),
    }));
  }
}

const json: IntroJson = { steps: resolved };
// Images the steps reference (e.g. an aside's photo), served next to intro.json.
await cp(path.join(import.meta.dirname, "assets"), path.join(shared, "assets"), {
  recursive: true,
});
await writeFile(path.join(out, "intro.json"), `${JSON.stringify(json, null, 2)}\n`);
console.log(`✔ ${resolved.length} ${deckName} steps → out/capture/${deckName}/intro.json`);
