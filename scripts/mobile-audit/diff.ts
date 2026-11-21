export type AuditPlatform = "ios" | "android";

export interface AuditRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SmallTargetDetail {
  readonly unit: string;
  readonly width: number;
  readonly height: number;
  readonly recommendedSize: number;
}

export interface AmbiguousNameDetail {
  readonly name: string;
  readonly count: number;
}

export interface AuditFinding {
  readonly ref: string;
  readonly kind: "small-target" | "missing-name" | "ambiguous-name" | "covered-control" | string;
  readonly severity?: string;
  readonly role: string;
  readonly label?: string;
  readonly identifier?: string;
  readonly rect?: AuditRect;
  readonly detail?: SmallTargetDetail | AmbiguousNameDetail | Record<string, unknown>;
}

export interface RawSnapshotNode {
  readonly index: number;
  readonly parentIndex?: number;
  readonly ref?: string;
  readonly type?: string;
  readonly role?: string;
  readonly label?: string;
  readonly identifier?: string;
  readonly contentDescription?: string;
  readonly text?: string;
  readonly rect?: AuditRect;
  readonly enabled?: boolean;
  readonly hittable?: boolean;
  readonly visibleToUser?: boolean;
  readonly keyboardOwned?: boolean;
  readonly systemBar?: string;
}

export interface RawSnapshotData {
  readonly nodes: ReadonlyArray<RawSnapshotNode>;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly androidSnapshot?: { readonly pixelDensity?: number; readonly backend?: string };
}

export interface AuditCapture {
  readonly platform: AuditPlatform;
  readonly screen: string;
  readonly viewport?: { readonly width: number; readonly height: number } | undefined;
  readonly pixelDensity: number;
  readonly findings: ReadonlyArray<AuditFinding>;
  readonly guidance?: Readonly<Record<string, string>> | undefined;
  readonly limitations?: ReadonlyArray<string> | undefined;
}

export interface FixedFinding {
  readonly before: AuditFinding;
  readonly afterNode?: RawSnapshotNode | undefined;
  readonly afterMeasurement?: string | undefined;
}

export interface ScreenDiff {
  readonly platform: AuditPlatform;
  readonly screen: string;
  readonly pixelDensity: number;
  readonly beforeCount: number;
  readonly afterCount: number;
  readonly regressions: ReadonlyArray<AuditFinding>;
  readonly fixed: ReadonlyArray<FixedFinding>;
  readonly unchanged: ReadonlyArray<AuditFinding>;
  readonly filteredNoiseCount: number;
}

export interface OverlayBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly tag: string;
  readonly color: string;
  readonly tagSide?: "above" | "below" | "right" | "inside-right";
}

const VIEWPORT_EDGE_CLIP_TOLERANCE = 10;

export function unitForPlatform(platform: AuditPlatform): "pt" | "dp" {
  return platform === "ios" ? "pt" : "dp";
}

export function resolveViewport(
  capture: Pick<AuditCapture, "viewport">,
  raw?: RawSnapshotData,
): { readonly width: number; readonly height: number } | undefined {
  if (capture.viewport?.width && capture.viewport?.height) return capture.viewport;
  if (raw?.viewport?.width && raw?.viewport?.height) return raw.viewport;
  const rootRect = raw?.nodes[0]?.rect;
  if (rootRect && rootRect.width > 0 && rootRect.height > 0) {
    return { width: rootRect.width, height: rootRect.height };
  }
  return undefined;
}

export function formatHeight(rect: AuditRect, density: number, unit: "pt" | "dp"): string {
  const h = Math.round((rect.height / density) * 10) / 10;
  return `${h}${unit}`;
}

function isSmallTargetDetail(detail: AuditFinding["detail"]): detail is SmallTargetDetail {
  return (
    typeof detail === "object" &&
    detail !== null &&
    typeof (detail as SmallTargetDetail).width === "number" &&
    typeof (detail as SmallTargetDetail).height === "number"
  );
}

function isAmbiguousNameDetail(detail: AuditFinding["detail"]): detail is AmbiguousNameDetail {
  return (
    typeof detail === "object" &&
    detail !== null &&
    typeof (detail as AmbiguousNameDetail).name === "string" &&
    typeof (detail as AmbiguousNameDetail).count === "number"
  );
}

/**
 * Filters known platform-chrome and viewport-clipping artifacts so regressions stay high-signal:
 * - iOS 26/27 native UISwitch accessibility frames report 63×28pt.
 * - iOS system keyboard dictation/predictive bar buttons when not tagged keyboardOwned.
 * - Rows clipped at the top or bottom scroll-viewport edge.
 */
