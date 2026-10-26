// @effect-diagnostics nodeBuiltinImport:off - Writes a static HTML report.

import * as NodePath from "node:path";

import type { StepResult } from "./journey.ts";
import type { Pose } from "./poses.ts";

export interface Finding {
  readonly step: string;
  readonly issue: string;
  readonly severity: "high" | "medium" | "low";
}

export interface PoseResult {
  readonly pose: Pose;
  readonly steps: ReadonlyArray<StepResult>;
  readonly error?: string;
  /** Screenshot taken when the journey stopped early. */
  readonly stopped?: string;
  readonly findings?: ReadonlyArray<Finding>;
}

export const failedChecks = (result: PoseResult) =>
  result.steps.flatMap((step) =>
    step.checks.filter((item) => !item.pass).map((item) => ({ step: step.name, ...item })),
  );

export const poseFailed = (result: PoseResult) =>
  result.error !== undefined || failedChecks(result).length > 0;

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const describePose = (pose: Pose) =>
  [
    pose.device,
    pose.appearance,
    pose.landscape ? "landscape" : "",
    pose.fold ? `fold ${pose.fold}` : "",
    pose.textSize ? "large text" : "",
  ]
    .filter(Boolean)
    .join(" · ");

export function renderReport(results: ReadonlyArray<PoseResult>, outputDirectory: string): string {
  const relative = (path: string | undefined) =>
    path ? escapeHtml(NodePath.relative(outputDirectory, path)) : "";
  const rows = results
    .map((result) => {
      const cells = result.steps
        .map((step) => {
          const failed = step.checks.filter((item) => !item.pass);
          const findings = (result.findings ?? []).filter((finding) => finding.step === step.name);
          const notes = [
            ...failed.map(
              (item) =>
                `<li class="fail">✗ ${escapeHtml(item.name)} <small>${escapeHtml(item.detail)}</small></li>`,
            ),
            ...findings.map(
              (finding) =>
                `<li class="review ${finding.severity}">◆ ${escapeHtml(finding.issue)}</li>`,
            ),
          ].join("");
          const passed = step.checks.length - failed.length;
          const media = [
            step.screenshot
              ? `<a href="${relative(step.screenshot)}"><img src="${relative(step.screenshot)}"></a>`
              : "",
            step.lagFrame
              ? `<a href="${relative(step.lagFrame)}"><img class="lag" src="${relative(step.lagFrame)}"></a>`
              : "",
            step.video ? `<a href="${relative(step.video)}">video</a>` : "",
          ].join("");
          return `<td class="${failed.length ? "bad" : ""}"><h3>${escapeHtml(step.name)}</h3>${media}<small class="pass">${passed}/${step.checks.length} checks</small><ul>${notes}</ul></td>`;
        })
        .join("");
      const error = result.error
        ? `<td class="bad"><h3>stopped</h3>${result.stopped ? `<a href="${relative(result.stopped)}"><img src="${relative(result.stopped)}"></a>` : ""}<p class="fail">${escapeHtml(result.error)}</p></td>`
        : "";
      return `<tr><th>${escapeHtml(result.pose.id)}<br><small>${escapeHtml(describePose(result.pose))}</small></th>${cells}${error}</tr>`;
    })
    .join("");
  const failed = results.filter(poseFailed).length;
  const findings = results.reduce((count, result) => count + (result.findings?.length ?? 0), 0);
  return `<!doctype html><meta charset="utf-8"><title>Mobile E2E</title>
<style>body{font:14px system-ui;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:8px;vertical-align:top;text-align:left}td{width:190px}td.bad{background:#fff5f4}h3{margin:0 0 6px;font-size:13px}img{width:180px;display:block;margin:0 0 6px}img.lag{outline:3px solid #b42318}.pass{color:#16794a}.fail{color:#b42318}.review{color:#7a4b00}.review.high{color:#b42318}ul{padding-left:16px;margin:4px 0}small{color:#666}</style>
<h1>Mobile E2E · ${results.length} poses · ${failed === 0 ? "all checks passed" : `${failed} with failing checks`} · ${findings} review findings</h1>
<p><span class="fail">✗</span> failed check <span class="review">◆</span> agent review finding</p>
<table>${rows}</table>`;
}
