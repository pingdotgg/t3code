/**
 * Attribute TypeScript check time and type creation to their source —
 * "which types are making the checker slow, and whose fault are they?"
 *
 * The workspace compiler is tsgo (TS 7), which does NOT support
 * `--generateTrace`, so traces are produced with Strada (TS 5.x) used purely
 * as a measurement instrument against the same project:
 *
 * ```sh
 * # 1. generate a trace (~2.5 min, ~12GB RAM for packages/alchemy)
 * bunx --package typescript@5.9 tsc \
 *   -p packages/alchemy/tsconfig.json \
 *   --noEmit --incremental false --composite false \
 *   --generateTrace /tmp/tstrace
 *
 * # 2. attribute it
 * bun scripts/analyze-type-trace.ts /tmp/tstrace
 * ```
 *
 * Reports, from `trace.json` + a streaming pass over `types.json`:
 *   - check self-time per bucket (src/AWS, src/Cloudflare, core, distilled
 *     lib, effect, node_modules, TS libs) and the top files
 *   - top-level `structuredTypeRelatedTo` relation pairs by time — this is
 *     what exposed the 28.4s `Worker<NormalizedBindings<...>>` vs
 *     `WorkerBindingResource` constraint proof (45% of all check time)
 *   - locationless union/intersection types attributed to their first
 *     member's origin, and the top symbols by types created
 *
 * NOTE: `npx @typescript/analyze-trace` is complementary (per-file hot-spot
 * drill-downs from trace.json) but crashes with "Invalid string length" when
 * given an Effect-scale types.json — this script streams it instead.
 * types.json can exceed 1GB; the stream pass takes ~1 min.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const traceDir = process.argv[2];
if (!traceDir) {
  console.error("usage: bun scripts/analyze-type-trace.ts <traceDir>");
  process.exit(1);
}

const BUCKETS = [
  "(unknown)",
  "packages/alchemy/src/AWS",
  "packages/alchemy/src/Cloudflare",
  "packages/alchemy/src (core)",
  "distilled/*/lib",
  "node_modules/effect",
  "other node_modules",
  "typescript libs",
  "other",
] as const;

