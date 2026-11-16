import { QA_VERDICTS, type QaRun, type QaScenario, type QaVerdict } from "@t3tools/contracts";

export const QA_VIDEO_FILE = "session.webm";

function verdictCounts(run: Pick<QaRun, "scenarios">): Record<QaVerdict, number> {
  const counts = Object.fromEntries(QA_VERDICTS.map((verdict) => [verdict, 0])) as Record<
    QaVerdict,
    number
  >;
  for (const scenario of run.scenarios) counts[scenario.verdict] += 1;
  return counts;
}

function formatVideoOffset(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const fileName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
const evidenceRef = (path: string) => `evidence/${fileName(path)}`;

function videoLine(run: QaRun): string {
  if (run.video) return `[${QA_VIDEO_FILE}](${evidenceRef(run.video.path)})`;
  return `video unavailable${run.videoUnavailableReason ? `: ${run.videoUnavailableReason}` : ""}`;
}

function markdownScenario(scenario: QaScenario): string {
  const lines = [`### ${scenario.index + 1}. ${scenario.scenario}: ${scenario.verdict}`, ""];
  if (scenario.downgradeReason) lines.push(`> ${scenario.downgradeReason}`, "");
  lines.push(scenario.note, "");
  if (scenario.severity) lines.push(`- **Severity:** ${scenario.severity}`);
  if (scenario.expected) lines.push(`- **Expected:** ${scenario.expected}`);
  if (scenario.actual) lines.push(`- **Actual:** ${scenario.actual}`);
  if (scenario.pageUrl) lines.push(`- **Page:** ${scenario.pageUrl}`);
  if (scenario.videoOffsetMs !== null) {
    lines.push(`- **Video:** ${formatVideoOffset(scenario.videoOffsetMs)}`);
  }
  lines.push(
    `- **Console errors:** ${scenario.consoleErrorCount}`,
    `- **Failed requests:** ${scenario.failedRequestCount}`,
  );
  if (scenario.steps.length > 0) {
    lines.push("", "Steps:", "", ...scenario.steps.map((step, index) => `${index + 1}. ${step}`));
  }
  if (scenario.screenshotPath) {
    lines.push("", `![${scenario.scenario}](${evidenceRef(scenario.screenshotPath)})`);
  }
  return lines.join("\n");
}

export function renderMarkdownReport(run: QaRun): string {
  const counts = verdictCounts(run);
  const summary = QA_VERDICTS.map((verdict) => `${verdict} ${counts[verdict]}`).join(" · ");
  return [
    `# QA report${run.site ? `: ${run.site}` : ""}`,
    "",
    `- **Started:** ${run.startedAt}`,
    `- **Finished:** ${run.finishedAt ?? "not finished"}`,
    `- **Video:** ${videoLine(run)}`,
    `- **Summary:** ${summary}`,
    "",
    "## Scenarios",
    "",
    run.scenarios.length === 0
      ? "No scenarios were recorded."
      : run.scenarios.map(markdownScenario).join("\n\n"),
    "",
  ].join("\n");
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );

const VERDICT_COLORS: Record<QaVerdict, string> = {
  PASS: "#15803d",
  FAIL: "#b91c1c",
  BLOCKED: "#b45309",
  INCONCLUSIVE: "#6b7280",
  SKIPPED: "#6b7280",
};

function htmlScenario(scenario: QaScenario, screenshot: string | null, hasVideo: boolean): string {
  const facts = [
    scenario.severity ? ["Severity", scenario.severity] : null,
    scenario.expected ? ["Expected", scenario.expected] : null,
    scenario.actual ? ["Actual", scenario.actual] : null,
    scenario.pageUrl ? ["Page", scenario.pageUrl] : null,
    ["Console errors", String(scenario.consoleErrorCount)],
    ["Failed requests", String(scenario.failedRequestCount)],
  ].filter((fact): fact is [string, string] => fact !== null);
  const video =
    hasVideo && scenario.videoOffsetMs !== null
      ? `<p><a href="evidence/${QA_VIDEO_FILE}#t=${Math.floor(scenario.videoOffsetMs / 1000)}">Video at ${formatVideoOffset(scenario.videoOffsetMs)}</a></p>`
      : "";
  return `<section class="scenario">
<h3><span class="verdict" style="background:${VERDICT_COLORS[scenario.verdict]}">${scenario.verdict}</span> ${scenario.index + 1}. ${escapeHtml(scenario.scenario)}</h3>
${scenario.downgradeReason ? `<p class="note">${escapeHtml(scenario.downgradeReason)}</p>` : ""}
<p>${escapeHtml(scenario.note)}</p>
<dl>${facts.map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>
${scenario.steps.length > 0 ? `<ol>${scenario.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>` : ""}
${scenario.consoleErrors.length > 0 ? `<pre>${escapeHtml(scenario.consoleErrors.join("\n"))}</pre>` : ""}
${video}
${screenshot ? `<img alt="${escapeHtml(scenario.scenario)}" src="data:image/png;base64,${screenshot}">` : ""}
</section>`;
}

/** Self-contained: screenshots are inlined, the video is the file beside the report. */
export function renderHtmlReport(
  run: QaRun,
  screenshotBase64: (path: string) => string | null,
): string {
  const counts = verdictCounts(run);
  const title = `QA report${run.site ? `: ${run.site}` : ""}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--fg:#111827;--bg:#fff;--muted:#6b7280;--line:#e5e7eb}
@media (prefers-color-scheme:dark){:root{--fg:#f3f4f6;--bg:#111827;--muted:#9ca3af;--line:#374151}}
body{font:15px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);max-width:960px;margin:0 auto;padding:24px 16px}
.summary{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
.summary span,.verdict{border-radius:6px;padding:2px 8px;font-weight:600;font-size:13px}
.summary span{border:1px solid var(--line)}
.verdict{color:#fff}
.scenario{border-top:1px solid var(--line);padding:16px 0}
.note{color:var(--muted);font-style:italic}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
img,video{max-width:100%;border:1px solid var(--line);border-radius:6px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;background:rgba(127,127,127,.12);padding:8px;border-radius:6px}
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<p>Started ${escapeHtml(run.startedAt)}${run.finishedAt ? `, finished ${escapeHtml(run.finishedAt)}` : ""}</p>
<div class="summary">${QA_VERDICTS.map((verdict) => `<span>${verdict} ${counts[verdict]}</span>`).join("")}</div>
${run.video ? `<video controls preload="metadata" src="evidence/${QA_VIDEO_FILE}"></video>` : `<p class="note">${escapeHtml(videoLine(run))}</p>`}
<h2>Scenarios</h2>
${
  run.scenarios.length === 0
    ? "<p>No scenarios were recorded.</p>"
    : run.scenarios
        .map((scenario) =>
          htmlScenario(
            scenario,
            scenario.screenshotPath ? screenshotBase64(scenario.screenshotPath) : null,
            run.video !== null,
          ),
        )
        .join("\n")
}
</body></html>
`;
}
