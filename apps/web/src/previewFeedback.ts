export interface PreviewFeedbackBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewFeedbackMarkerPosition {
  xPercent: number;
  yDocument: number;
  isFixed: boolean;
}

export interface PreviewFeedbackScope {
  scenarioId: string | null;
  scenarioName: string | null;
  argOverrides: Record<string, unknown>;
  argOverridesHash: string;
  viewport: {
    id: string;
    width: number | null;
    height: number | null;
  };
}

export interface PreviewFeedbackElementTarget {
  kind: "element";
  element: string;
  elementPath: string;
  fullPath: string | null;
  cssClasses: string | null;
  computedStyles: string | null;
  computedStyleMap: Record<string, string>;
  accessibility: string | null;
  nearbyText: string | null;
  nearbyElements: string | null;
  reactComponents: string | null;
  sourceFile: string | null;
  boundingBox: PreviewFeedbackBoundingBox;
  marker: PreviewFeedbackMarkerPosition;
}

export interface PreviewFeedbackTextTarget extends Omit<PreviewFeedbackElementTarget, "kind"> {
  kind: "text";
  selectedText: string;
}

export type PreviewFeedbackTarget = PreviewFeedbackElementTarget | PreviewFeedbackTextTarget;

export interface PreviewFeedbackAnnotation {
  id: string;
  previewFileRelativePath: string;
  componentRelativePath: string | null;
  runtimeInstanceId: string;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  status: "unsent" | "sent";
  comment: string;
  scope: PreviewFeedbackScope;
  target: PreviewFeedbackTarget;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function stableHashPreviewArgs(args: Record<string, unknown>): string {
  const value = stableStringify(args);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildPreviewFeedbackScopeKey(scope: PreviewFeedbackScope): string {
  return [
    scope.scenarioId ?? "",
    scope.argOverridesHash,
    scope.viewport.id,
    scope.viewport.width ?? "",
    scope.viewport.height ?? "",
  ].join(":");
}

export function filterAnnotationsForActiveScope(
  annotations: readonly PreviewFeedbackAnnotation[],
  scope: PreviewFeedbackScope,
): PreviewFeedbackAnnotation[] {
  const scopeKey = buildPreviewFeedbackScopeKey(scope);
  return annotations.filter(
    (annotation) => buildPreviewFeedbackScopeKey(annotation.scope) === scopeKey,
  );
}

export function markPreviewFeedbackAnnotationsSent(
  annotations: readonly PreviewFeedbackAnnotation[],
  ids: readonly string[],
  sentAt: string,
): PreviewFeedbackAnnotation[] {
  const idSet = new Set(ids);
  return annotations.map((annotation) =>
    idSet.has(annotation.id)
      ? {
          ...annotation,
          status: "sent",
          sentAt,
          updatedAt: sentAt,
        }
      : annotation,
  );
}

function formatJsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function buildPreviewFeedbackPrompt(input: {
  previewFileRelativePath: string;
  componentRelativePath: string | null;
  scope: PreviewFeedbackScope;
  annotations: readonly PreviewFeedbackAnnotation[];
}): string {
  const viewport =
    input.scope.viewport.width && input.scope.viewport.height
      ? `${input.scope.viewport.id} (${input.scope.viewport.width}x${input.scope.viewport.height})`
      : input.scope.viewport.id;
  const referencedFiles = [
    input.previewFileRelativePath,
    input.componentRelativePath,
    ...input.annotations.map((annotation) => annotation.target.sourceFile ?? null),
    ...input.annotations.map((annotation) => annotation.componentRelativePath),
  ]
    .filter((file): file is string => Boolean(file && file.trim().length > 0))
    .map((file) => file.trim())
    .filter((file, index, files) => files.indexOf(file) === index);
  const lines = [
    "# Preview feedback",
    "",
    "The user annotated the component preview. Address these changes in the codebase.",
    "",
    `Preview file: ${input.previewFileRelativePath}`,
    `Component file: ${input.componentRelativePath ?? "unknown"}`,
    `Scenario: ${input.scope.scenarioName ?? input.scope.scenarioId ?? "default"}`,
    `Viewport: ${viewport}`,
    "Control overrides:",
    "```json",
    formatJsonBlock(input.scope.argOverrides),
    "```",
    "",
    "Relevant files:",
    ...referencedFiles.map((file) => `- ${file}`),
    "",
    "Use the source file and React component metadata when available, but verify in the codebase before editing.",
    "Prefer the component, preview, wrapper, and mocks files relevant to the annotation. Preserve existing preview scenarios and controls.",
    "",
    "## Annotations",
    "",
  ];

  input.annotations.forEach((annotation, index) => {
    const target = annotation.target;
    lines.push(`### ${index + 1}. ${target.element}`);
    lines.push(`Location: ${target.elementPath}`);
    if (target.sourceFile) lines.push(`Source: ${target.sourceFile}`);
    if (target.reactComponents) lines.push(`React: ${target.reactComponents}`);
    if (target.cssClasses) lines.push(`Classes: ${target.cssClasses}`);
    lines.push(
      `Position: x:${Math.round(target.boundingBox.x)}, y:${Math.round(target.boundingBox.y)}, size:${Math.round(target.boundingBox.width)}x${Math.round(target.boundingBox.height)}`,
    );
    if (target.kind === "text") {
      lines.push(`Selected text: "${target.selectedText}"`);
    }
    if (target.nearbyText) lines.push(`Nearby text: ${target.nearbyText}`);
    if (target.computedStyles) lines.push(`Computed styles: ${target.computedStyles}`);
    if (target.accessibility) lines.push(`Accessibility: ${target.accessibility}`);
    lines.push("");
    lines.push("Feedback:");
    lines.push(annotation.comment);
    lines.push("");
  });

  return lines.join("\n").trim();
}