export function isPlatformNoise(
  finding: AuditFinding,
  platform: AuditPlatform,
  viewport?: { readonly width: number; readonly height: number },
): boolean {
  if (platform === "ios") {
    if (
      finding.kind === "small-target" &&
      finding.role === "switch" &&
      isSmallTargetDetail(finding.detail) &&
      finding.detail.width >= 50 &&
      finding.detail.height <= 32
    ) {
      return true;
    }
    if (finding.identifier === "dictation" || finding.label === "Dictate") {
      return true;
    }
  }
  if (finding.kind === "small-target" && finding.rect && viewport) {
    const bottomEdge = finding.rect.y + finding.rect.height;
    const clippedAtBottom =
      bottomEdge >= viewport.height - VIEWPORT_EDGE_CLIP_TOLERANCE &&
      finding.rect.height < viewport.height * 0.04;
    const clippedAtTop = finding.rect.y <= 0 && finding.rect.height < viewport.height * 0.04;
    if (clippedAtBottom || clippedAtTop) return true;
  }
  return false;
}

/** Stable identity key for matching findings across before/after runs. */
export function findingSignature(finding: AuditFinding): string {
  const name = (
    finding.label ??
    (isAmbiguousNameDetail(finding.detail) ? finding.detail.name : undefined) ??
    finding.identifier ??
    ""
  )
    .trim()
    .toLowerCase();
  if (name) return `${finding.kind}|${finding.role}|${name}`;
  const rx = finding.rect ? Math.round(finding.rect.x / 20) * 20 : -1;
  const ry = finding.rect ? Math.round(finding.rect.y / 20) * 20 : -1;
  return `${finding.kind}|${finding.role}|@${rx},${ry}`;
}

function roleMatchesNode(role: string, node: RawSnapshotNode): boolean {
  const type = (node.type ?? "").toLowerCase();
  switch (role) {
    case "button":
      return type.includes("button");
    case "text-field":
      return type.includes("edittext") || type.includes("textfield") || type.includes("textview");
    case "search-field":
      return type.includes("search");
    case "radio":
      return type.includes("radio");
    case "switch":
      return type.includes("switch");
    case "link":
      return type.includes("link");
    default:
      return true;
  }
}

function findMatchingAfterNode(
  finding: AuditFinding,
  afterRaw?: RawSnapshotData,
): RawSnapshotNode | undefined {
  if (!afterRaw) return undefined;
  const targetLabel = (
    finding.label ?? (isAmbiguousNameDetail(finding.detail) ? finding.detail.name : undefined)
  )?.trim();
  const candidates = afterRaw.nodes.filter((node) => {
    if (!node.rect || node.rect.width <= 0 || node.rect.height <= 0) return false;
    if (!roleMatchesNode(finding.role, node)) return false;
    if (targetLabel) {
      return (
        node.label?.trim() === targetLabel ||
        node.contentDescription?.trim() === targetLabel ||
        node.text?.trim() === targetLabel
      );
    }
    if (finding.rect) {
      return (
        Math.abs(node.rect.x - finding.rect.x) <= 40 && Math.abs(node.rect.y - finding.rect.y) <= 40
      );
    }
    return false;
  });
  if (candidates.length === 0) return undefined;
  if (!finding.rect || candidates.length === 1) return candidates[0];
  return candidates.reduce((best, curr) => {
    const bestDist =
      Math.abs(best.rect!.x - finding.rect!.x) + Math.abs(best.rect!.y - finding.rect!.y);
    const currDist =
      Math.abs(curr.rect!.x - finding.rect!.x) + Math.abs(curr.rect!.y - finding.rect!.y);
    return currDist < bestDist ? curr : best;
  });
}

export function diffAuditCaptures(input: {
  readonly before: AuditCapture;
  readonly after: AuditCapture;
  readonly beforeRaw?: RawSnapshotData | undefined;
  readonly afterRaw?: RawSnapshotData | undefined;
}): ScreenDiff {
  const beforeVp = resolveViewport(input.before, input.beforeRaw);
  const afterVp = resolveViewport(input.after, input.afterRaw);

  let filteredNoiseCount = 0;
  const beforeFindings = input.before.findings.filter((f) => {
    if (isPlatformNoise(f, input.before.platform, beforeVp)) {
      filteredNoiseCount += 1;
      return false;
    }
    return true;
  });
  const afterFindings = input.after.findings.filter((f) => {
    if (isPlatformNoise(f, input.after.platform, afterVp)) {
      filteredNoiseCount += 1;
      return false;
    }
    return true;
  });

  // Multiset diff by signature so fixing 1 of 2 duplicate buttons still shows up accurately.
  const remainingAfter = new Map<string, AuditFinding[]>();
  for (const f of afterFindings) {
    const key = findingSignature(f);
    const list = remainingAfter.get(key) ?? [];
    list.push(f);
    remainingAfter.set(key, list);
  }

  const unchanged: AuditFinding[] = [];
  const fixed: FixedFinding[] = [];
  const unit = unitForPlatform(input.after.platform);
  const density = input.after.pixelDensity || 1;

  for (const bf of beforeFindings) {
    const key = findingSignature(bf);
    const bucket = remainingAfter.get(key);
    if (bucket && bucket.length > 0) {
      bucket.shift();
      unchanged.push(bf);
    } else {
      const afterNode = findMatchingAfterNode(bf, input.afterRaw);
      const afterMeasurement =
        bf.kind === "ambiguous-name"
          ? "1 btn ✓"
          : afterNode?.rect
            ? `${formatHeight(afterNode.rect, density, unit)} ✓`
            : "fixed ✓";
      fixed.push({ before: bf, afterNode, afterMeasurement });
    }
  }

  const regressions: AuditFinding[] = [];
  for (const bucket of remainingAfter.values()) {
    regressions.push(...bucket);
  }

  return {
    platform: input.after.platform,
    screen: input.after.screen,
    pixelDensity: density,
    beforeCount: beforeFindings.length,
    afterCount: afterFindings.length,
    regressions,
    fixed,
    unchanged,
    filteredNoiseCount,
  };
}

