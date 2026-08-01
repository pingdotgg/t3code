import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type PreviewAnnotationCallout,
  type PreviewAnnotationElementTarget,
  type PreviewAnnotationNormalizedPoint,
  type PreviewAnnotationNormalizedRect,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  PixelRatio,
  Pressable,
  ScrollView,
  TextInput,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedProps,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Circle, G, Image as SvgImage, Path, Rect, Text as SvgText } from "react-native-svg";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { estimateBase64ByteSize } from "../../lib/base64";
import {
  restoreComposerImageOriginal,
  type DraftComposerImageAttachment,
} from "../../lib/composerImages";
import { useThemeColor } from "../../lib/useThemeColor";
import { uuidv4 } from "../../lib/uuid";
import {
  buildAnnotatedImageAttachment,
  markupDocumentFromAttachment,
  originalImageFromAttachment,
} from "./attachmentMarkup";
import {
  DEFAULT_NORMALIZED_STROKE_WIDTH,
  DEFAULT_STROKE_COLOR,
  EMPTY_MARKUP_DOCUMENT,
  addElementCallout,
  addPointCallout,
  addRegionCallout,
  addStroke,
  annotationExportLayoutSize,
  annotationExportSize,
  aspectFit,
  clearMarkupDocument,
  commitMarkupDocument,
  createMarkupHistory,
  deleteMarkupObject,
  eraseMarkupObjectAtPoint,
  hitTestMarkupObject,
  makeStroke,
  markupDocumentIsEmpty,
  nextSmallerExportSize,
  normalizedPoint,
  normalizedRectFromPoints,
  pathForNormalizedPoints,
  redoMarkupHistory,
  remainingAnnotationExportByteBudget,
  undoMarkupHistory,
  updateCalloutComment,
  type MarkupDocument,
  type MarkupHistory,
  type MarkupSelection,
  type MarkupSize,
  type MarkupTool,
} from "./model";

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedRect = Animated.createAnimatedComponent(Rect);

const CALLOUT_BADGE_RADIUS = 0.019;
const CALLOUT_SELECTION_RADIUS_SCALE = 1.28;
const CALLOUT_REGION_STROKE_WIDTH = 0.003;
const ACTIVE_REGION_FILL_OPACITY = 0.12;
const ACTIVE_STROKE_CHUNK_COUNT = 16;
const ACTIVE_STROKE_POINTS_PER_CHUNK = 64;
const MAX_ACTIVE_STROKE_POINTS = ACTIVE_STROKE_CHUNK_COUNT * ACTIVE_STROKE_POINTS_PER_CHUNK;
const MIN_ACTIVE_STROKE_DISTANCE = 0.001;

interface ImageMarkupModalProps {
  readonly attachment: DraftComposerImageAttachment | null;
  readonly visible: boolean;
  readonly semanticElements?: ReadonlyArray<ImageMarkupSemanticElement>;
  readonly onCancel: () => void;
  readonly onDone: (attachment: DraftComposerImageAttachment) => void;
}

export interface ImageMarkupSemanticElement {
  readonly target: PreviewAnnotationElementTarget;
  readonly rect: PreviewAnnotationNormalizedRect;
}

function MarkupToolbarButton(props: {
  readonly label: string;
  readonly icon?: AppSymbolName;
  readonly active?: boolean;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const foreground = useThemeColor("--color-foreground");
  const muted = useThemeColor("--color-foreground-muted");
  const primary = useThemeColor("--color-primary");
  const danger = useThemeColor("--color-danger-foreground");
  const tint = props.disabled
    ? muted
    : props.destructive
      ? danger
      : props.active
        ? primary
        : foreground;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled, selected: props.active }}
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className="h-11 min-w-14 items-center justify-center gap-0.5 rounded-xl px-2"
      style={{ backgroundColor: props.active ? `${String(primary)}20` : "transparent" }}
    >
      {props.icon ? (
        <SymbolView name={props.icon} size={17} tintColor={tint} type="monochrome" />
      ) : null}
      <Text style={{ color: tint }} className="text-2xs font-t3-medium">
        {props.label}
      </Text>
    </Pressable>
  );
}

function selectedCallout(
  document: MarkupDocument,
  selection: MarkupSelection | null,
): PreviewAnnotationCallout | null {
  if (selection?.kind !== "callout") return null;
  return document.callouts.find((callout) => callout.id === selection.id) ?? null;
}

function svgPngBase64(svg: Svg | null): Promise<string> {
  if (!svg) {
    return Promise.reject(new Error("The annotation image is not ready."));
  }
  return new Promise((resolve, reject) => {
    svg.toDataURL((base64) => {
      if (base64.length === 0) {
        reject(new Error("The annotation image could not be rendered."));
        return;
      }
      resolve(base64);
    });
  });
}

