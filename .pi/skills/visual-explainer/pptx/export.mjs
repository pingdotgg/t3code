#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "node-html-parser";
import pptxgen from "pptxgenjs";

const scriptPath = fileURLToPath(import.meta.url);
const SLIDE_W = 13.333;
const SLIDE_H = 7.5;
const MARGIN_X = 0.65;
const COLORS = {
  bg: "0F172A",
  surface: "172033",
  text: "F8FAFC",
  dim: "CBD5E1",
  accent: "D4A73A",
  border: "334155",
};
const IGNORE_SELECTORS = [
  "script",
  "style",
  "button",
  "svg",
  "canvas",
  "nav",
  ".deck-progress",
  ".deck-dots",
  ".deck-counter",
  ".deck-hint",
  ".deck-nav",
  ".reader-rail",
  ".reader-panel",
  ".outline-overlay",
  ".help-overlay",
  ".zoom-controls",
].join(",");

function usage() {
  return [
    "Usage: visual-explainer-pptx <input.html> [output.pptx]",
    "",
    "Best-effort static export for simple visual-explainer HTML slide decks.",
    "The HTML deck remains the source of truth. Animations, reader navigation, responsive layout, and Mermaid rendering are not preserved.",
  ].join("\n");
}

function textOf(node) {
  return (node?.textContent ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function oneLine(node) {
  return textOf(node).replace(/\s+/g, " ").trim();
}

function unique(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function truncate(value, max) {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function outputPathFor(inputPath, explicitPath) {
  if (explicitPath) return explicitPath;
  return extname(inputPath) ? inputPath.replace(/\.[^.]+$/, ".pptx") : `${inputPath}.pptx`;
}

function cloneCleanSlide(slide) {
  const root = parse(slide.toString());
  const copy = root.querySelector(".slide") ?? root;
  for (const ignored of copy.querySelectorAll(IGNORE_SELECTORS)) {
    if (ignored.classList?.contains("diagram-source")) continue;
    ignored.remove();
  }
  return copy;
}

function firstText(slide, selectors) {
  for (const selector of selectors) {
    const value = oneLine(slide.querySelector(selector));
    if (value) return value;
  }
  return "";
}

function extractTables(slide) {
  const tables = [];
  for (const table of slide.querySelectorAll("table")) {
    const rows = [];
    for (const tr of table.querySelectorAll("tr")) {
      const cells = tr.querySelectorAll("th,td").map((cell) => truncate(oneLine(cell), 90));
      if (cells.some(Boolean)) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
    table.remove();
  }
  return tables;
}

function extractCodeBlocks(slide) {
  const blocks = [];
  for (const code of slide.querySelectorAll("pre")) {
    const text = textOf(code);
    if (text) blocks.push(truncate(text, 850));
    code.remove();
  }
  return blocks;
}

function extractDiagramPlaceholders(slide) {
  const diagrams = [];
  for (const diagram of slide.querySelectorAll(".mermaid, .diagram-source")) {
    const text = textOf(diagram);
    diagrams.push(
      text
        ? `Diagram source: ${truncate(text.replace(/\s+/g, " "), 220)}`
        : "Diagram placeholder: render from the HTML deck for full fidelity.",
    );
    diagram.remove();
  }
  return diagrams;
}

function extractSlide(slide, index) {
  const clean = cloneCleanSlide(slide);
  const tables = extractTables(clean);
  const diagrams = extractDiagramPlaceholders(clean);
  const codeBlocks = extractCodeBlocks(clean);
  const headings = clean.querySelectorAll("h1,h2,h3,h4").map(oneLine).filter(Boolean);
  const title = headings[0] || `Slide ${index + 1}`;
  const subtitle = firstText(clean, [".slide__subtitle", ".subtitle", ".eyebrow", ".kicker"]);
  const listItems = clean
    .querySelectorAll("li")
    .map((item) => truncate(oneLine(item), 160))
    .filter(Boolean);
  const paragraphs = clean
    .querySelectorAll("p")
    .map((paragraph) => truncate(oneLine(paragraph), 220))
    .filter(Boolean);
  const cardTexts = clean
    .querySelectorAll("article, aside, .card, .panel, .metric-card")
    .map((card) => truncate(oneLine(card), 220))
    .filter(Boolean);

  const body = unique(
    [...diagrams, ...listItems, ...cardTexts, ...paragraphs].filter(
      (value) => value !== title && value !== subtitle,
    ),
  );

  return {
    title: truncate(title, 140),
    subtitle: truncate(subtitle, 180),
    body: body.slice(0, 10),
    tables: tables.slice(0, 2),
    codeBlocks: codeBlocks.slice(0, 2),
  };
}

function findSlideSections(root) {
  const sections = root.querySelectorAll("section.slide");
  if (sections.length) return sections;
  return root
    .querySelectorAll(".slide")
    .filter((node) => node.querySelector("h1,h2,h3,h4,p,li,table,pre"));
}

function addFooter(slide, index, total) {
  slide.addShape("line", {
    x: MARGIN_X,
    y: 6.95,
    w: SLIDE_W - MARGIN_X * 2,
    h: 0,
    line: { color: COLORS.border, pt: 1 },
  });
  slide.addText(`Best-effort PPTX export · ${index + 1}/${total}`, {
    x: MARGIN_X,
    y: 7.05,
    w: 7.5,
    h: 0.25,
    fontFace: "Aptos",
    fontSize: 8,
    color: COLORS.dim,
    margin: 0,
  });
}

function addTitle(slide, data) {
  slide.addText(data.title, {
    x: MARGIN_X,
    y: 0.45,
    w: SLIDE_W - MARGIN_X * 2,
    h: 0.72,
    fontFace: "Aptos Display",
    fontSize: data.title.length > 72 ? 24 : 30,
    bold: true,
    color: COLORS.text,
    margin: 0,
    fit: "shrink",
  });
  if (data.subtitle) {
    slide.addText(data.subtitle, {
      x: MARGIN_X,
      y: 1.22,
      w: SLIDE_W - MARGIN_X * 2,
      h: 0.35,
      fontFace: "Aptos",
      fontSize: 12,
      color: COLORS.dim,
      margin: 0,
      fit: "shrink",
    });
  }
}

function addBody(slide, items, startY, maxHeight) {
  if (!items.length) return startY;
  slide.addText(items.map((item) => `• ${item}`).join("\n"), {
    x: MARGIN_X,
    y: startY,
    w: 5.85,
    h: maxHeight,
    fontFace: "Aptos",
    fontSize: items.length > 7 ? 12 : 14,
    color: COLORS.text,
    margin: 0.05,
    fit: "shrink",
  });
  return startY + maxHeight + 0.2;
}

function addTables(slide, tables, startY) {
  if (!tables.length) return;
  const table = tables[0].slice(0, 9).map((row) => row.slice(0, 5));
  const colCount = Math.max(...table.map((row) => row.length));
  const rows = table.map((row) => Array.from({ length: colCount }, (_, index) => row[index] ?? ""));
  slide.addTable(rows, {
    x: 6.85,
    y: startY,
    w: 5.8,
    h: 3.9,
    colW: Array.from({ length: colCount }, () => 5.8 / colCount),
    border: { type: "solid", pt: 0.5, color: COLORS.border },
    color: COLORS.text,
    fontFace: "Aptos",
    fontSize: rows.length > 6 || colCount > 3 ? 8 : 10,
    margin: 0.05,
    valign: "top",
  });
}

function addCode(slide, codeBlocks, startY) {
  if (!codeBlocks.length) return;
  slide.addText(codeBlocks[0], {
    x: 6.85,
    y: startY,
    w: 5.8,
    h: 3.9,
    fontFace: "Courier New",
    fontSize: 8,
    color: COLORS.text,
    fill: { color: COLORS.surface, transparency: 0 },
    margin: 0.12,
    fit: "shrink",
  });
}

function addFallbackPanel(slide) {
  slide.addText("Static export", {
    x: 6.85,
    y: 1.75,
    w: 5.8,
    h: 0.35,
    fontFace: "Aptos",
    fontSize: 12,
    bold: true,
    color: COLORS.accent,
    margin: 0,
  });
  slide.addText(
    "Use the HTML deck for animations, Mermaid rendering, reader navigation, custom fonts, and responsive layout.",
    {
      x: 6.85,
      y: 2.15,
      w: 5.8,
      h: 1.2,
      fontFace: "Aptos",
      fontSize: 13,
      color: COLORS.dim,
      margin: 0,
      fit: "shrink",
    },
  );
}

function renderPptx(slides, outputPath) {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "visual-explainer";
  pptx.company = "visual-explainer";
  pptx.subject = "Best-effort static export from a visual-explainer HTML slide deck";
  pptx.title = slides[0]?.title ?? "Visual Explainer Deck";
  pptx.lang = "en-US";
  pptx.theme = {
    headFontFace: "Aptos Display",
    bodyFontFace: "Aptos",
    lang: "en-US",
  };

  slides.forEach((data, index) => {
    const slide = pptx.addSlide();
    slide.background = { color: COLORS.bg };
    slide.addShape("rect", {
      x: 0,
      y: 0,
      w: SLIDE_W,
      h: SLIDE_H,
      fill: { color: COLORS.bg },
      line: { color: COLORS.bg },
    });
    slide.addShape("rect", {
      x: 0,
      y: 0,
      w: 0.16,
      h: SLIDE_H,
      fill: { color: COLORS.accent },
      line: { color: COLORS.accent },
    });
    addTitle(slide, data);
    addBody(slide, data.body, 1.75, 4.8);
    if (data.tables.length) addTables(slide, data.tables, 1.75);
    else if (data.codeBlocks.length) addCode(slide, data.codeBlocks, 1.75);
    else addFallbackPanel(slide);
    addFooter(slide, index, slides.length);
  });

  return pptx.writeFile({ fileName: outputPath });
}

export async function exportPptx(inputPath, explicitOutputPath) {
  if (!inputPath) throw new Error("input.html is required");
  const outputPath = outputPathFor(inputPath, explicitOutputPath);
  const html = await readFile(inputPath, "utf8");
  const root = parse(html);
  const slideSections = findSlideSections(root);
  if (!slideSections.length)
    throw new Error(
      'No slide sections found. Best-effort PPTX export expects a visual-explainer HTML deck with <section class="slide"> elements.',
    );
  const slides = slideSections
    .map(extractSlide)
    .filter(
      (slide) => slide.title || slide.body.length || slide.tables.length || slide.codeBlocks.length,
    );
  if (!slides.length) throw new Error("No exportable slide content found.");
  await mkdir(dirname(outputPath), { recursive: true });
  await renderPptx(slides, outputPath);
  return { inputPath, outputPath, slideCount: slides.length };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const [inputPath, outputPath] = args;
  const result = await exportPptx(inputPath, outputPath);
  process.stdout.write(
    `Wrote ${result.outputPath}\nSlides: ${result.slideCount}\nBest-effort static export. Use the HTML deck for full fidelity.\n`,
  );
}

function isMainModule() {
  return Boolean(process.argv[1] && realpathSync(process.argv[1]) === scriptPath);
}

if (isMainModule()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