function dedupeBoxes(boxes: ReadonlyArray<OverlayBox>): OverlayBox[] {
  const seen = new Set<string>();
  return boxes.filter((box) => {
    const key = `${Math.round(box.x / 4)}:${Math.round(box.y / 4)}:${Math.round(box.width / 4)}:${Math.round(box.height / 4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function findingTag(finding: AuditFinding, density: number, unit: "pt" | "dp"): string {
  if (finding.kind === "small-target") {
    if (isSmallTargetDetail(finding.detail)) {
      return `${finding.detail.height}${finding.detail.unit}`;
    }
    if (finding.rect) return formatHeight(finding.rect, density, unit);
    return "small";
  }
  if (finding.kind === "ambiguous-name") {
    const count = isAmbiguousNameDetail(finding.detail) ? finding.detail.count : 2;
    return `×${count} dup`;
  }
  if (finding.kind === "missing-name") return "no label";
  if (finding.kind === "covered-control") return "covered";
  return finding.kind;
}

export function buildOverlayBoxes(
  diff: ScreenDiff,
  density: number,
  beforeDensity = density,
): { readonly beforeBoxes: OverlayBox[]; readonly afterBoxes: OverlayBox[] } {
  const unit = unitForPlatform(diff.platform);
  const beforeBoxes: OverlayBox[] = [];
  const afterBoxes: OverlayBox[] = [];

  for (const item of diff.fixed) {
    if (item.before.rect) {
      beforeBoxes.push({
        ...item.before.rect,
        tag: findingTag(item.before, beforeDensity, unit),
        color: "#ef4444",
      });
    }
    if (item.afterNode?.rect) {
      afterBoxes.push({
        ...item.afterNode.rect,
        tag: item.afterMeasurement ?? "fixed ✓",
        color: "#16a34a",
      });
    }
  }

  for (const reg of diff.regressions) {
    if (reg.rect) {
      afterBoxes.push({
        ...reg.rect,
        tag: `NEW: ${findingTag(reg, density, unit)}`,
        color: "#ef4444",
      });
    }
  }

  return {
    beforeBoxes: dedupeBoxes(beforeBoxes),
    afterBoxes: dedupeBoxes(afterBoxes),
  };
}

export function renderMarkdownReport(
  diffs: ReadonlyArray<ScreenDiff & { readonly imagePath?: string }>,
): string {
  const totalRegressions = diffs.reduce((n, d) => n + d.regressions.length, 0);
  const totalFixed = diffs.reduce((n, d) => n + d.fixed.length, 0);
  const lines: string[] = [
    "### Mobile accessibility audit (`agent-device audit`)",
    "",
    `Summary: **${totalFixed} fixed**, **${totalRegressions} regressions** across ${diffs.length} screen(s).`,
    "",
    "| Platform | Screen | Before | After | Fixed | Regressions |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  ];

  for (const d of diffs) {
    lines.push(
      `| ${d.platform} | \`${d.screen}\` | ${d.beforeCount} | ${d.afterCount} | ${d.fixed.length} | ${d.regressions.length} |`,
    );
  }

  for (const d of diffs) {
    if (d.fixed.length === 0 && d.regressions.length === 0) continue;
    lines.push("", `#### ${d.platform} · \`${d.screen}\``);
    if (d.regressions.length > 0) {
      lines.push("", "**Regressions:**");
      for (const r of d.regressions) {
        lines.push(
          `- \`${r.kind}\` (${r.role}) ${r.label ? `\`${r.label}\`` : "(unnamed)"} — ${findingTag(r, d.pixelDensity || 1, unitForPlatform(d.platform))}`,
        );
      }
    }
    if (d.fixed.length > 0) {
      lines.push("", "**Fixed:**");
      for (const f of d.fixed) {
        lines.push(
          `- \`${f.before.kind}\` (${f.before.role}) ${f.before.label ? `\`${f.before.label}\`` : "(unnamed)"} → ${f.afterMeasurement ?? "fixed"}`,
        );
      }
    }
    if (d.imagePath) {
      lines.push("", `![${d.platform} ${d.screen} before vs after](${d.imagePath})`);
    }
  }

  return `${lines.join("\n")}\n`;
}
