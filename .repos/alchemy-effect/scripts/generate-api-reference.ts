import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  Node,
  Project,
  SyntaxKind,
  type JSDoc,
  type SourceFile,
} from "ts-morph";

const websiteRoot = path.join(import.meta.dir, "../website");

const config = {
  srcRoot: path.join(import.meta.dir, "../packages/alchemy/src"),
  outRoot: path.join(websiteRoot, "src/content/docs/providers"),
  tsConfig: path.join(import.meta.dir, "../packages/alchemy/tsconfig.json"),
  excludeFile(baseName: string): boolean {
    if (baseName === "index.ts") return true;
    if (/^[a-z]/.test(baseName)) return true;
    return false;
  },
};

interface FileEntry {
  relativePath: string;
  absolutePath: string;
  outputPath: string;
}

interface ExampleBlock {
  title: string;
  body: string;
}

interface ExampleSection {
  title: string;
  description: string;
  examples: ExampleBlock[];
}

interface PageDoc {
  title: string;
  relativePath: string;
  summary: string;
  sections: ExampleSection[];
}

const normalizeSlashes = (value: string) => value.split(path.sep).join("/");

async function discoverFiles(): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  const topLevelEntries = await fs.readdir(config.srcRoot, {
    withFileTypes: true,
  });
  const dirs = topLevelEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const dir of dirs) {
    const dirPath = path.join(config.srcRoot, dir);
    let files: string[];
    try {
      files = (await fs.readdir(dirPath, { recursive: true })) as string[];
    } catch {
      continue;
    }

    for (const file of files) {
      const baseName = path.basename(file);
      if (!baseName.endsWith(".ts") && !baseName.endsWith(".tsx")) continue;
      if (baseName.endsWith(".d.ts")) continue;
      if (config.excludeFile(baseName)) continue;

      const relativePath = path.join(dir, file);
      const parts = normalizeSlashes(relativePath).split("/");
      const cloud = parts[0];
      const service = parts.length >= 3 ? parts[1] : undefined;
      const resource = path.basename(file, path.extname(file));

      let outputRelative: string;
      if (cloud === "Cloudflare") {
        outputRelative = path.join(cloud, `${resource}.md`);
      } else if (service) {
        outputRelative = path.join(cloud, service, `${resource}.md`);
      } else {
        outputRelative = path.join(cloud, `${resource}.md`);
      }

      entries.push({
        relativePath,
        absolutePath: path.join(config.srcRoot, relativePath),
        outputPath: path.join(config.outRoot, outputRelative),
      });
    }
  }

  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return entries;
}

function getJsDocBlocks(node: Node): JSDoc[] {
  const getter = (node as Node & { getJsDocs?: () => JSDoc[] }).getJsDocs;
  return getter ? getter.call(node) : [];
}

function cleanDocComment(raw: string): string {
  return raw
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n");
}

interface ParsedJSDoc {
  summary: string;
  sections: ExampleSection[];
  hasResourceTag: boolean;
  hasBindingTag: boolean;
}

function parseJSDoc(node: Node): ParsedJSDoc {
  const docs = getJsDocBlocks(node);
  if (docs.length === 0) {
    return {
      summary: "",
      sections: [],
      hasResourceTag: false,
      hasBindingTag: false,
    };
  }

  const clean = cleanDocComment(docs.map((doc) => doc.getText()).join("\n"));
  const lines = clean.split("\n");

  const summaryLines: string[] = [];
  const sections: ExampleSection[] = [];
  let hasResourceTag = false;
  let hasBindingTag = false;
  let sawTag = false;
  let currentSection: ExampleSection | undefined;
  let currentExample: ExampleBlock | undefined;

  let sectionDescLines: string[] = [];
  let collectingSectionDesc = false;

  const flushExample = () => {
    if (!currentExample) return;
    currentExample.body = currentExample.body.trim();
    if (!currentSection) {
      currentSection = { title: "Examples", description: "", examples: [] };
      sections.push(currentSection);
    }
    currentSection.examples.push(currentExample);
    currentExample = undefined;
  };

  const flushSectionDesc = () => {
    if (currentSection && sectionDescLines.length > 0) {
      currentSection.description = sectionDescLines.join("\n").trim();
    }
    sectionDescLines = [];
    collectingSectionDesc = false;
  };

  for (const line of lines) {
    const tag = line.trimEnd().match(/^@(\w+)\s*(.*)$/);
    if (tag) {
      sawTag = true;
      const [, name, rest] = tag;
      const value = (rest ?? "").trim();
      switch (name) {
        case "resource":
          hasResourceTag = true;
          break;
        case "binding":
          hasBindingTag = true;
          break;
        case "section":
          flushExample();
          flushSectionDesc();
          currentSection = {
            title: value || "Examples",
            description: "",
            examples: [],
          };
          sections.push(currentSection);
          collectingSectionDesc = true;
          break;
        case "example":
          flushSectionDesc();
          flushExample();
          currentExample = { title: value || "Example", body: "" };
          break;
      }
      continue;
    }

    if (!sawTag) {
      summaryLines.push(line);
      continue;
    }

    if (currentExample) {
      currentExample.body += `${line}\n`;
    } else if (collectingSectionDesc) {
      sectionDescLines.push(line);
    }
  }

  flushSectionDesc();
  flushExample();

  return {
    summary: summaryLines.join("\n").trim(),
    sections,
    hasResourceTag,
    hasBindingTag,
  };
}

