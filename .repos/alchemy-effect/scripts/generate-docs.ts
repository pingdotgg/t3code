import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  chooseCanonicalEntries,
  createProject,
  discoverSourceFiles,
} from "./generate-docs/discovery.ts";
import { buildFileDoc } from "./generate-docs/model.ts";
import { renderFileDoc, syntheticIndexes } from "./generate-docs/render.ts";
import { docsRoot } from "./generate-docs/utils.ts";

async function writeFile(targetPath: string, content: string) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${content.trimEnd()}\n`, "utf8");
}

async function main() {
  const project = createProject();
  const sourceFiles = discoverSourceFiles(project);
  const { entries, duplicates } = chooseCanonicalEntries(sourceFiles);

  await fs.rm(docsRoot, { recursive: true, force: true });
  await fs.mkdir(docsRoot, { recursive: true });

  for (const entry of entries) {
    const fileDoc = buildFileDoc(project, entry, entries);
    await writeFile(entry.outputPath, renderFileDoc(fileDoc));
  }

  for (const synthetic of syntheticIndexes(entries)) {
    await writeFile(synthetic.outputPath, synthetic.content);
  }

  console.log(`Generated ${entries.length} file docs.`);
  if (duplicates.length > 0) {
    console.log("Ignored case-colliding duplicates:");
    for (const duplicate of duplicates) {
      console.log(`- kept ${duplicate.canonical}`);
      for (const ignored of duplicate.ignored) {
        console.log(`  - ignored ${ignored}`);
      }
    }
  }
}

await main();
