import type { LinkedThreadTarget } from "@t3tools/client-runtime/linked-thread";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

/** A linked environment's thread as a right panel tab, read through `viaEnvironmentId`. */
export type LinkedThreadSurface = {
  id: `linked-thread:${string}`;
  kind: "linked-thread";
} & LinkedThreadTarget;

/** One tab per thread and the environment it is read through, so opening it again focuses it. */
export function linkedThreadSurface(target: LinkedThreadTarget): LinkedThreadSurface {
  return {
    id: `linked-thread:${encodeURIComponent(target.viaEnvironmentId)}:${encodeURIComponent(target.environmentId)}:${encodeURIComponent(target.threadId)}`,
    kind: "linked-thread",
    viaEnvironmentId: target.viaEnvironmentId,
    environmentId: target.environmentId,
    threadId: target.threadId,
    label: target.label,
    title: target.title,
  };
}

/** A saved linked-thread surface with its id rebuilt, or null when its fields are not usable. */
export function decodeLinkedThreadSurface(surface: object): LinkedThreadSurface | null {
  const { viaEnvironmentId, environmentId, threadId, label, title } = surface as Record<
    string,
    unknown
  >;
  if (
    typeof viaEnvironmentId !== "string" ||
    typeof environmentId !== "string" ||
    typeof threadId !== "string" ||
    typeof label !== "string" ||
    viaEnvironmentId === "" ||
    environmentId === "" ||
    threadId === ""
  ) {
    return null;
  }
  return linkedThreadSurface({
    viaEnvironmentId: EnvironmentId.make(viaEnvironmentId),
    environmentId: EnvironmentId.make(environmentId),
    threadId: ThreadId.make(threadId),
    label,
    title: typeof title === "string" && title !== "" ? title : null,
  });
}

/** A tab's title: the thread's own once known, else where the thread is. */
export function linkedThreadTitle(
  surface: Pick<LinkedThreadTarget, "title">,
  fallback: string,
): string {
  return surface.title?.trim() || fallback;
}

/** The main-screen route of a linked environment's thread, read through `viaEnvironmentId`. */
export function linkedThreadRouteParams(
  target: Pick<LinkedThreadTarget, "viaEnvironmentId" | "environmentId" | "threadId">,
) {
  return {
    viaEnvironmentId: target.viaEnvironmentId,
    linkedEnvironmentId: target.environmentId,
    linkedThreadId: target.threadId,
  };
}