function findPrimaryJSDoc(sourceFile: SourceFile): ParsedJSDoc {
  for (const decl of sourceFile.getVariableDeclarations()) {
    if (!decl.isExported()) continue;
    const init = decl.getInitializerIfKind(SyntaxKind.CallExpression);
    const expr = init?.getExpression().getText();
    if (expr === "Resource" || expr === "Host" || expr === "Platform") {
      const stmt = decl.getVariableStatement();
      if (stmt) {
        const jsdoc = parseJSDoc(stmt);
        if (jsdoc.summary || jsdoc.sections.length > 0 || jsdoc.hasResourceTag)
          return jsdoc;
      }
    }
  }

  for (const cls of sourceFile.getClasses()) {
    if (!cls.isExported()) continue;
    const jsdoc = parseJSDoc(cls);
    if (
      jsdoc.hasResourceTag ||
      jsdoc.hasBindingTag ||
      jsdoc.sections.length > 0
    )
      return jsdoc;
    if (jsdoc.summary) return jsdoc;
  }

  let firstWithSummary: ParsedJSDoc | undefined;
  for (const stmt of sourceFile.getStatements()) {
    if (Node.isExportable(stmt) && stmt.isExported()) {
      const jsdoc = parseJSDoc(stmt);
      if (
        jsdoc.hasResourceTag ||
        jsdoc.hasBindingTag ||
        jsdoc.sections.length > 0
      )
        return jsdoc;
      if (!firstWithSummary && jsdoc.summary) firstWithSummary = jsdoc;
    }
  }

  if (firstWithSummary) return firstWithSummary;

  const rawJSDocBlocks = sourceFile.getFullText().match(/\/\*\*[\s\S]*?\*\//g);
  if (rawJSDocBlocks) {
    for (const block of rawJSDocBlocks) {
      if (
        block.includes("@section") ||
        block.includes("@resource") ||
        block.includes("@binding")
      ) {
        const clean = cleanDocComment(block);
        const lines = clean.split("\n");
        const summaryLines: string[] = [];
        const sections: ExampleSection[] = [];
        let hasResourceTag = false;
        let hasBindingTag = false;
        let sawTag = false;
        let currentSection: ExampleSection | undefined;
        let currentExample: ExampleBlock | undefined;
        let sectionDescLines: string[] = [];
        let collectingSectionDesc = false;

        const flushExample = () => {
          if (!currentExample) return;
          currentExample.body = currentExample.body.trim();
          if (!currentSection) {
            currentSection = {
              title: "Examples",
              description: "",
              examples: [],
            };
            sections.push(currentSection);
          }
          currentSection.examples.push(currentExample);
          currentExample = undefined;
        };

        const flushSectionDesc = () => {
          if (currentSection && sectionDescLines.length > 0) {
            currentSection.description = sectionDescLines.join("\n").trim();
          }
          sectionDescLines = [];
          collectingSectionDesc = false;
        };

        for (const line of lines) {
          const tag = line.trimEnd().match(/^@(\w+)\s*(.*)$/);
          if (tag) {
            sawTag = true;
            const [, name, rest] = tag;
            const value = (rest ?? "").trim();
            switch (name) {
              case "resource":
                hasResourceTag = true;
                break;
              case "binding":
                hasBindingTag = true;
                break;
              case "section":
                flushExample();
                flushSectionDesc();
                currentSection = {
                  title: value || "Examples",
                  description: "",
                  examples: [],
                };
                sections.push(currentSection);
                collectingSectionDesc = true;
                break;
              case "example":
                flushSectionDesc();
                flushExample();
                currentExample = { title: value || "Example", body: "" };
                break;
            }
            continue;
          }
          if (!sawTag) {
            summaryLines.push(line);
            continue;
          }
          if (currentExample) {
            currentExample.body += `${line}\n`;
          } else if (collectingSectionDesc) {
            sectionDescLines.push(line);
          }
        }
        flushSectionDesc();
        flushExample();

        const summary = summaryLines.join("\n").trim();
        if (summary || sections.length > 0) {
          return { summary, sections, hasResourceTag, hasBindingTag };
        }
      }
    }
  }

  return {
    summary: "",
    sections: [],
    hasResourceTag: false,
    hasBindingTag: false,
  };
}

function isResourceFile(sourceFile: SourceFile): boolean {
  const fullText = sourceFile.getFullText();

  if (/^\s*\*\s*@internal\s*$/m.test(fullText)) {
    const blocks = fullText.match(/\/\*\*[\s\S]*?\*\//g) || [];
    for (const block of blocks) {
      if (!/^\s*\*\s*@internal\s*$/m.test(block)) continue;
      const end = fullText.indexOf(block) + block.length;
      const after = fullText.slice(end).trimStart();
      if (after.startsWith("export ")) return false;
    }
  }

  if (fullText.includes("@resource") || fullText.includes("@binding"))
    return true;

  const text = sourceFile.getFullText();
  if (text.includes("Binding.Service<") || text.includes("Binding.Policy<")) {
    if (
      !text.includes("= Resource<") &&
      !text.includes("extends Resource<") &&
      !text.includes("= Host<") &&
      !text.includes("extends Host<") &&
      !text.includes("Platform(")
    ) {
      return false;
    }
  }

  for (const decl of sourceFile.getVariableDeclarations()) {
    if (!decl.isExported()) continue;
    const init = decl.getInitializerIfKind(SyntaxKind.CallExpression);
    if (!init) continue;
    const expr = init.getExpression().getText();
    if (expr === "Resource" || expr === "Host" || expr === "Platform")
      return true;
    const innerCall = init.getExpression();
    if (Node.isCallExpression(innerCall)) {
      const innerExpr = innerCall.getExpression().getText();
      if (innerExpr === "Resource" || innerExpr === "Host") return true;
    }
  }
  for (const iface of sourceFile.getInterfaces()) {
    if (!iface.isExported()) continue;
    const hasResourceHeritage = iface
      .getHeritageClauses()
      .flatMap((clause) => clause.getTypeNodes())
      .some((typeNode) => {
        const expr = typeNode.getExpression().getText();
        return expr === "Resource" || expr === "Host";
      });
    if (hasResourceHeritage) return true;
  }
  for (const typeAlias of sourceFile.getTypeAliases()) {
    if (!typeAlias.isExported()) continue;
    const typeText = typeAlias.getTypeNode()?.getText() ?? "";
    if (typeText.startsWith("Resource<") || typeText.startsWith("Host<")) {
      return true;
    }
  }
  return false;
}

function parseFile(sourceFile: SourceFile, relativePath: string): PageDoc {
  const baseName = path.basename(relativePath, path.extname(relativePath));
  const primary = findPrimaryJSDoc(sourceFile);

  return {
    title: baseName,
    relativePath,
    summary: primary.summary,
    sections: primary.sections,
  };
}

function yamlString(value: string): string {
  if (/[\n:"{}[\],&*?|>!%@`#]/.test(value) || value.trim() !== value) {
    return JSON.stringify(value);
  }
  return value;
}

function firstParagraph(value: string): string {
  const idx = value.indexOf("\n\n");
  const para = idx === -1 ? value : value.slice(0, idx);
  return para.replace(/\s+/g, " ").trim();
}

function renderPageBody(doc: PageDoc): string {
  const parts: string[] = [];

  if (doc.summary) {
    parts.push(doc.summary);
  }

  for (const section of doc.sections) {
    const secParts = [`## ${section.title}`];
    if (section.description) {
      secParts.push(section.description);
    }
    for (const example of section.examples) {
      if (section.examples.length > 1) {
        secParts.push(`**${example.title}**`);
      }
      secParts.push(example.body);
    }
    parts.push(secParts.join("\n\n"));
  }

  return parts.join("\n\n");
}

function renderPage(doc: PageDoc): string {
  const sourcePath = `src/${normalizeSlashes(doc.relativePath)}`;
  const description =
    firstParagraph(doc.summary) || `API reference for ${doc.title}`;
  const frontmatter = [
    "---",
    `title: ${yamlString(doc.title)}`,
    `description: ${yamlString(description)}`,
    "---",
  ].join("\n");

  const sourceBlock = `> **Source:** \`${sourcePath}\``;
  const body = renderPageBody(doc).trim();

  if (body) {
    return `${frontmatter}\n\n${sourceBlock}\n\n${body}\n`;
  }
  return `${frontmatter}\n\n${sourceBlock}\n`;
}

async function main() {
  const entries = await discoverFiles();
  console.log(`Discovered ${entries.length} source files.`);

  const project = new Project({
    tsConfigFilePath: config.tsConfig,
    skipFileDependencyResolution: true,
  });

  await fs.rm(config.outRoot, { recursive: true, force: true });
  await fs.mkdir(config.outRoot, { recursive: true });

  const resourceEntries: FileEntry[] = [];
  for (const entry of entries) {
    const sourceFile = project.getSourceFile(entry.absolutePath);
    if (!sourceFile) {
      console.warn(`  skipped: ${entry.relativePath}`);
      continue;
    }
    if (!isResourceFile(sourceFile)) continue;
    resourceEntries.push(entry);
  }

  console.log(
    `Filtered to ${resourceEntries.length} documented files (excluded ${entries.length - resourceEntries.length} unannotated files).`,
  );

  let written = 0;
  for (const entry of resourceEntries) {
    const sourceFile = project.getSourceFile(entry.absolutePath)!;
    const doc = parseFile(sourceFile, entry.relativePath);

    await fs.mkdir(path.dirname(entry.outputPath), { recursive: true });
    await fs.writeFile(entry.outputPath, renderPage(doc), "utf8");

    written++;
  }

  console.log(
    `Done. Wrote ${written} resource pages to ${normalizeSlashes(path.relative(path.join(import.meta.dir, ".."), config.outRoot))}.`,
  );
}

await main();
