import type { PreviewAnnotationPayload, ScopedThreadRef } from "@t3tools/contracts";
import { parseMarkdownFileLink } from "@t3tools/shared/markdownLinks";
import { create } from "zustand";

import { useRightPanelStore } from "~/rightPanelStore";

export type Vec3 = readonly [number, number, number];

/** A saved orbit camera: where it sits and the point it orbits, in scene coordinates. */
export interface ModelCameraView {
  readonly position: Vec3;
  readonly target: Vec3;
}

/** A PNG of the annotated view. */
export interface ModelCapture {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

/** A numbered note pinned to a surface point, in the model's own coordinates. */
export interface ModelNote {
  readonly id: string;
  readonly text: string;
  readonly point: Vec3;
  readonly normal: Vec3;
  /** Placed on geometry that has since changed, so the point may no longer match. */
  readonly stale: boolean;
}

const VIEW_HASH_PREFIX = "#view=";

const formatNumber = (value: number) => String(Number(value.toFixed(3)));

/** The fragment a model file link carries so opening it restores this camera. */
export function formatModelViewHash(view: ModelCameraView): string {
  return VIEW_HASH_PREFIX + [...view.position, ...view.target].map(formatNumber).join(",");
}

/** Reads a camera saved by `formatModelViewHash` from a link, or null when it has none. */
export function modelViewFromHref(href: string): ModelCameraView | null {
  const hashIndex = href.indexOf("#");
  if (hashIndex < 0) return null;
  let hash: string;
  try {
    hash = decodeURIComponent(href.slice(hashIndex));
  } catch {
    return null;
  }
  if (!hash.startsWith(VIEW_HASH_PREFIX)) return null;
  const parts = hash.slice(VIEW_HASH_PREFIX.length).split(",");
  if (parts.length !== 6 || parts.some((part) => part.trim() === "")) return null;
  const values = parts.map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [px, py, pz, tx, ty, tz] = values as [number, number, number, number, number, number];
  // A camera on its own target has no direction to look in.
  if (px === tx && py === ty && pz === tz) return null;
  return { position: [px, py, pz], target: [tx, ty, tz] };
}

/**
 * Notes stay on their points while the geometry is unchanged. Once it changes, a point
 * can sit on a different surface, so each note is kept but marked stale instead of moved.
 */
export function reconcileModelNotes(
  saved: { readonly fingerprint: string; readonly notes: ReadonlyArray<ModelNote> } | undefined,
  fingerprint: string,
): ReadonlyArray<ModelNote> {
  if (!saved) return [];
  if (saved.fingerprint === fingerprint) return saved.notes;
  return saved.notes.map((note) => (note.stale ? note : { ...note, stale: true }));
}

/** Escapes characters a link destination would otherwise end or split at. */
const linkDestination = (path: string) =>
  path.replace(
    /[\t ()<>#?%]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );

// Attachments have no workspace path to reopen, so their notes name the file under a scheme
// that never parses as a file link.
const ATTACHMENT_URL_PREFIX = "attachment:";

/**
 * Notes on a model as a preview annotation, so the chat shows, stores and sends them like an
 * annotation on a web page: one chip with the annotated screenshot. The URL is a file link
 * carrying the camera. Its text is read by the agent, so it stays English.
 */
export function modelAnnotationPayload(input: {
  readonly id: string;
  readonly name: string;
  /** A workspace path the chat can open, or null for an attachment. */
  readonly linkPath: string | null;
  readonly view: ModelCameraView;
  readonly notes: ReadonlyArray<ModelNote>;
  readonly screenshot: ModelCapture & {
    /** Shows the model before its geometry last changed. */
    readonly earlier: boolean;
  };
  readonly createdAt: string;
}): PreviewAnnotationPayload {
  const { dataUrl, width, height, earlier } = input.screenshot;
  const notes = input.notes.map((note, index) => {
    const text = note.text.trim().replace(/\s*\n\s*/g, " ");
    const where = note.stale
      ? "placed on an earlier version of the model, so its point may no longer match"
      : `surface point ${note.point.map(formatNumber).join(", ")}`;
    return `${index + 1}. ${text} (${where})`;
  });
  return {
    id: input.id,
    pageUrl:
      input.linkPath === null
        ? ATTACHMENT_URL_PREFIX + input.name
        : linkDestination(input.linkPath) + formatModelViewHash(input.view),
    pageTitle: input.name,
    comment: [
      ...notes,
      ...(earlier ? ["The screenshot shows the model before it last changed."] : []),
    ].join("\n"),
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: { dataUrl, width, height, cropRect: { x: 0, y: 0, width, height } },
    createdAt: input.createdAt,
  };
}

/** The model file and camera a model annotation's URL holds; null for any other annotation. */
export function modelAnnotationFileTarget(
  pageUrl: string,
): { readonly path: string; readonly view: ModelCameraView } | null {
  const view = modelViewFromHref(pageUrl);
  const target = view ? parseMarkdownFileLink(pageUrl) : null;
  return target && view ? { path: target.path, view } : null;
}

/** Opens a file in the thread's right panel, at a saved camera when it is a model. */
export function openFileAtModelView(
  threadRef: ScopedThreadRef,
  path: string,
  view: ModelCameraView | null,
  line?: number,
) {
  if (view) {
    useModelPreviewStore
      .getState()
      .requestView(modelPreviewKey(threadRef.environmentId, path), view);
  }
  useRightPanelStore.getState().openFile(threadRef, path, line);
}

interface ModelPreviewMemory {
  readonly fingerprint: string;
  readonly notes: ReadonlyArray<ModelNote>;
  readonly view: ModelCameraView | null;
  /** The annotated view captured before the geometry changed under stale notes. */
  readonly earlierScreenshot: ModelCapture | null;
}

interface ModelPreviewStore {
  /** Notes and camera per open model, so a reload of a changed file keeps them. */
  readonly memory: Readonly<Record<string, ModelPreviewMemory>>;
  /** Cameras requested by clicked links, applied by the viewer showing that file. */
  readonly viewRequests: Readonly<Record<string, ModelCameraView>>;
  readonly remember: (key: string, memory: ModelPreviewMemory) => void;
  readonly requestView: (key: string, view: ModelCameraView) => void;
  readonly consumeView: (key: string) => void;
}

// Bounds what a long session keeps; the oldest model drops out first.
const MAX_REMEMBERED_MODELS = 20;

export const useModelPreviewStore = create<ModelPreviewStore>()((set) => ({
  memory: {},
  viewRequests: {},
  remember: (key, memory) =>
    set((state) => {
      const { [key]: _previous, ...rest } = state.memory;
      const keys = Object.keys(rest);
      const kept =
        keys.length < MAX_REMEMBERED_MODELS
          ? rest
          : Object.fromEntries(keys.slice(1).map((entry) => [entry, rest[entry]!]));
      return { memory: { ...kept, [key]: memory } };
    }),
  requestView: (key, view) =>
    set((state) => ({
      viewRequests: { ...state.viewRequests, [key]: view },
    })),
  consumeView: (key) =>
    set((state) => {
      const { [key]: _consumed, ...viewRequests } = state.viewRequests;
      return { viewRequests };
    }),
}));

/** Identifies one model file in one environment across preview mounts. */
export const modelPreviewKey = (environmentId: string, path: string) => `${environmentId}:${path}`;