async function exportFlattenedPng(
  render: (size: MarkupSize) => Promise<string>,
  initialSize: MarkupSize,
  maximumSizeBytes: number,
): Promise<{
  readonly base64: string;
  readonly size: MarkupSize;
  readonly sizeBytes: number;
}> {
  if (maximumSizeBytes <= 0) {
    throw new Error(
      "The original image leaves no room for markup within the 10 MB attachment storage limit.",
    );
  }
  let size: MarkupSize | null = initialSize;
  while (size) {
    const base64 = await render(size);
    const sizeBytes = estimateBase64ByteSize(base64);
    if (sizeBytes > 0 && sizeBytes <= maximumSizeBytes) {
      return { base64, size, sizeBytes };
    }
    size = nextSmallerExportSize(size);
  }
  throw new Error(
    "The original and annotated PNG cannot both fit within the 10 MB attachment storage limit. Choose a smaller image.",
  );
}

function dataUrlByteSize(dataUrl: string, fallbackSizeBytes: number): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) return fallbackSizeBytes;
  const estimated = estimateBase64ByteSize(dataUrl.slice(commaIndex + 1));
  return estimated > 0 ? estimated : fallbackSizeBytes;
}

function badgeCenter(rawValue: number, radius: number, imageLength: number): number {
  return Math.max(radius, Math.min(imageLength - radius, rawValue));
}

function CalloutShape(props: {
  readonly callout: PreviewAnnotationCallout;
  readonly imageSize: MarkupSize;
}) {
  const shortSide = Math.min(props.imageSize.width, props.imageSize.height);
  const radius = shortSide * CALLOUT_BADGE_RADIUS;
  const badgeInset = radius * CALLOUT_SELECTION_RADIUS_SCALE;
  const borderWidth = shortSide * CALLOUT_REGION_STROKE_WIDTH;
  const anchor = props.callout.anchor;
  const rect = anchor.kind === "point" ? null : anchor.rect;
  const badgeX = badgeCenter(
    anchor.kind === "point"
      ? anchor.point.x * props.imageSize.width
      : rect!.x * props.imageSize.width + radius,
    badgeInset,
    props.imageSize.width,
  );
  const badgeY = badgeCenter(
    anchor.kind === "point"
      ? anchor.point.y * props.imageSize.height
      : rect!.y * props.imageSize.height + radius,
    badgeInset,
    props.imageSize.height,
  );

  return (
    <G>
      {rect ? (
        <Rect
          x={rect.x * props.imageSize.width}
          y={rect.y * props.imageSize.height}
          width={rect.width * props.imageSize.width}
          height={rect.height * props.imageSize.height}
          fill={DEFAULT_STROKE_COLOR}
          fillOpacity={0.08}
          stroke={DEFAULT_STROKE_COLOR}
          strokeWidth={borderWidth}
          strokeDasharray={`${borderWidth * 2} ${borderWidth * 1.5}`}
        />
      ) : null}
      <Circle
        cx={badgeX}
        cy={badgeY}
        r={radius}
        fill={DEFAULT_STROKE_COLOR}
        stroke="#ffffff"
        strokeWidth={borderWidth}
      />
      <SvgText
        x={badgeX}
        y={badgeY}
        fill="#ffffff"
        fontSize={radius * 1.05}
        fontWeight="700"
        textAnchor="middle"
        alignmentBaseline="central"
      >
        {String(props.callout.number)}
      </SvgText>
    </G>
  );
}

function CalloutSelectionShape(props: {
  readonly callout: PreviewAnnotationCallout;
  readonly imageSize: MarkupSize;
}) {
  const shortSide = Math.min(props.imageSize.width, props.imageSize.height);
  const radius = shortSide * CALLOUT_BADGE_RADIUS;
  const badgeInset = radius * CALLOUT_SELECTION_RADIUS_SCALE;
  const borderWidth = shortSide * CALLOUT_REGION_STROKE_WIDTH;
  const anchor = props.callout.anchor;
  const rect = anchor.kind === "point" ? null : anchor.rect;
  const badgeX = badgeCenter(
    anchor.kind === "point"
      ? anchor.point.x * props.imageSize.width
      : rect!.x * props.imageSize.width + radius,
    badgeInset,
    props.imageSize.width,
  );
  const badgeY = badgeCenter(
    anchor.kind === "point"
      ? anchor.point.y * props.imageSize.height
      : rect!.y * props.imageSize.height + radius,
    badgeInset,
    props.imageSize.height,
  );

  return (
    <G>
      {rect ? (
        <Rect
          x={rect.x * props.imageSize.width}
          y={rect.y * props.imageSize.height}
          width={rect.width * props.imageSize.width}
          height={rect.height * props.imageSize.height}
          fill="none"
          stroke="#ffffff"
          strokeWidth={borderWidth * 1.4}
        />
      ) : null}
      <Circle
        cx={badgeX}
        cy={badgeY}
        r={badgeInset}
        fill="none"
        stroke="#ffffff"
        strokeWidth={borderWidth * 1.4}
      />
    </G>
  );
}

