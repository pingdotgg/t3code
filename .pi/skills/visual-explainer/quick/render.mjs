#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const quickDir = dirname(fileURLToPath(import.meta.url));
const tones = new Set(["neutral", "accent", "positive", "warning", "danger", "info"]);
const severities = new Set(["low", "medium", "high", "critical"]);
const fileStatuses = new Set(["added", "modified", "deleted", "reviewed", "planned"]);
const stepStatuses = new Set(["done", "current", "next", "blocked"]);
const topKeys = new Set(["title", "subtitle", "summary", "sections"]);
const sectionKeys = new Set([
  "title",
  "subtitle",
  "summary",
  "tone",
  "cards",
  "table",
  "risks",
  "files",
  "steps",
  "flow",
  "callouts",
  "evidence",
]);
const standardFavicon =
  "<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230f172a'/%3E%3Cpath d='M18 40V24l14-8 14 8v16l-14 8-14-8Z' fill='none' stroke='%23fbbf24' stroke-width='4' stroke-linejoin='round'/%3E%3Ccircle cx='32' cy='32' r='5' fill='%2338bdf8'/%3E%3C/svg%3E\">";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value))
    if (!allowed.has(key)) errors.push(`${path}.${key} is not supported`);
}

function checkString(value, path, errors, required = false) {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || (required && !value.trim()))
    errors.push(`${path} must be ${required ? "a non-empty" : "a"} string`);
}

function checkStringArray(value, path, errors, min = 0) {
  if (
    !Array.isArray(value) ||
    value.length < min ||
    !value.every((item) => typeof item === "string")
  ) {
    errors.push(`${path} must be an array of strings${min ? ` with at least ${min} item` : ""}`);
  }
}

function checkTone(value, path, errors) {
  if (value !== undefined && (typeof value !== "string" || !tones.has(value)))
    errors.push(`${path} must be neutral, accent, positive, warning, danger, or info`);
}

function checkObjectArray(value, path, errors, allowed, required, validate) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path} must be a non-empty array`);
    return;
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${itemPath} must be an object`);
      return;
    }
    checkKeys(item, allowed, itemPath, errors);
    required.forEach((key) => checkString(item[key], `${itemPath}.${key}`, errors, true));
    validate(item, itemPath, errors);
  });
}

