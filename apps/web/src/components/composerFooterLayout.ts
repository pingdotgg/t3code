import type { ContextStripCompaction } from "./BranchToolbar.logic";

const COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX = 620;
const COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX = 780;
const RESTING_COMPOSER_IMAGE_THUMBNAIL_LIMIT = 3;

export function getRestingComposerImagePreviewCounts(imageCount: number): {
  visibleCount: number;
  overflowCount: number;
} {
  const visibleCount = Math.min(imageCount, RESTING_COMPOSER_IMAGE_THUMBNAIL_LIMIT);
  return {
    visibleCount,
    overflowCount: Math.max(0, imageCount - visibleCount),
  };
}

export function shouldUseCompactComposerFooter(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  const breakpoint = options?.hasWideActions
    ? COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX
    : COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX;
  return width !== null && width < breakpoint;
}

export function shouldAnimateComposerRestingTransition(input: {
  hasCompletedInitialLayout: boolean;
  stateChanged: boolean;
  hasInterruptedAnimation: boolean;
}): boolean {
  return input.hasCompletedInitialLayout && (input.stateChanged || input.hasInterruptedAnimation);
}

export function shouldUseCompactComposerPrimaryActions(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  if (!options?.hasWideActions) {
    return false;
  }
  return width !== null && width < COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX;
}

export interface RestingComposerControlsMeasurement {
  gap: number;
  naturalFixedWidth: number;
  blockWidths: readonly number[];
  overflowWidth: number;
  iconOnlyBlockWidths?: readonly number[];
  traitsIconOnlyFixedWidth?: number;
  /** The leading picker's width with only its icon, when it has one. */
  iconOnlyFixedWidth?: number;
  compactLabels?: boolean;
}

function restingComposerControlsWidth(
  input: RestingComposerControlsMeasurement,
  hiddenCount: number,
  fixedWidth = input.naturalFixedWidth,
  iconOnlyCount = 0,
): number {
  const { blockWidths, gap } = input;
  const visibleCount = blockWidths.length - hiddenCount;
  return (
    fixedWidth +
    blockWidths
      .slice(0, visibleCount)
      .reduce(
        (sum, width, index) =>
          sum +
          (index >= blockWidths.length - iconOnlyCount
            ? (input.iconOnlyBlockWidths?.[index] ?? width)
            : width),
        0,
      ) +
    (hiddenCount > 0 ? input.overflowWidth : 0) +
    gap * (visibleCount + (hiddenCount > 0 ? 1 : 0))
  );
}

export function resolveRestingComposerControlsMinimumWidth(
  input: RestingComposerControlsMeasurement,
): number {
  return restingComposerControlsWidth(
    input,
    input.blockWidths.length,
    input.iconOnlyFixedWidth ?? input.naturalFixedWidth,
  );
}

const RESTING_CONTROLS_SLACK_PX = 1;

export interface RestingComposerControlsLayout {
  hiddenCount: number;
  iconOnlyCount?: number;
  traitsIconOnly?: boolean;
  pickerIconOnly?: boolean;
  visible: boolean;
}

function restingComposerControlsSteps(input: RestingComposerControlsMeasurement) {
  const iconSteps = input.iconOnlyBlockWidths ? input.blockWidths.length : 0;
  const traitsSteps = input.traitsIconOnlyFixedWidth === undefined ? 0 : 1;
  const pickerSteps = input.iconOnlyFixedWidth === undefined ? 0 : 1;
  const traitsStep = iconSteps + traitsSteps;
  const labelSteps = traitsStep + pickerSteps;
  const lastStep = labelSteps + input.blockWidths.length;
  const widthAtStep = (step: number) => {
    const pickerIconOnly = pickerSteps > 0 && step > traitsStep;
    const traitsIconOnly = traitsSteps > 0 && step > iconSteps;
    const fixedWidth = pickerIconOnly
      ? input.iconOnlyFixedWidth!
      : traitsIconOnly
        ? input.traitsIconOnlyFixedWidth!
        : input.naturalFixedWidth;
    return restingComposerControlsWidth(
      input,
      Math.max(0, step - labelSteps),
      fixedWidth,
      Math.min(step, iconSteps),
    );
  };
  const stepRange = (stripCompaction: ContextStripCompaction | undefined) =>
    stripCompaction === "none"
      ? ([0, traitsStep] as const)
      : stripCompaction === "labels"
        ? ([traitsStep, labelSteps] as const)
        : stripCompaction === "branch"
          ? ([labelSteps, lastStep] as const)
          : ([0, lastStep] as const);
  return { iconSteps, traitsSteps, pickerSteps, traitsStep, labelSteps, widthAtStep, stepRange };
}

