import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "../../state/atom-registry";
import type { WorkingScope } from "./WorkingChangesTree";

export interface WorkingChangesAnchor {
  readonly path: string;
  readonly kind: string;
  readonly offsetInFile: number;
  readonly oldLineNumber?: number | null;
  readonly newLineNumber?: number | null;
}

interface WorkingChangesReviewMemory {
  readonly selection: { readonly scope: WorkingScope; readonly path: string } | null;
  readonly foldedPaths: ReadonlyArray<string>;
  readonly message: string;
  readonly anchors: Readonly<Record<string, WorkingChangesAnchor | undefined>>;
}

const workingChangesReviewMemoryAtom = Atom.family((key: string) =>
  Atom.make<WorkingChangesReviewMemory>({
    selection: null,
    foldedPaths: [],
    message: "",
    anchors: {},
  }).pipe(Atom.keepAlive, Atom.withLabel(`mobile:review:working-reader:${key}`)),
);

/** Session memory follows the review cache and is released with the app registry. */
export function getWorkingChangesReviewMemory(key: string) {
  return appAtomRegistry.get(workingChangesReviewMemoryAtom(key));
}

export function updateWorkingChangesReviewMemory(
  key: string,
  patch: Partial<WorkingChangesReviewMemory>,
) {
  const atom = workingChangesReviewMemoryAtom(key);
  appAtomRegistry.set(atom, { ...appAtomRegistry.get(atom), ...patch });
}

/** Native scroll events save anchors without subscribing the reader to every frame. */
export function rememberWorkingChangesAnchor(
  key: string,
  readerKey: string,
  anchor: WorkingChangesAnchor,
) {
  const current = getWorkingChangesReviewMemory(key);
  updateWorkingChangesReviewMemory(key, {
    anchors: { ...current.anchors, [readerKey]: anchor },
  });
}
