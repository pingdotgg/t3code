import { BOARDS_DIR } from "./board";

export const ARTIFACT_KINDS = [
  "screenshot",
  "proof",
  "script",
  "diff",
  "report",
  "brief",
  "review",
  "plan",
  "design",
  "decisions",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const KIND_LABEL = {
  screenshot: "Screenshot",
  proof: "Proof",
  script: "Script",
  diff: "Diff",
  report: "Report",
  brief: "Brief",
  review: "Review",
  plan: "Plan",
  design: "Design",
  decisions: "Decisions",
} as const satisfies Record<ArtifactKind, string>;

interface Folder {
  readonly kind: ArtifactKind | null;
  readonly keyed: boolean;
}

/** The top-level folders of a store that hold artifacts. A file in the store's root is one only when `ROOT_FILES` names it. */
const FOLDERS = {
  // `artifacts/<KEY>/` holds a ticket's evidence, so its extension says what each file is.
  artifacts: { kind: null, keyed: true },
  review: { kind: "review", keyed: true },
  inbox: { kind: "brief", keyed: false },
} as const satisfies Record<string, Folder>;

const BY_EXTENSION = {
  png: "screenshot",
  jpg: "screenshot",
  jpeg: "screenshot",
  gif: "screenshot",
  webp: "screenshot",
  sh: "script",
  mts: "script",
  ts: "script",
  mjs: "script",
  js: "script",
  py: "script",
  patch: "diff",
  diff: "diff",
  md: "report",
} as const satisfies Record<string, ArtifactKind>;

/** What a file is called decides its kind before its folder or extension does. */
const BY_NAME = {
  "README.txt": "report",
  "plan.md": "plan",
  "brief.md": "brief",
  "design.md": "design",
  "decisions.tsv": "decisions",
} as const satisfies Record<string, ArtifactKind>;

/** The files in the store's root that are artifacts. Every other root file is the store's own. */
const ROOT_FILES = {
  "plan.md": true,
  "brief.md": true,
  "design.md": true,
  "decisions.tsv": true,
} as const satisfies Record<string, true>;

/** A name from a path is untrusted, so `constructor` must not find an inherited member. */
const own = <V>(table: Readonly<Record<string, V>>, key: string): V | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

export interface ArtifactRef {
  /** The path under the store folder, with `/` separators. */
  readonly path: string;
  readonly name: string;
  readonly kind: ArtifactKind;
  /** The ticket the file is evidence for, or null for a board-level file. */
  readonly ticketKey: string | null;
}

export const isImagePath = (path: string): boolean =>
  own(BY_EXTENSION, extensionOf(path.slice(path.lastIndexOf("/") + 1))) === "screenshot";

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * The artifact a path under the store folder is, or null for a file that is not one, such as
 * `tickets.json`. An image is a screenshot wherever it sits.
 */
export function classifyArtifact(path: string): ArtifactRef | null {
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment.startsWith("."))) return null;
  const name = segments.at(-1) ?? "";
  const [first = ""] = segments;
  const inFolder = segments.length > 1;
  const extension = extensionOf(name);

  const folder = inFolder ? (own(FOLDERS, first) ?? null) : null;
  if (inFolder ? folder === null : own(ROOT_FILES, name) === undefined) return null;

  const byExtension = own(BY_EXTENSION, extension);
  const kind =
    byExtension === "screenshot"
      ? "screenshot"
      : (own(BY_NAME, name) ?? folder?.kind ?? byExtension ?? "proof");
  const ticketKey = folder?.keyed === true && segments.length > 2 ? (segments[1] ?? null) : null;
  return { path, name, kind, ticketKey };
}

/**
 * Where an agent leaves its evidence inside its own worktree. The folder holds one folder per
 * ticket key, as the store's `artifacts/` does.
 */
export const WORKTREE_ARTIFACTS = ".omp/artifacts";

/** The kinds review and merge readiness rely on, so a person never rewrites them. */
const EVIDENCE_KINDS: ReadonlySet<ArtifactKind> = new Set([
  "screenshot",
  "proof",
  "script",
  "diff",
  "decisions",
]);

export type EditAccess =
  | { readonly editable: true }
  | { readonly editable: false; readonly reason: string };

const EVIDENCE: EditAccess = { editable: false, reason: "Evidence stays read-only." };
const ORCHESTRATOR: EditAccess = { editable: false, reason: "The orchestrator owns this file." };

const accessOf = (ref: ArtifactRef | null): EditAccess =>
  ref !== null && EVIDENCE_KINDS.has(ref.kind) ? EVIDENCE : { editable: true };

/**
 * Whether the app opens a file for edit. The path is relative to the root it was listed under, the
 * project or a ticket worktree, with `/` separators. A board store holds the orchestrator's own
 * files beside the artifacts, so only the store's artifacts that are not evidence are editable.
 */
export function editAccess(path: string): EditAccess {
  if (path.startsWith(`${BOARDS_DIR}/`)) {
    const inStore = path.split("/").slice(2).join("/");
    const ref = inStore === "" ? null : classifyArtifact(inStore);
    return ref === null ? ORCHESTRATOR : accessOf(ref);
  }
  if (path.startsWith(`${WORKTREE_ARTIFACTS}/`)) {
    return accessOf(classifyArtifact(`artifacts/${path.slice(WORKTREE_ARTIFACTS.length + 1)}`));
  }
  return { editable: true };
}

export interface ArtifactGroups<A extends ArtifactRef> {
  readonly byTicket: ReadonlyMap<string, ReadonlyArray<A>>;
  /** Board-level files, and files for a key no ticket carries, which would otherwise show nowhere. */
  readonly board: ReadonlyArray<A>;
}

export function groupArtifacts<A extends ArtifactRef>(
  artifacts: ReadonlyArray<A>,
  ticketKeys: ReadonlyArray<string>,
): ArtifactGroups<A> {
  const known = new Set(ticketKeys);
  const byTicket = new Map<string, A[]>();
  const board: A[] = [];
  for (const artifact of artifacts) {
    const key = artifact.ticketKey;
    if (key === null || !known.has(key)) {
      board.push(artifact);
    } else {
      byTicket.set(key, [...(byTicket.get(key) ?? []), artifact]);
    }
  }
  return { byTicket, board };
}

export interface ReadmeEntry {
  /** The file as the README wrote it, relative to the README's folder. */
  readonly file: string;
  /** What the README says the file proves, or an empty string when it says nothing. */
  readonly proves: string;
}

// A file line starts at the left edge with a path that has an extension or ends in `/`,
// and has nothing after it, or its description after two spaces.
const FILE_LINE = /^(\S+\.[A-Za-z0-9]+|\S+\/)(?:\s{2,}(\S.*))?\s*$/;

/**
 * The files a ticket's `README.txt` lists and what each proves. Evidence READMEs put the file on
 * its own line with the description indented under it, or on the same line after two spaces.
 */
export function parseReadme(text: string): ReadonlyArray<ReadmeEntry> {
  const entries: Array<{ file: string; lines: string[] }> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = FILE_LINE.exec(line);
    if (match !== null) {
      entries.push({ file: match[1] ?? "", lines: match[2] === undefined ? [] : [match[2]] });
    } else if (/^\s+\S/.test(line)) {
      entries.at(-1)?.lines.push(line.trim());
    } else if (line.trim() !== "" && entries.at(-1) !== undefined) {
      // A prose line at the left edge ends the entry above it.
      entries.push({ file: "", lines: [] });
    }
  }
  return entries
    .filter((entry) => entry.file !== "")
    .map((entry) => ({ file: entry.file, proves: entry.lines.join(" ").replace(/\s+/g, " ") }));
}