export function resolveRestingComposerControlsNarrowestWidth(
  input: RestingComposerControlsMeasurement,
  stripCompaction: Exclude<ContextStripCompaction, "branch">,
): number {
  const { widthAtStep, stepRange } = restingComposerControlsSteps(input);
  return widthAtStep(stepRange(stripCompaction)[1]);
}

export function resolveRestingComposerControlsLayout(
  input: RestingComposerControlsMeasurement & {
    hostWidth: number;
    previous?: RestingComposerControlsLayout;
    stripCompaction?: ContextStripCompaction;
  },
): RestingComposerControlsLayout {
  const { blockWidths, hostWidth, previous } = input;
  const { iconSteps, traitsSteps, pickerSteps, traitsStep, labelSteps, widthAtStep, stepRange } =
    restingComposerControlsSteps(input);
  const previousStep = previous
    ? previous.hiddenCount > 0
      ? labelSteps + Math.min(previous.hiddenCount, blockWidths.length)
      : previous.pickerIconOnly && pickerSteps > 0
        ? labelSteps
        : previous.traitsIconOnly && traitsSteps > 0
          ? traitsStep
          : Math.min(previous.iconOnlyCount ?? 0, iconSteps)
    : 0;
  const [rangeStart, rangeEnd] = stepRange(input.stripCompaction);
  const firstStep = input.compactLabels ? Math.max(rangeStart, labelSteps) : rangeStart;
  const lastStep = input.compactLabels ? Math.max(rangeEnd, labelSteps) : rangeEnd;
  let step = firstStep;
  // Use 1px slack for natural-width jitter on promotion; demote immediately to avoid clipping.
  while (
    step < lastStep &&
    widthAtStep(step) > hostWidth - (step < previousStep ? RESTING_CONTROLS_SLACK_PX : 0)
  ) {
    step += 1;
  }
  const hiddenCount = Math.max(0, step - labelSteps);
  const iconOnlyCount = Math.min(step, iconSteps);
  const width = widthAtStep(step);
  const visible =
    previous && !previous.visible
      ? width <= hostWidth - RESTING_CONTROLS_SLACK_PX
      : width <= hostWidth;
  return {
    hiddenCount,
    ...(input.iconOnlyBlockWidths ? { iconOnlyCount } : {}),
    ...(traitsSteps > 0 ? { traitsIconOnly: step > iconSteps } : {}),
    ...(pickerSteps > 0 ? { pickerIconOnly: step > traitsStep } : {}),
    visible,
  };
}

export function resolveScrollToEndClearance(input: {
  overlayHeight: number;
  mainSurfaceTop: number;
  button: { left: number; right: number };
  attachments: ReadonlyArray<{ top: number; left: number; right: number }>;
}): number {
  let contentTop = input.mainSurfaceTop;
  let top = contentTop;
  for (const attachment of input.attachments) {
    contentTop = Math.min(contentTop, attachment.top);
    if (attachment.left < input.button.right && attachment.right > input.button.left) {
      top = Math.min(top, attachment.top);
    }
  }
  return Math.ceil(input.overlayHeight - (top - contentTop));
}
