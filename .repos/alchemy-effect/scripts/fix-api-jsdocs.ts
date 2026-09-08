import * as fs from "node:fs/promises";
import * as path from "node:path";

const roots = [
  path.join(import.meta.dir, "../packages/alchemy/src"),
  path.join(import.meta.dir, "../packages/better-auth/src"),
];

const pageTag = /^\s*\*\s+@(resource|binding|layer)\b/;
const generatorTag =
  /^\s*\*\s+@(resource|binding|layer|product|category|group|label|provides|peer)\b/;
const sectionTag = /^(\s*\*\s+)@section(?:\s+(.*))?$/;
const exampleTag = /^(\s*\*\s+)@example(?:\s+(.*))?$/;

async function sourceFiles(root: string): Promise<string[]> {
  const entries = (await fs.readdir(root, { recursive: true })) as string[];
  return entries
    .filter((entry) => /\.[cm]?tsx?$/.test(entry) && !entry.endsWith(".d.ts"))
    .map((entry) => path.join(root, entry));
}

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
        body.push(
          `${example[1]}**Example:** ${example[2]?.trim() || "Example"}`,
        );
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

const check = process.argv.includes("--check");
const changedFiles: string[] = [];

for (const root of roots) {
  for (const file of await sourceFiles(root)) {
    const source = await fs.readFile(file, "utf8");
    const fixed = source.replace(/\/\*\*[\s\S]*?\*\//g, fixBlock);
    if (fixed === source) continue;
    changedFiles.push(path.relative(path.join(import.meta.dir, ".."), file));
    if (!check) await fs.writeFile(file, fixed);
  }
}

if (check && changedFiles.length > 0) {
  console.error(
    `${changedFiles.length} files contain API JSDocs that need fixing:\n${changedFiles.map((file) => `- ${file}`).join("\n")}\n\nRun \`pnpm docs:fix-jsdoc\` to fix them.`,
  );
  process.exitCode = 1;
} else {
  console.log(
    check
      ? "All API JSDocs are normalized."
      : `Normalized API JSDocs in ${changedFiles.length} files.`,
  );
}
