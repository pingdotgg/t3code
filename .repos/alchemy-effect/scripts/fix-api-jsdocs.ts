// Normalizes API-generator JSDoc in package sources: moves the generator
// metadata tags (`@resource`, `@product`, …) to the end of the block and
// rewrites legacy `@section` / `@example` tags into `###` / `**Example:**`.
//
// Usage: node scripts/fix-api-jsdocs.ts [--check]
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Command, Flag } from "effect/cli";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Runtime from "effect/Runtime";

/** Packages whose `src/` carries API-generator JSDoc. */
const packages = [
  "alchemy",
  "better-auth",
  "git",
  "drizzle",
  "acme",
  "axiom",
  "doppler",
  "infisical",
  "turso",
  "planetscale",
  "neon",
  "prisma",
  "hetzner",
  "railway",
  "fly",
  "github",
  "stripe",
  "cloudflare",
  "gcp",
  "aws",
  "domain",
  "kubernetes",
  "docker",
  "redis",
  "sql",
];

class UnnormalizedJsdocs extends Data.TaggedError("UnnormalizedJsdocs")<{
  readonly files: ReadonlyArray<string>;
}> {
  // Already reported on stderr; only set the exit code.
  readonly [Runtime.errorReported] = false;
}

const pageTag = /^\s*\*\s+@(resource|binding|layer|primitive)\b/;
const generatorTag =
  /^\s*\*\s+@(resource|binding|layer|primitive|product|category|group|label|title|provides|peer)\b/;
const sectionTag = /^(\s*\*\s+)@section(?:\s+(.*))?$/;
const exampleTag = /^(\s*\*\s+)@example(?:\s+(.*))?$/;

function fixBlock(block: string): string {
  const lines = block.split("\n");
  const isPage = lines.some((line) => pageTag.test(line));
  const hasSections = lines.some((line) => sectionTag.test(line));
  if (!isPage && !hasSections) return block;

  const metadata: string[] = [];
  const body: string[] = [];
  let insideFence = false;

  for (const line of lines) {
    if (
      line
        .trim()
        .replace(/^\*\s?/, "")
        .startsWith("```")
    ) {
      insideFence = !insideFence;
    }

    if (isPage && !insideFence && generatorTag.test(line)) {
      metadata.push(line);
      continue;
    }

    if (!insideFence) {
      const section = line.match(sectionTag);
      if (section) {
        body.push(`${section[1]}### ${section[2]?.trim() || "Examples"}`);
        continue;
      }

      const example = line.match(exampleTag);
      if (example) {
        body.push(`${example[1]}**Example:** ${example[2]?.trim() || "Example"}`);
        continue;
      }
    }

    body.push(line);
  }

  const close = body.pop();
  if (close === undefined || !close.trim().endsWith("*/")) return block;

  while (body.at(-1)?.trim() === "*") body.pop();
  const commentPrefix = metadata[0]?.match(/^(\s*\*)/)?.[1];
  if (body.length > 1 && commentPrefix) body.push(commentPrefix);
  body.push(...metadata, close);
  return body.join("\n");
}

const sourceFiles = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(root, { recursive: true });
  return entries
    .filter((entry) => /\.[cm]?tsx?$/.test(entry) && !entry.endsWith(".d.ts"))
    .map((entry) => path.join(root, entry));
});

const command = Command.make(
  "fix-api-jsdocs",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Only report files that need fixing; exit 1 if any do"),
    ),
  },
  Effect.fn(function* ({ check }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const changedFiles: string[] = [];

    for (const pkg of packages) {
      for (const file of yield* sourceFiles(path.join(repoRoot, "packages", pkg, "src"))) {
        const source = yield* fs.readFileString(file);
        const fixed = source.replace(/\/\*\*[\s\S]*?\*\//g, fixBlock);
        if (fixed === source) continue;
        changedFiles.push(path.relative(repoRoot, file));
        if (!check) yield* fs.writeFileString(file, fixed);
      }
    }

    if (check && changedFiles.length > 0) {
      yield* Console.error(
        `${changedFiles.length} files contain API JSDocs that need fixing:\n${changedFiles.map((file) => `- ${file}`).join("\n")}\n\nRun \`pnpm docs:fix-jsdoc\` to fix them.`,
      );
      return yield* new UnnormalizedJsdocs({ files: changedFiles });
    }
    yield* Console.log(
      check
        ? "All API JSDocs are normalized."
        : `Normalized API JSDocs in ${changedFiles.length} files.`,
    );
  }),
).pipe(Command.withDescription("Normalize API-generator JSDoc blocks in package sources"));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
