import type {
  EnvironmentId,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

export function defaultWorktreeBaseRef(
  refs: ReadonlyArray<Pick<VcsRef, "name" | "isDefault" | "current">>,
): string {
  if (refs.some((ref) => ref.name === "main" || ref.name === "origin/main")) return "main";
  return (refs.find((ref) => ref.isDefault) ?? refs.find((ref) => ref.current))?.name ?? "";
}

export function createScheduledTaskBaseRefAtomFamily<E>(
  listRefs: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: VcsListRefsInput;
  }) => Atom.Atom<AsyncResult.AsyncResult<VcsListRefsResult, E>>,
) {
  const empty = Atom.make({ baseRef: "", pending: false });
  const family = Atom.family((key: string) =>
    Atom.make((get) => {
      const [environmentId, cwd] = JSON.parse(key) as [EnvironmentId, string];
      const top = get(listRefs({ environmentId, input: { cwd, limit: 100 } }));
      const topValue = Option.getOrNull(AsyncResult.value(top));
      const baseRef = defaultWorktreeBaseRef(topValue?.refs ?? []);
      if (baseRef === "main") return { baseRef, pending: false };
      let cursor: number | undefined;
      // Older remote servers do not put exact branch matches on the first search page.
      while (true) {
        const page = get(
          listRefs({
            environmentId,
            input: { cwd, query: "main", ...(cursor === undefined ? {} : { cursor }), limit: 100 },
          }),
        );
        const value = Option.getOrNull(AsyncResult.value(page));
        if (page._tag === "Initial" || (page.waiting && value === null)) {
          return { baseRef: "", pending: true };
        }
        if (defaultWorktreeBaseRef(value?.refs ?? []) === "main") {
          return { baseRef: "main", pending: false };
        }
        if (page._tag === "Failure" || value?.nextCursor == null) break;
        cursor = value.nextCursor;
      }
      return {
        baseRef,
        pending: top._tag === "Initial" || (top.waiting && topValue === null),
      };
    }).pipe(Atom.withLabel(`scheduled-task-base-ref:${key}`)),
  );
  return (target: { readonly environmentId: EnvironmentId | null; readonly cwd: string | null }) =>
    target.environmentId === null || target.cwd === null
      ? empty
      : family(JSON.stringify([target.environmentId, target.cwd]));
}