export function validateQuickSpec(value) {
  const errors = [];
  if (!isRecord(value)) return ["spec must be an object"];
  checkKeys(value, topKeys, "spec", errors);
  checkString(value.title, "spec.title", errors, true);
  checkString(value.subtitle, "spec.subtitle", errors);
  checkString(value.summary, "spec.summary", errors);
  if (!Array.isArray(value.sections) || value.sections.length === 0) {
    errors.push("spec.sections must be a non-empty array");
    return errors;
  }

  value.sections.forEach((section, index) => {
    const path = `spec.sections[${index}]`;
    if (!isRecord(section)) {
      errors.push(`${path} must be an object`);
      return;
    }
    checkKeys(section, sectionKeys, path, errors);
    checkString(section.title, `${path}.title`, errors, true);
    checkString(section.subtitle, `${path}.subtitle`, errors);
    checkString(section.summary, `${path}.summary`, errors);
    checkTone(section.tone, `${path}.tone`, errors);

    if (section.cards !== undefined)
      checkObjectArray(
        section.cards,
        `${path}.cards`,
        errors,
        new Set(["title", "body", "meta", "tone"]),
        ["title"],
        (item, itemPath) => {
          checkString(item.body, `${itemPath}.body`, errors);
          if (item.meta !== undefined) checkStringArray(item.meta, `${itemPath}.meta`, errors);
          checkTone(item.tone, `${itemPath}.tone`, errors);
        },
      );

    if (section.table !== undefined) {
      if (!isRecord(section.table)) errors.push(`${path}.table must be an object`);
      else {
        checkKeys(section.table, new Set(["caption", "columns", "rows"]), `${path}.table`, errors);
        checkString(section.table.caption, `${path}.table.caption`, errors);
        checkStringArray(section.table.columns, `${path}.table.columns`, errors, 1);
        if (!Array.isArray(section.table.rows)) errors.push(`${path}.table.rows must be an array`);
        else
          section.table.rows.forEach((row, rowIndex) => {
            checkStringArray(row, `${path}.table.rows[${rowIndex}]`, errors);
            if (
              Array.isArray(section.table.columns) &&
              Array.isArray(row) &&
              row.length !== section.table.columns.length
            )
              errors.push(`${path}.table.rows[${rowIndex}] must match the column count`);
          });
      }
    }

    if (section.risks !== undefined)
      checkObjectArray(
        section.risks,
        `${path}.risks`,
        errors,
        new Set(["title", "body", "severity"]),
        ["title", "body", "severity"],
        (item, itemPath) => {
          if (!severities.has(item.severity))
            errors.push(`${itemPath}.severity must be low, medium, high, or critical`);
        },
      );
    if (section.files !== undefined)
      checkObjectArray(
        section.files,
        `${path}.files`,
        errors,
        new Set(["path", "detail", "status"]),
        ["path"],
        (item, itemPath) => {
          checkString(item.detail, `${itemPath}.detail`, errors);
          if (item.status !== undefined && !fileStatuses.has(item.status))
            errors.push(
              `${itemPath}.status must be added, modified, deleted, reviewed, or planned`,
            );
        },
      );
    if (section.steps !== undefined)
      checkObjectArray(
        section.steps,
        `${path}.steps`,
        errors,
        new Set(["title", "body", "status"]),
        ["title"],
        (item, itemPath) => {
          checkString(item.body, `${itemPath}.body`, errors);
          if (item.status !== undefined && !stepStatuses.has(item.status))
            errors.push(`${itemPath}.status must be done, current, next, or blocked`);
        },
      );

    if (section.flow !== undefined) {
      if (!isRecord(section.flow)) errors.push(`${path}.flow must be an object`);
      else {
        checkKeys(section.flow, new Set(["nodes", "edges"]), `${path}.flow`, errors);
        checkObjectArray(
          section.flow.nodes,
          `${path}.flow.nodes`,
          errors,
          new Set(["id", "label", "detail", "tone"]),
          ["id", "label"],
          (item, itemPath) => {
            checkString(item.detail, `${itemPath}.detail`, errors);
            checkTone(item.tone, `${itemPath}.tone`, errors);
          },
        );
        if (!Array.isArray(section.flow.edges)) errors.push(`${path}.flow.edges must be an array`);
        else {
          const ids = new Set(
            Array.isArray(section.flow.nodes)
              ? section.flow.nodes.filter(isRecord).map((node) => node.id)
              : [],
          );
          section.flow.edges.forEach((edge, edgeIndex) => {
            const edgePath = `${path}.flow.edges[${edgeIndex}]`;
            if (!isRecord(edge)) errors.push(`${edgePath} must be an object`);
            else {
              checkKeys(edge, new Set(["from", "to", "label"]), edgePath, errors);
              checkString(edge.from, `${edgePath}.from`, errors, true);
              checkString(edge.to, `${edgePath}.to`, errors, true);
              checkString(edge.label, `${edgePath}.label`, errors);
              if (typeof edge.from === "string" && !ids.has(edge.from))
                errors.push(`${edgePath}.from must reference a flow node`);
              if (typeof edge.to === "string" && !ids.has(edge.to))
                errors.push(`${edgePath}.to must reference a flow node`);
            }
          });
        }
      }
    }

    if (section.callouts !== undefined)
      checkObjectArray(
        section.callouts,
        `${path}.callouts`,
        errors,
        new Set(["title", "body", "tone"]),
        ["body"],
        (item, itemPath) => {
          checkString(item.title, `${itemPath}.title`, errors);
          checkTone(item.tone, `${itemPath}.tone`, errors);
        },
      );
    if (section.evidence !== undefined)
      checkObjectArray(
        section.evidence,
        `${path}.evidence`,
        errors,
        new Set(["label", "value", "source"]),
        ["label", "value"],
        (item, itemPath) => {
          checkString(item.source, `${itemPath}.source`, errors);
        },
      );
  });

  return errors;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function tone(value) {
  return typeof value === "string" && tones.has(value) ? value : "accent";
}

function renderCards(cards) {
  if (!cards) return "";
  return `<div class="grid">${cards.map((card) => `<article class="card" data-tone="${tone(card.tone)}"><h3>${escapeHtml(card.title)}</h3>${card.body ? `<p>${escapeHtml(card.body)}</p>` : ""}${card.meta?.length ? `<div class="meta">${card.meta.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}</div>` : ""}</article>`).join("")}</div>`;
}

function renderTable(table) {
  if (!table) return "";
  return `<div class="table-wrap"><table>${table.caption ? `<caption>${escapeHtml(table.caption)}</caption>` : ""}<thead><tr>${table.columns.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${table.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function renderLists(section) {
  const risks = section.risks
    ? `<div class="risks">${section.risks.map((risk) => `<article class="risk" data-severity="${risk.severity}"><span class="severity">${risk.severity}</span><div><h3>${escapeHtml(risk.title)}</h3><p>${escapeHtml(risk.body)}</p></div></article>`).join("")}</div>`
    : "";
  const files = section.files
    ? `<div class="files">${section.files.map((file) => `<div class="file"><span class="status">${escapeHtml(file.status ?? "file")}</span><div><code>${escapeHtml(file.path)}</code>${file.detail ? `<p>${escapeHtml(file.detail)}</p>` : ""}</div></div>`).join("")}</div>`
    : "";
  const steps = section.steps
    ? `<div class="steps">${section.steps.map((step, index) => `<div class="step"><span class="index">${index + 1}</span><div><h3>${escapeHtml(step.title)}</h3>${step.body ? `<p>${escapeHtml(step.body)}</p>` : ""}${step.status ? `<span class="status">${escapeHtml(step.status)}</span>` : ""}</div></div>`).join("")}</div>`
    : "";
  return `${risks}${files}${steps}`;
}

function renderFlow(flow) {
  if (!flow) return "";
  return `<div class="flow"><div class="grid">${flow.nodes.map((node) => `<article class="flow-node" data-tone="${tone(node.tone)}"><h3>${escapeHtml(node.label)}</h3>${node.detail ? `<p>${escapeHtml(node.detail)}</p>` : ""}</article>`).join("")}</div>${flow.edges.length ? `<div class="flow-edges">${flow.edges.map((edge) => `<span class="flow-edge">${escapeHtml(edge.from)} → ${escapeHtml(edge.to)}${edge.label ? ` · ${escapeHtml(edge.label)}` : ""}</span>`).join("")}</div>` : ""}</div>`;
}

function renderCalloutsAndEvidence(section) {
  const callouts = section.callouts
    ? `<div class="callouts">${section.callouts.map((callout) => `<aside class="callout" data-tone="${tone(callout.tone)}">${callout.title ? `<h3>${escapeHtml(callout.title)}</h3>` : ""}<p>${escapeHtml(callout.body)}</p></aside>`).join("")}</div>`
    : "";
  const evidence = section.evidence
    ? `<div class="evidence">${section.evidence.map((item) => `<article class="evidence-item"><h3>${escapeHtml(item.label)}</h3><div class="evidence-value">${escapeHtml(item.value)}</div>${item.source ? `<div class="evidence-source">${escapeHtml(item.source)}</div>` : ""}</article>`).join("")}</div>`
    : "";
  return `${callouts}${evidence}`;
}

export async function renderQuickSpec(spec) {
  const errors = validateQuickSpec(spec);
  if (errors.length) throw new Error(`Quick spec validation failed:\n- ${errors.join("\n- ")}`);
  const css = await readFile(join(quickDir, "base.css"), "utf8");
  const sections = spec.sections
    .map(
      (section, index) =>
        `<section class="section" data-tone="${tone(section.tone)}"><div class="section-head"><div><h2>${escapeHtml(section.title)}</h2>${section.subtitle ? `<p class="section-subtitle">${escapeHtml(section.subtitle)}</p>` : ""}</div><span class="section-kicker">${String(index + 1).padStart(2, "0")}</span></div>${section.summary ? `<p class="section-summary">${escapeHtml(section.summary)}</p>` : ""}${renderCards(section.cards)}${renderTable(section.table)}${renderLists(section)}${renderFlow(section.flow)}${renderCalloutsAndEvidence(section)}</section>`,
    )
    .join("");
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>${escapeHtml(spec.title)}</title>\n${standardFavicon}\n<style>\n${css}\n</style>\n</head>\n<body>\n<main>\n<header><h1>${escapeHtml(spec.title)}</h1>${spec.subtitle ? `<p class="subtitle">${escapeHtml(spec.subtitle)}</p>` : ""}${spec.summary ? `<p class="summary">${escapeHtml(spec.summary)}</p>` : ""}</header>\n<div class="sections">${sections}</div>\n</main>\n</body>\n</html>\n`;
}

async function main() {
  const [specPath, outputPath] = process.argv.slice(2);
  if (!specPath || !outputPath) throw new Error("Usage: node render.mjs <spec.json> <output.html>");
  const spec = JSON.parse(await readFile(specPath, "utf8"));
  const html = await renderQuickSpec(spec);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf8");
  process.stdout.write(`${outputPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