// Match by path segment rather than a repo-root prefix so the script works no
// matter which checkout produced the trace. Strada lowercases paths on macOS.
function bucketIdOf(p: string | undefined): number {
  if (!p) return 0;
  const lower = p.toLowerCase();
  if (lower.includes("node_modules/effect/")) return 5;
  if (lower.includes("node_modules/typescript/lib/")) return 7;
  if (lower.includes("node_modules/")) return 6;
  if (lower.includes("packages/alchemy/src/aws/")) return 1;
  if (lower.includes("packages/alchemy/src/cloudflare/")) return 2;
  if (lower.includes("packages/alchemy/src/")) return 3;
  if (/distilled\/packages\/[^/]+\//.test(lower)) return 4;
  return 8;
}

// Strip the absolute prefix before the first recognizable repo-relative
// segment, purely for display.
const rel = (p: string | undefined) => {
  if (!p) return "?";
  const m = p.match(/(?:packages|distilled|node_modules|examples|scripts)\/.*$/);
  return m ? m[0] : p;
};

// ---------- trace.json: check self-time + top-level relation pairs ----------
interface TraceEvent {
  name?: string;
  ph?: string;
  ts: number;
  dur?: number;
  args?: { path?: string; sourceId?: number; targetId?: number };
}

const trace: TraceEvent[] = JSON.parse(
  fs.readFileSync(path.join(traceDir, "trace.json"), "utf8"),
);

const stack: { p: string | undefined; start: number; child: number }[] = [];
const fileSelf = new Map<string, number>();
let totalCheck = 0;
const relEvents: TraceEvent[] = [];
for (const ev of trace) {
  if (!ev?.name) continue;
  if (ev.name === "checkSourceFile") {
    if (ev.ph === "B") {
      stack.push({ p: ev.args?.path, start: ev.ts, child: 0 });
    } else if (ev.ph === "E" && stack.length) {
      const f = stack.pop()!;
      const dur = ev.ts - f.start;
      const self = dur - f.child;
      if (stack.length) stack[stack.length - 1].child += dur;
      fileSelf.set(f.p ?? "?", (fileSelf.get(f.p ?? "?") ?? 0) + self);
      totalCheck += self;
    }
  } else if (ev.name === "structuredTypeRelatedTo" && ev.ph === "X") {
    relEvents.push(ev);
  }
}

// Keep only top-level relation intervals (not nested inside a prior one).
relEvents.sort((a, b) => a.ts - b.ts);
let coverEnd = -1;
const pairTime = new Map<string, number>();
let topLevelRelTotal = 0;
const neededIds = new Set<number>();
for (const ev of relEvents) {
  if (ev.ts >= coverEnd) {
    topLevelRelTotal += ev.dur ?? 0;
    coverEnd = ev.ts + (ev.dur ?? 0);
    const k = `${ev.args!.sourceId}->${ev.args!.targetId}`;
    pairTime.set(k, (pairTime.get(k) ?? 0) + (ev.dur ?? 0));
    neededIds.add(ev.args!.sourceId!);
    neededIds.add(ev.args!.targetId!);
  }
}
const topPairs = [...pairTime.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);

const out: string[] = [];
out.push(
  `== checkSourceFile self-time: ${(totalCheck / 1e6).toFixed(1)}s over ${fileSelf.size} files ==`,
  "",
  "== Check self-time by bucket ==",
);
const bucketTime = new Map<string, number>();
for (const [p, us] of fileSelf) {
  const b = BUCKETS[bucketIdOf(p)];
  bucketTime.set(b, (bucketTime.get(b) ?? 0) + us);
}
for (const [b, us] of [...bucketTime.entries()].sort((a, b) => b[1] - a[1])) {
  out.push(
    `${(us / 1000).toFixed(0).padStart(9)} ms  ${((us / totalCheck) * 100).toFixed(1).padStart(5)}%  ${b}`,
  );
}
out.push("", "== Top 30 files by check self-time ==");
for (const [p, us] of [...fileSelf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
  out.push(`${(us / 1000).toFixed(0).padStart(9)} ms  ${rel(p)}`);
}
out.push(
  "",
  `== Top-level structuredTypeRelatedTo total: ${(topLevelRelTotal / 1e6).toFixed(1)}s ==`,
);

// ---------- types.json: streamed attribution ----------
interface TypeDescriptor {
  id: number;
  symbolName?: string;
  firstDeclaration?: { path?: string; start?: { line: number } };
  location?: { path?: string; line?: number };
  intersectionTypes?: number[];
  unionTypes?: number[];
  flags?: string[];
}

const typesPath = path.join(traceDir, "types.json");
const rl = readline.createInterface({
  input: fs.createReadStream(typesPath, { encoding: "utf8", highWaterMark: 1 << 22 }),
  crlfDelay: Infinity,
});

const MAX = 16_000_000;
const bucketById = new Uint8Array(MAX);
const idInfo = new Map<
  number,
  { sym?: string; path?: string; line?: number; flags?: string }
>();
const compositeByBucket = new Map<string, number>();
const symCount = new Map<string, number>();
const locatedByBucket = new Map<string, number>();
let total = 0;

for await (let line of rl) {
  line = line.trim();
  if (line === "[" || line === "]" || line === "") continue;
  if (line.startsWith("[")) line = line.slice(1);
  if (line.endsWith(",")) line = line.slice(0, -1);
  if (line[0] !== "{") continue;
  let t: TypeDescriptor;
  try {
    t = JSON.parse(line);
  } catch {
    continue;
  }
  total++;
  const decl = t.firstDeclaration ?? t.location;
  const p = decl && ("path" in decl ? decl.path : undefined);
  const lineNo =
    decl && ("start" in decl && decl.start ? decl.start.line : (decl as { line?: number }).line);
  let b = 0;
  if (p) {
    b = bucketIdOf(p);
    locatedByBucket.set(BUCKETS[b], (locatedByBucket.get(BUCKETS[b]) ?? 0) + 1);
    if (t.symbolName) {
      const key = `${t.symbolName} @ ${rel(p)}:${lineNo}`;
      symCount.set(key, (symCount.get(key) ?? 0) + 1);
    }
  } else {
    const members = t.intersectionTypes ?? t.unionTypes;
    if (members) {
      // Attribute a locationless composite to its first non-lib member.
      for (const m of members) {
        if (m > 0 && m < MAX && bucketById[m] !== 0 && bucketById[m] !== 7) {
          b = bucketById[m];
          break;
        }
      }
      if (b === 0) {
        for (const m of members) {
          if (m > 0 && m < MAX && bucketById[m] !== 0) {
            b = bucketById[m];
            break;
          }
        }
      }
      const bn = BUCKETS[b] + (t.intersectionTypes ? " [intersection]" : " [union]");
      compositeByBucket.set(bn, (compositeByBucket.get(bn) ?? 0) + 1);
    }
  }
  if (t.id < MAX) bucketById[t.id] = b;
  if (neededIds.has(t.id)) {
    idInfo.set(t.id, {
      sym: t.symbolName,
      path: p,
      line: lineNo,
      flags: t.flags?.join("|"),
    });
  }
  if (total % 1_000_000 === 0) process.stderr.write(`  ...streamed ${total} types\n`);
}

out.push("", `== ${total} types total; located types by bucket ==`);
for (const [b, c] of [...locatedByBucket.entries()].sort((a, b) => b[1] - a[1])) {
  out.push(`${String(c).padStart(9)}  ${b}`);
}
out.push("", "== Locationless union/intersection types by first member's bucket ==");
for (const [b, c] of [...compositeByBucket.entries()].sort((a, b) => b[1] - a[1])) {
  out.push(`${String(c).padStart(9)}  ${b}`);
}
out.push("", "== Top 30 symbols by types created ==");
for (const [k, c] of [...symCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
  out.push(`${String(c).padStart(9)}  ${k}`);
}
out.push("", "== Top 25 top-level relation pairs by time ==");
const fmt = (id: number) => {
  const i = idInfo.get(id);
  if (!i) return `#${id}`;
  const loc = i.path ? `${rel(i.path)}:${i.line}` : i.flags;
  return `${i.sym ?? "(anon)"} [${i.flags}] ${loc}`;
};
for (const [k, us] of topPairs) {
  const [s, tg] = k.split("->").map(Number);
  out.push(`${(us / 1000).toFixed(0).padStart(8)} ms  ${fmt(s)}`, `             -> ${fmt(tg)}`);
}

const outPath = path.join(traceDir, "attribution.txt");
fs.writeFileSync(outPath, `${out.join("\n")}\n`);
console.log(out.join("\n"));
console.error(`\nwritten to ${outPath}`);
