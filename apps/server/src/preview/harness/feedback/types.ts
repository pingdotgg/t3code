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
