import {
  COMPOSER_CONTEXT_PREVIEW_COMMENT_MAX_CHARS,
  type PreviewAnnotationPayload,
} from "@t3tools/contracts";
import { modelPreviewKind } from "@t3tools/shared/filePreview";
import {
  encodeMarkdownLinkDestination,
  isRelativeFilePath,
  normalizeMarkdownLinkDestination,
  parseMarkdownFileLink,
  safeDecodeURIComponent,
  splitMarkdownLinkSearchAndHash,
} from "@t3tools/shared/markdownLinks";

/** Callers refuse larger files before loading them; parsing runs on the main thread. */
export const MAX_MODEL_BYTES = 128 * 1024 * 1024;

export type Vec3 = readonly [number, number, number];

/** A model's bounding size for the toolbar, at three significant figures. */
export function formatModelSize(size: Vec3): string {
  return size.map((value) => Number(value.toPrecision(3)).toLocaleString()).join(" × ");
}

/** A saved orbit camera: where it sits and the point it orbits, in scene coordinates. */
export interface ModelCameraView {
  readonly position: Vec3;
  readonly target: Vec3;
}

/** A PNG of the annotated view. Empty space is transparent so any theme can show it. */
export interface ModelCapture {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

export interface ModelPinCapture {
  readonly screenshot: ModelCapture;
  readonly view: ModelCameraView;
}

/** A numbered note pinned to a surface point, in the model's own coordinates. */
export interface ModelNote {
  readonly id: string;
  /** Kept after deletion so earlier screenshots still label the same pins. */
  readonly number: number;
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
  return VIEW_HASH_PREFIX + [...view.position, ...view.target].join(",");
}

/** Reads a camera from a supported model file link. */
export function modelViewFromHref(href: string): ModelCameraView | null {
  return modelAnnotationFileTarget(href)?.view ?? null;
}

/** Reads a camera from a `#view=` fragment, as `formatModelViewHash` writes it. */
export function modelViewFromHash(hash: string): ModelCameraView | null {
  hash = safeDecodeURIComponent(hash);
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

/** The camera's compass direction around its target and its height above the ground, in degrees. */
export function modelCameraStatus(view: ModelCameraView) {
  const [x, y, z] = view.position.map((value, axis) => value - view.target[axis]!) as [
    number,
    number,
    number,
  ];
  const radius = Math.hypot(x, y, z);
  const polar = radius === 0 ? 0 : Math.acos(Math.min(1, Math.max(-1, y / radius)));
  const degrees = (radians: number) => Math.round((radians * 180) / Math.PI);
  return { azimuth: degrees(Math.atan2(x, z)), elevation: degrees(Math.PI / 2 - polar) };
}

/** What a client keeps per model between visits, so a reload of a changed file keeps it. */
export interface ModelPreviewMemory {
  readonly fingerprint: string;
  readonly notes: ReadonlyArray<ModelNote>;
  readonly view: ModelCameraView;
  readonly wireframe: boolean;
  readonly lastPinNumber: number;
  /** The pinned view on this geometry, taken when the pins were saved. */
  readonly capture: ModelPinCapture | null;
  readonly earlierCapture: ModelPinCapture | null;
}

// Bounds what a long session keeps; the oldest model drops out first.
const MAX_REMEMBERED_MODELS = 20;

/** Stores one model's memory as the newest entry, dropping the oldest past the bound. */
export function rememberModelPreview(
  memory: Readonly<Record<string, ModelPreviewMemory>>,
  key: string,
  entry: ModelPreviewMemory,
): Readonly<Record<string, ModelPreviewMemory>> {
  const { [key]: _previous, ...rest } = memory;
  const keys = Object.keys(rest);
  const kept =
    keys.length < MAX_REMEMBERED_MODELS
      ? rest
      : Object.fromEntries(
          keys.slice(1 - MAX_REMEMBERED_MODELS).map((name) => [name, rest[name]!]),
        );
  return { ...kept, [key]: entry };
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

/** Retains the original screenshot when the loaded model no longer matches its pins. */
export function restoreModelPins(
  saved:
    | Pick<ModelPreviewMemory, "fingerprint" | "notes" | "capture" | "earlierCapture">
    | undefined,
  fingerprint: string,
) {
  const sameGeometry = saved?.fingerprint === fingerprint;
  return {
    notes: reconcileModelNotes(saved, fingerprint),
    capture: sameGeometry ? (saved?.capture ?? null) : null,
    earlierCapture: saved?.earlierCapture ?? (sameGeometry ? null : (saved?.capture ?? null)),
  };
}

const STALE_NOTE_PLACE =
  "placed on an earlier version of the model, so its point may no longer match";
const EARLIER_SCREENSHOT_LINE = "The screenshot shows the model before it last changed.";
const EARLIER_SCREENSHOT_DETAIL =
  "The original screenshot shows one saved revision. Pins added on other revisions may be absent, and removed pins may still appear.";
const EARLIER_SCREENSHOT_FOOTER = `\n${EARLIER_SCREENSHOT_LINE}\n${EARLIER_SCREENSHOT_DETAIL}`;
const NOTE_LINE = /^(\d+)\. (.*) \((surface point [-\d., e+]+|[^()]*earlier version[^()]*)\)$/;

function formatModelNote(note: ModelNote, where: string): string {
  const text = note.text
    .split(/[\r\n\v\f\u0085\u2028\u2029]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  return `${note.number}. ${text} (${where})`;
}

function modelNoteLocation(note: ModelNote): string {
  return note.stale ? STALE_NOTE_PLACE : `surface point ${note.point.map(formatNumber).join(", ")}`;
}

/** Reserves room for the notes and earlier screenshot even if the model changes. */
export function modelNotesFitAnnotation(notes: ReadonlyArray<ModelNote>): boolean {
  let length = EARLIER_SCREENSHOT_FOOTER.length + Math.max(0, notes.length - 1);
  for (const note of notes) {
    const where = modelNoteLocation(note);
    length += formatModelNote(
      note,
      where.length > STALE_NOTE_PLACE.length ? where : STALE_NOTE_PLACE,
    ).length;
    if (length > COMPOSER_CONTEXT_PREVIEW_COMMENT_MAX_CHARS) return false;
  }
  return true;
}

/**
 * The numbered notes a model annotation's comment holds, as `modelAnnotationPayload` wrote them,
 * so a client can list them. Null when the comment is not a model annotation's.
 */
export function modelAnnotationNotes(comment: string): {
  readonly notes: ReadonlyArray<Pick<ModelNote, "number" | "text" | "stale">>;
  /** The screenshot shows the model before its geometry last changed. */
  readonly earlier: boolean;
} | null {
  const lines = comment.split("\n");
  const detail = lines.at(-1) === EARLIER_SCREENSHOT_DETAIL;
  if (detail) lines.pop();
  const earlier = lines.at(-1) === EARLIER_SCREENSHOT_LINE;
  if (earlier) lines.pop();
  const notes = lines.map((line) => {
    const match = NOTE_LINE.exec(line);
    if (!match) return null;
    const number = Number(match[1]);
    return Number.isSafeInteger(number) && number > 0
      ? { number, text: match[2]!, stale: match[3] === STALE_NOTE_PLACE }
      : null;
  });
  if (notes.length === 0 || notes.some((note) => note === null)) return null;
  return { notes: notes.filter((note) => note !== null), earlier };
}

// Attachments have no workspace path to reopen, so their notes name the file under a scheme
// that never parses as a file link.
const ATTACHMENT_URL_PREFIX = "attachment:";

/**
 * Model notes as a preview annotation whose URL is a file link carrying the camera.
 * The agent reads its text, so it stays English.
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
  const comment =
    input.notes.map((note) => formatModelNote(note, modelNoteLocation(note))).join("\n") +
    (earlier ? EARLIER_SCREENSHOT_FOOTER : "");
  if (comment.length > COMPOSER_CONTEXT_PREVIEW_COMMENT_MAX_CHARS) {
    throw new RangeError("Model notes exceed the annotation comment limit.");
  }
  const path = input.linkPath;
  const explicitPath =
    path !== null && isRelativeFilePath(path) && !/^(?:\.{1,2}|~)\//.test(path)
      ? `./${path}`
      : path;
  return {
    id: input.id,
    pageUrl:
      explicitPath === null
        ? ATTACHMENT_URL_PREFIX + input.name
        : encodeMarkdownLinkDestination(explicitPath) + formatModelViewHash(input.view),
    pageTitle: input.name,
    comment,
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
  const href = normalizeMarkdownLinkDestination(pageUrl);
  const view = modelViewFromHash(splitMarkdownLinkSearchAndHash(href).hash);
  const target = view ? parseMarkdownFileLink(href) : null;
  return target && view && modelPreviewKind({ name: target.path })
    ? { path: target.path.replace(/^\.\//, ""), view }
    : null;
}
