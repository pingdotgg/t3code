import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Repo-local trailhead files; agents read present ones instead of stuffing the window. */
const STARTING_MAP_CANDIDATES = [
  {
    path: ".agents/STARTING_MAP.md",
    kind: "trailhead",
    purpose: "Preferred project starting map: short routes into the rest.",
  },
  {
    path: "AGENTS.md",
    kind: "trailhead",
    purpose: "Agent working rules and project map when no STARTING_MAP.md exists.",
  },
  {
    path: "CLAUDE.md",
    kind: "trailhead",
    purpose: "Claude-oriented instructions; skip when it only redirects to AGENTS.md.",
  },
  {
    path: "README.md",
    kind: "readme",
    purpose: "What this project is and how to get started.",
  },
  {
    path: "ARCHITECTURE.md",
    kind: "architecture",
    purpose: "How the pieces fit together.",
  },
  {
    path: "docs/internals/overview.md",
    kind: "architecture",
    purpose: "Architecture overview when ARCHITECTURE.md is absent.",
  },
  {
    path: "PROGRESS.md",
    kind: "progress",
    purpose: "Where the work stands, so you do not redo what is done.",
  },
  {
    path: "ROADMAP.md",
    kind: "progress",
    purpose: "Planned work; check before proposing a feature.",
  },
  {
    path: "CONTRIBUTING.md",
    kind: "contributing",
    purpose: "How to contribute the result.",
  },
  {
    path: "docs/",
    kind: "area",
    purpose: "Area docs: read the guide for the surface you are changing.",
  },
  {
    path: ".agents/ROSTER.md",
    kind: "roster",
    purpose: "Who on the team knows which area.",
  },
] as const;

export type StartingMapRouteKind = (typeof STARTING_MAP_CANDIDATES)[number]["kind"];

export interface StartingMapRoute {
  readonly path: string;
  readonly kind: StartingMapRouteKind;
  readonly purpose: string;
  readonly present: boolean;
}

export const WHEN_MAP_RUNS_OUT = [
  "Search the code before inventing an answer.",
  "If a roster route is present, read it for who knows the area.",
  "If a needed map is missing, say so so the next agent gets a better one.",
] as const;

export interface StartingMap {
  readonly root: string;
  /** First present preferred trailhead path, if any. */
  readonly trailhead: string | null;
  readonly routes: ReadonlyArray<StartingMapRoute>;
  readonly whenMapRunsOut: ReadonlyArray<string>;
}

/** Pure: `present` holds relative paths that exist (`docs/` for a directory). */
export function buildStartingMap(input: {
  readonly root: string;
  readonly present: ReadonlySet<string>;
}): StartingMap {
  const routes = STARTING_MAP_CANDIDATES.map((candidate) => ({
    path: candidate.path,
    kind: candidate.kind,
    purpose: candidate.purpose,
    present: input.present.has(candidate.path),
  }));
  const trailhead =
    routes.find((route) => route.kind === "trailhead" && route.present)?.path ?? null;
  return {
    root: input.root,
    trailhead,
    routes,
    whenMapRunsOut: [...WHEN_MAP_RUNS_OUT],
  };
}

const probePath = Effect.fn("StartingMap.probePath")(function* (root: string, relative: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.join(root, relative);
  const info = yield* fileSystem.stat(absolute).pipe(Effect.option);
  if (info._tag === "None") return false;
  const expectsDirectory = relative.endsWith("/");
  return expectsDirectory ? info.value.type === "Directory" : info.value.type === "File";
});

/** Discover which conventional starting-map routes exist under `root`. */
export const discoverStartingMap = Effect.fn("StartingMap.discover")(function* (root: string) {
  const present = new Set<string>();
  for (const candidate of STARTING_MAP_CANDIDATES) {
    if (yield* probePath(root, candidate.path)) present.add(candidate.path);
  }
  return buildStartingMap({ root, present });
});