function CommittedMarkupContent(props: {
  readonly backgroundDataUrl: string;
  readonly document: MarkupDocument;
  readonly imageSize: MarkupSize;
  readonly onBackgroundLoad?: () => void;
}) {
  const shortSide = Math.min(props.imageSize.width, props.imageSize.height);
  return (
    <>
      <SvgImage
        x={0}
        y={0}
        width={props.imageSize.width}
        height={props.imageSize.height}
        href={props.backgroundDataUrl}
        preserveAspectRatio="none"
        onLoad={props.onBackgroundLoad}
      />
      {props.document.strokes.map((stroke) => (
        <Path
          key={stroke.id}
          d={pathForNormalizedPoints(stroke.points, props.imageSize)}
          fill="none"
          stroke={stroke.color}
          strokeWidth={stroke.width * shortSide}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {props.document.callouts.map((callout) => (
        <CalloutShape key={callout.id} callout={callout} imageSize={props.imageSize} />
      ))}
    </>
  );
}

function ActiveStrokeChunk(props: {
  readonly paths: SharedValue<ReadonlyArray<string>>;
  readonly index: number;
  readonly strokeWidth: number;
}) {
  const animatedProps = useAnimatedProps(() => ({
    d: props.paths.value[props.index] ?? "",
  }));
  return (
    <AnimatedPath
      animatedProps={animatedProps}
      fill="none"
      stroke={DEFAULT_STROKE_COLOR}
      strokeWidth={props.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

function emptyActiveStrokePaths(): ReadonlyArray<string> {
  return Array.from({ length: ACTIVE_STROKE_CHUNK_COUNT }, () => "");
}

interface ExportRenderRequest {
  readonly id: number;
  readonly document: MarkupDocument;
  readonly layoutSize: MarkupSize;
}

export function ImageMarkupModal(props: ImageMarkupModalProps) {
  const attachment = props.attachment;
  const semanticElements = props.semanticElements ?? [];
  const hasSemanticElements = semanticElements.length > 0;
  const muted = useThemeColor("--color-foreground-muted");
  const border = useThemeColor("--color-border");
  const card = useThemeColor("--color-card");
  const screen = useThemeColor("--color-screen");
  const primary = useThemeColor("--color-primary");
  const placeholder = useThemeColor("--color-placeholder");

  const [tool, setTool] = useState<MarkupTool>("point");
  const [history, setHistory] = useState<MarkupHistory>(() =>
    createMarkupHistory(
      attachment ? markupDocumentFromAttachment(attachment) : EMPTY_MARKUP_DOCUMENT,
    ),
  );
  const [selection, setSelection] = useState<MarkupSelection | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [sourceSize, setSourceSize] = useState<MarkupSize | null>(null);
  const [containerSize, setContainerSize] = useState<MarkupSize>({ width: 0, height: 0 });
  const [backgroundReady, setBackgroundReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [annotationId, setAnnotationId] = useState("");
  const [createdAt, setCreatedAt] = useState("");
  const [exportRenderRequest, setExportRenderRequest] = useState<ExportRenderRequest | null>(null);
  const exportSvgRef = useRef<Svg>(null);
  const exportRenderIdRef = useRef(0);
  const exportRenderPromiseRef = useRef<{
    readonly id: number;
    readonly resolve: (base64: string) => void;
    readonly reject: (cause: Error) => void;
  } | null>(null);
  const sessionIdRef = useRef(0);
  const activeExportIdRef = useRef(0);
  const isSessionActiveRef = useRef(false);
  const isExportingRef = useRef(false);

  const activeStrokePaths = useSharedValue<ReadonlyArray<string>>(emptyActiveStrokePaths());
  const activeStrokePoints = useSharedValue<Array<PreviewAnnotationNormalizedPoint>>([]);
  const activeRegionStartX = useSharedValue(0);
  const activeRegionStartY = useSharedValue(0);
  const activeRegionX = useSharedValue(0);
  const activeRegionY = useSharedValue(0);
  const activeRegionWidth = useSharedValue(0);
  const activeRegionHeight = useSharedValue(0);

  const original = attachment ? originalImageFromAttachment(attachment) : null;
  const fit = useMemo(
    () => (sourceSize ? aspectFit(sourceSize, containerSize) : { x: 0, y: 0, width: 0, height: 0 }),
    [containerSize, sourceSize],
  );
  const currentCallout = selectedCallout(history.present, selection);

  useEffect(() => {
    if (!props.visible || !attachment) return;
    const sessionId = sessionIdRef.current + 1;
    sessionIdRef.current = sessionId;
    isSessionActiveRef.current = true;
    isExportingRef.current = false;
    setHistory(createMarkupHistory(markupDocumentFromAttachment(attachment)));
    setSelection(null);
    setCommentDraft("");
    setTool(hasSemanticElements ? "element" : "point");
    setSourceSize(null);
    setBackgroundReady(false);
    setError(null);
    setIsExporting(false);
    setExportRenderRequest(null);
    setAnnotationId(attachment.markup?.annotation.id ?? uuidv4());
    setCreatedAt(attachment.markup?.annotation.createdAt ?? new Date().toISOString());
    activeStrokePaths.value = emptyActiveStrokePaths();
    activeStrokePoints.value = [];
    activeRegionWidth.value = 0;
    activeRegionHeight.value = 0;

    let cancelled = false;
    const durableSource = originalImageFromAttachment(attachment).dataUrl;
    void Image.getSize(durableSource)
      .then((size) => {
        if (!cancelled) {
          setSourceSize({ width: size.width, height: size.height });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("This image could not be opened for markup.");
        }
      });
    return () => {
      cancelled = true;
      exportRenderPromiseRef.current?.reject(
        new Error("The annotation image export was cancelled."),
      );
      exportRenderPromiseRef.current = null;
      if (sessionIdRef.current === sessionId) {
        sessionIdRef.current += 1;
        isSessionActiveRef.current = false;
      }
    };
  }, [
    activeRegionHeight,
    activeRegionWidth,
    activeStrokePaths,
    activeStrokePoints,
    attachment,
    hasSemanticElements,
    props.visible,
  ]);

  useEffect(() => {
    if (!selection) return;
    const stillExists =
      selection.kind === "callout"
        ? history.present.callouts.some((callout) => callout.id === selection.id)
        : history.present.strokes.some((stroke) => stroke.id === selection.id);
    if (!stillExists) setSelection(null);
  }, [history.present, selection]);

  useEffect(() => {
    setCommentDraft(currentCallout?.comment ?? "");
  }, [currentCallout?.comment, currentCallout?.id]);

  useEffect(() => {
    activeStrokePaths.value = emptyActiveStrokePaths();
    activeStrokePoints.value = [];
    activeRegionWidth.value = 0;
    activeRegionHeight.value = 0;
  }, [activeRegionHeight, activeRegionWidth, activeStrokePaths, activeStrokePoints, tool]);

  const renderExportPng = useCallback(
    (size: MarkupSize, document: MarkupDocument) =>
      new Promise<string>((resolve, reject) => {
        exportRenderPromiseRef.current?.reject(
          new Error("A newer annotation image export replaced this one."),
        );
        const id = exportRenderIdRef.current + 1;
        exportRenderIdRef.current = id;
        exportRenderPromiseRef.current = { id, resolve, reject };
        setExportRenderRequest({
          id,
          document,
          layoutSize: annotationExportLayoutSize(size, PixelRatio.get()),
        });
      }),
    [],
  );

  const completeExportRender = useCallback((id: number) => {
    requestAnimationFrame(() => {
      const pending = exportRenderPromiseRef.current;
      if (!pending || pending.id !== id) return;
      void svgPngBase64(exportSvgRef.current)
        .then((base64) => {
          if (exportRenderPromiseRef.current?.id !== id) return;
          exportRenderPromiseRef.current = null;
          pending.resolve(base64);
        })
        .catch((cause: unknown) => {
          if (exportRenderPromiseRef.current?.id !== id) return;
          exportRenderPromiseRef.current = null;
          pending.reject(
            cause instanceof Error
              ? cause
              : new Error("The annotation image could not be rendered."),
          );
        })
        .finally(() => {
          setExportRenderRequest((current) => (current?.id === id ? null : current));
        });
    });
  }, []);

  const commitDocument = useCallback((update: (document: MarkupDocument) => MarkupDocument) => {
    setHistory((current) => commitMarkupDocument(current, update(current.present)));
  }, []);

  const commitCurrentComment = useCallback(() => {
    if (!currentCallout) return;
    commitDocument((document) => updateCalloutComment(document, currentCallout.id, commentDraft));
  }, [commentDraft, commitDocument, currentCallout]);

  const handleCanvasTap = useCallback(
    (x: number, y: number) => {
      if (fit.width <= 0 || fit.height <= 0) return;
      commitCurrentComment();
      const point = normalizedPoint({ x, y }, fit);
      if (tool === "point") {
        const id = uuidv4();
        commitDocument((document) => addPointCallout(document, { id, point }));
        setSelection({ kind: "callout", id });
        return;
      }
      if (tool === "element") {
        let selected: ImageMarkupSemanticElement | null = null;
        let selectedArea = Number.POSITIVE_INFINITY;
        for (const candidate of semanticElements) {
          const rect = candidate.rect;
          const contains =
            point.x >= rect.x &&
            point.x <= rect.x + rect.width &&
            point.y >= rect.y &&
            point.y <= rect.y + rect.height;
          const area = rect.width * rect.height;
          if (contains && area < selectedArea) {
            selected = candidate;
            selectedArea = area;
          }
        }
        if (!selected) {
          setSelection(null);
          return;
        }
        const id = uuidv4();
        commitDocument((document) =>
          addElementCallout(document, {
            id,
            targetId: selected!.target.id,
            rect: selected!.rect,
          }),
        );
        setSelection({ kind: "callout", id });
        return;
      }
      setSelection(hitTestMarkupObject(history.present, point, fit));
    },
    [commitCurrentComment, commitDocument, fit, history.present, semanticElements, tool],
  );

  const commitRegion = useCallback(
    (startX: number, startY: number, endX: number, endY: number) => {
      const rect = normalizedRectFromPoints({ x: startX, y: startY }, { x: endX, y: endY });
      if (!rect) return;
      commitCurrentComment();
      const id = uuidv4();
      commitDocument((document) => addRegionCallout(document, { id, rect }));
      setSelection({ kind: "callout", id });
    },
    [commitCurrentComment, commitDocument],
  );

  const commitStroke = useCallback(
    (points: ReadonlyArray<PreviewAnnotationNormalizedPoint>) => {
      const stroke = makeStroke({
        id: uuidv4(),
        color: DEFAULT_STROKE_COLOR,
        width: DEFAULT_NORMALIZED_STROKE_WIDTH,
        points,
      });
      if (!stroke) return;
      commitCurrentComment();
      commitDocument((document) => addStroke(document, stroke));
      setSelection({ kind: "stroke", id: stroke.id });
    },
    [commitCurrentComment, commitDocument],
  );

  const eraseAt = useCallback(
    (x: number, y: number) => {
      if (fit.width <= 0 || fit.height <= 0) return;
      const point = normalizedPoint({ x, y }, fit);
      commitCurrentComment();
      commitDocument((document) => eraseMarkupObjectAtPoint(document, point, fit));
      setSelection(null);
    },
    [commitCurrentComment, commitDocument, fit],
  );

  const canvasGesture = useMemo(() => {
    if (!sourceSize || fit.width <= 0 || fit.height <= 0) {
      return Gesture.Tap().enabled(false);
    }
    if (tool === "select" || tool === "element" || tool === "point") {
      return Gesture.Tap().onEnd((event, success) => {
        if (success) runOnJS(handleCanvasTap)(event.x, event.y);
      });
    }
    if (tool === "region") {
      return Gesture.Pan()
        .minDistance(0)
        .maxPointers(1)
        .onBegin((event) => {
          const normalizedX = Math.max(0, Math.min(1, event.x / fit.width));
          const normalizedY = Math.max(0, Math.min(1, event.y / fit.height));
          activeRegionStartX.value = normalizedX;
          activeRegionStartY.value = normalizedY;
          activeRegionX.value = normalizedX * sourceSize.width;
          activeRegionY.value = normalizedY * sourceSize.height;
          activeRegionWidth.value = 0;
          activeRegionHeight.value = 0;
        })
        .onUpdate((event) => {
          const normalizedX = Math.max(0, Math.min(1, event.x / fit.width));
          const normalizedY = Math.max(0, Math.min(1, event.y / fit.height));
          activeRegionX.value = Math.min(activeRegionStartX.value, normalizedX) * sourceSize.width;
          activeRegionY.value = Math.min(activeRegionStartY.value, normalizedY) * sourceSize.height;
          activeRegionWidth.value =
            Math.abs(normalizedX - activeRegionStartX.value) * sourceSize.width;
          activeRegionHeight.value =
            Math.abs(normalizedY - activeRegionStartY.value) * sourceSize.height;
        })
        .onEnd((event) => {
          const endX = Math.max(0, Math.min(1, event.x / fit.width));
          const endY = Math.max(0, Math.min(1, event.y / fit.height));
          runOnJS(commitRegion)(activeRegionStartX.value, activeRegionStartY.value, endX, endY);
          activeRegionWidth.value = 0;
          activeRegionHeight.value = 0;
        })
        .onFinalize(() => {
          activeRegionWidth.value = 0;
          activeRegionHeight.value = 0;
        });
    }
    if (tool === "erase") {
      return Gesture.Pan()
        .minDistance(0)
        .maxPointers(1)
        .onBegin((event) => {
          runOnJS(eraseAt)(event.x, event.y);
        })
        .onUpdate((event) => {
          runOnJS(eraseAt)(event.x, event.y);
        });
    }
    return Gesture.Pan()
      .minDistance(0)
      .maxPointers(1)
      .onBegin((event) => {
        const x = Math.max(0, Math.min(1, event.x / fit.width));
        const y = Math.max(0, Math.min(1, event.y / fit.height));
        const point = { x, y };
        activeStrokePoints.value = [point];
        const sourcePoint = `${x * sourceSize.width} ${y * sourceSize.height}`;
        activeStrokePaths.value = activeStrokePaths.value.map((_, index) =>
          index === 0 ? `M ${sourcePoint} L ${sourcePoint}` : "",
        );
      })
      .onUpdate((event) => {
        const x = Math.max(0, Math.min(1, event.x / fit.width));
        const y = Math.max(0, Math.min(1, event.y / fit.height));
        const points = activeStrokePoints.value;
        const previous = points.at(-1);
        if (
          !previous ||
          points.length >= MAX_ACTIVE_STROKE_POINTS ||
          Math.abs(previous.x - x) + Math.abs(previous.y - y) < MIN_ACTIVE_STROKE_DISTANCE
        ) {
          return;
        }

        const segmentIndex = points.length - 1;
        const chunkIndex = Math.floor(segmentIndex / ACTIVE_STROKE_POINTS_PER_CHUNK);
        const startsChunk = segmentIndex % ACTIVE_STROKE_POINTS_PER_CHUNK === 0;
        const previousSourcePoint = `${previous.x * sourceSize.width} ${previous.y * sourceSize.height}`;
        const sourcePoint = `${x * sourceSize.width} ${y * sourceSize.height}`;
        activeStrokePoints.modify((current) => {
          current.push({ x, y });
          return current;
        });
        activeStrokePaths.modify((current) => {
          const paths = [...current];
          paths[chunkIndex] = startsChunk
            ? `M ${previousSourcePoint} L ${sourcePoint}`
            : `${paths[chunkIndex]} L ${sourcePoint}`;
          return paths;
        });
      })
      .onEnd(() => {
        const points = [...activeStrokePoints.value];
        if (points.length > 0) runOnJS(commitStroke)(points);
        activeStrokePoints.value = [];
        activeStrokePaths.value = activeStrokePaths.value.map(() => "");
      })
      .onFinalize(() => {
        activeStrokePoints.value = [];
        activeStrokePaths.value = activeStrokePaths.value.map(() => "");
      });
  }, [
    activeRegionHeight,
    activeRegionStartX,
    activeRegionStartY,
    activeRegionWidth,
    activeRegionX,
    activeRegionY,
    activeStrokePaths,
    activeStrokePoints,
    commitRegion,
    commitStroke,
    eraseAt,
    fit.height,
    fit.width,
    handleCanvasTap,
    sourceSize,
    tool,
  ]);

  const activeRegionAnimatedProps = useAnimatedProps(() => ({
    x: activeRegionX.value,
    y: activeRegionY.value,
    width: activeRegionWidth.value,
    height: activeRegionHeight.value,
  }));

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setContainerSize({
      width: event.nativeEvent.layout.width,
      height: event.nativeEvent.layout.height,
    });
  }, []);

  const handleCancel = useCallback(() => {
    if (isExportingRef.current) return;
    sessionIdRef.current += 1;
    isSessionActiveRef.current = false;
    props.onCancel();
  }, [props.onCancel]);

  const handleDone = useCallback(async () => {
    if (
      isExportingRef.current ||
      !attachment ||
      !sourceSize ||
      !backgroundReady ||
      markupDocumentIsEmpty(history.present)
    ) {
      return;
    }
    const document =
      currentCallout === null
        ? history.present
        : updateCalloutComment(history.present, currentCallout.id, commentDraft);
    const sessionId = sessionIdRef.current;
    const exportId = activeExportIdRef.current + 1;
    activeExportIdRef.current = exportId;
    isExportingRef.current = true;
    setIsExporting(true);
    setError(null);
    try {
      const durableOriginal = originalImageFromAttachment(attachment);
      const originalSizeBytes = dataUrlByteSize(durableOriginal.dataUrl, durableOriginal.sizeBytes);
      const flattenedByteBudget = remainingAnnotationExportByteBudget(
        originalSizeBytes,
        PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
      );
      const initialExportSize = annotationExportSize(sourceSize);
      const flattened = await exportFlattenedPng(
        (size) => renderExportPng(size, document),
        initialExportSize,
        flattenedByteBudget,
      );
      if (
        !isSessionActiveRef.current ||
        sessionIdRef.current !== sessionId ||
        activeExportIdRef.current !== exportId
      ) {
        return;
      }
      const flattenedDataUrl = `data:image/png;base64,${flattened.base64}`;
      props.onDone(
        buildAnnotatedImageAttachment({
          attachment,
          document,
          sourceSize,
          exportSize: flattened.size,
          annotationId,
          createdAt,
          flattenedDataUrl,
          flattenedSizeBytes: flattened.sizeBytes,
          semanticElements: semanticElements.map((candidate) => candidate.target),
        }),
      );
    } catch (cause) {
      if (
        isSessionActiveRef.current &&
        sessionIdRef.current === sessionId &&
        activeExportIdRef.current === exportId
      ) {
        setError(
          cause instanceof Error ? cause.message : "The annotated image could not be saved.",
        );
      }
    } finally {
      if (activeExportIdRef.current === exportId) {
        isExportingRef.current = false;
        if (isSessionActiveRef.current && sessionIdRef.current === sessionId) {
          setIsExporting(false);
        }
      }
    }
  }, [
    annotationId,
    attachment,
    backgroundReady,
    commentDraft,
    createdAt,
    currentCallout,
    history.present,
    props,
    renderExportPng,
    semanticElements,
    sourceSize,
  ]);

  if (!attachment || !original) {
    return null;
  }

  const shortSide = sourceSize ? Math.min(sourceSize.width, sourceSize.height) : 1;
  const canDelete = selection !== null;
  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;
  const selectedStroke =
    selection?.kind === "stroke"
      ? (history.present.strokes.find((stroke) => stroke.id === selection.id) ?? null)
      : null;
  const canDone =
    sourceSize !== null &&
    backgroundReady &&
    !markupDocumentIsEmpty(history.present) &&
    !isExporting;

  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={handleCancel}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: screen }}>
        <View
          className="h-14 flex-row items-center justify-between border-b px-4"
          style={{ borderColor: border }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel markup"
            disabled={isExporting}
            onPress={handleCancel}
            className="h-11 justify-center pr-4"
          >
            <Text className="text-base">Cancel</Text>
          </Pressable>
          <View className="min-w-0 flex-1 items-center">
            <Text numberOfLines={1} className="text-sm font-t3-bold">
              Markup
            </Text>
            <Text numberOfLines={1} className="text-2xs text-foreground-muted">
              {original.name}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save markup"
            accessibilityState={{ disabled: !canDone }}
            disabled={!canDone}
            onPress={() => void handleDone()}
            className="h-11 min-w-16 items-end justify-center pl-4"
          >
            {isExporting ? (
              <ActivityIndicator size="small" color={primary} />
            ) : (
              <Text className="text-base font-t3-bold" style={{ color: canDone ? primary : muted }}>
                Done
              </Text>
            )}
          </Pressable>
        </View>

        <KeyboardAvoidingView automaticOffset behavior="padding" style={{ flex: 1, minHeight: 0 }}>
          <View className="min-h-0 flex-1 bg-black" onLayout={handleLayout}>
            {sourceSize && original && exportRenderRequest ? (
              <Svg
                key={exportRenderRequest.id}
                ref={exportSvgRef}
                width={exportRenderRequest.layoutSize.width}
                height={exportRenderRequest.layoutSize.height}
                viewBox={`0 0 ${sourceSize.width} ${sourceSize.height}`}
                preserveAspectRatio="none"
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: -exportRenderRequest.layoutSize.width - 8,
                  top: 0,
                }}
              >
                <CommittedMarkupContent
                  backgroundDataUrl={original.dataUrl}
                  document={exportRenderRequest.document}
                  imageSize={sourceSize}
                  onBackgroundLoad={() => completeExportRender(exportRenderRequest.id)}
                />
              </Svg>
            ) : null}
            {sourceSize && fit.width > 0 && fit.height > 0 ? (
              <View
                style={{
                  position: "absolute",
                  left: fit.x,
                  top: fit.y,
                  width: fit.width,
                  height: fit.height,
                }}
              >
                <GestureDetector gesture={canvasGesture}>
                  <Animated.View style={{ flex: 1 }}>
                    <Svg
                      width="100%"
                      height="100%"
                      viewBox={`0 0 ${sourceSize.width} ${sourceSize.height}`}
                      preserveAspectRatio="xMidYMid meet"
                      pointerEvents="none"
                    >
                      <CommittedMarkupContent
                        backgroundDataUrl={original.dataUrl}
                        document={history.present}
                        imageSize={sourceSize}
                        onBackgroundLoad={() => setBackgroundReady(true)}
                      />
                    </Svg>
                    <Svg
                      width="100%"
                      height="100%"
                      viewBox={`0 0 ${sourceSize.width} ${sourceSize.height}`}
                      preserveAspectRatio="xMidYMid meet"
                      pointerEvents="none"
                      style={{
                        position: "absolute",
                        top: 0,
                        right: 0,
                        bottom: 0,
                        left: 0,
                      }}
                    >
                      {selectedStroke ? (
                        <G>
                          <Path
                            d={pathForNormalizedPoints(selectedStroke.points, sourceSize)}
                            fill="none"
                            stroke="#ffffff"
                            strokeWidth={selectedStroke.width * shortSide * 2}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeOpacity={0.9}
                          />
                          <Path
                            d={pathForNormalizedPoints(selectedStroke.points, sourceSize)}
                            fill="none"
                            stroke={selectedStroke.color}
                            strokeWidth={selectedStroke.width * shortSide}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </G>
                      ) : null}
                      {tool === "element"
                        ? semanticElements.map((candidate) => (
                            <Rect
                              key={candidate.target.id}
                              x={candidate.rect.x * sourceSize.width}
                              y={candidate.rect.y * sourceSize.height}
                              width={candidate.rect.width * sourceSize.width}
                              height={candidate.rect.height * sourceSize.height}
                              fill={DEFAULT_STROKE_COLOR}
                              fillOpacity={0.035}
                              stroke={DEFAULT_STROKE_COLOR}
                              strokeOpacity={0.7}
                              strokeWidth={CALLOUT_REGION_STROKE_WIDTH * shortSide}
                            />
                          ))
                        : null}
                      {currentCallout ? (
                        <CalloutSelectionShape callout={currentCallout} imageSize={sourceSize} />
                      ) : null}
                      {Array.from({ length: ACTIVE_STROKE_CHUNK_COUNT }, (_, index) => (
                        <ActiveStrokeChunk
                          key={index}
                          paths={activeStrokePaths}
                          index={index}
                          strokeWidth={DEFAULT_NORMALIZED_STROKE_WIDTH * shortSide}
                        />
                      ))}
                      <AnimatedRect
                        animatedProps={activeRegionAnimatedProps}
                        fill={DEFAULT_STROKE_COLOR}
                        fillOpacity={ACTIVE_REGION_FILL_OPACITY}
                        stroke={DEFAULT_STROKE_COLOR}
                        strokeWidth={CALLOUT_REGION_STROKE_WIDTH * shortSide}
                        strokeDasharray={`${shortSide * 0.006} ${shortSide * 0.004}`}
                      />
                    </Svg>
                  </Animated.View>
                </GestureDetector>
              </View>
            ) : error ? (
              <View className="flex-1 items-center justify-center px-8">
                <Text className="text-center text-sm text-white">{error}</Text>
              </View>
            ) : (
              <View className="flex-1 items-center justify-center">
                <ActivityIndicator color="#ffffff" />
              </View>
            )}
          </View>

          {currentCallout ? (
            <View
              className="border-t px-4 py-3"
              style={{ borderColor: border, backgroundColor: card }}
            >
              <Text className="mb-1.5 text-xs font-t3-bold">
                Comment for #{currentCallout.number}
              </Text>
              <TextInput
                value={commentDraft}
                onChangeText={setCommentDraft}
                onBlur={() =>
                  commitDocument((document) =>
                    updateCalloutComment(document, currentCallout.id, commentDraft),
                  )
                }
                placeholder="Describe the requested change"
                placeholderTextColor={placeholder}
                multiline
                className="min-h-11 rounded-xl border px-3 py-2 text-base text-foreground"
                style={{ borderColor: border }}
              />
            </View>
          ) : null}

          {error && sourceSize ? (
            <View className="border-t border-border bg-card px-4 py-2">
              <Text className="text-center text-xs text-danger-foreground">{error}</Text>
            </View>
          ) : null}

          <View className="border-t bg-card" style={{ borderColor: border }}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 8, alignItems: "center" }}
            >
              <MarkupToolbarButton
                label="Select"
                icon="checkmark.circle"
                active={tool === "select"}
                onPress={() => setTool("select")}
              />
              {hasSemanticElements ? (
                <MarkupToolbarButton
                  label="Element"
                  icon="eye"
                  active={tool === "element"}
                  onPress={() => setTool("element")}
                />
              ) : null}
              <MarkupToolbarButton
                label="Pin"
                icon="plus"
                active={tool === "point"}
                onPress={() => setTool("point")}
              />
              <MarkupToolbarButton
                label="Region"
                icon="square.dashed"
                active={tool === "region"}
                onPress={() => setTool("region")}
              />
              <MarkupToolbarButton
                label="Pen"
                icon="pencil.tip"
                active={tool === "pen"}
                onPress={() => setTool("pen")}
              />
              <MarkupToolbarButton
                label="Eraser"
                icon="eraser"
                active={tool === "erase"}
                onPress={() => setTool("erase")}
              />
              <MarkupToolbarButton
                label="Undo"
                icon="arrow.uturn.backward"
                disabled={!canUndo}
                onPress={() => {
                  setHistory(undoMarkupHistory);
                  setSelection(null);
                }}
              />
              <MarkupToolbarButton
                label="Redo"
                icon="arrow.uturn.forward"
                disabled={!canRedo}
                onPress={() => {
                  setHistory(redoMarkupHistory);
                  setSelection(null);
                }}
              />
              <MarkupToolbarButton
                label="Delete"
                icon="trash"
                destructive
                disabled={!canDelete}
                onPress={() => {
                  commitDocument((document) => deleteMarkupObject(document, selection));
                  setSelection(null);
                }}
              />
              <MarkupToolbarButton
                label="Clear"
                icon="xmark.circle"
                destructive
                disabled={markupDocumentIsEmpty(history.present)}
                onPress={() => {
                  commitDocument(clearMarkupDocument);
                  setSelection(null);
                }}
              />
            </ScrollView>
            {attachment.markup ? (
              <View className="items-center border-t px-4 py-2" style={{ borderColor: border }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Remove markup"
                  disabled={isExporting}
                  onPress={() => props.onDone(restoreComposerImageOriginal(attachment))}
                  className="h-9 justify-center px-4"
                >
                  <Text className="text-xs font-t3-bold text-danger-foreground">Remove markup</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
