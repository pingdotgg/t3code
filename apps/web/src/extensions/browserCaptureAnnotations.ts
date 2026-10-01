import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { randomUUID } from "../lib/utils";

export interface BrowserCaptureAnnotation {
  readonly annotation: PreviewAnnotationPayload;
  readonly file: File | null;
  readonly artifactRef: string | null;
  readonly screenshotFailed: boolean;
  readonly submission?: "attach" | "send";
  readonly consume: () => void;
}

interface RetainedAnnotation extends BrowserCaptureAnnotation {
  readonly environmentId: string;
  readonly threadId: string;
  readonly installationId: string;
  readonly expiresAt: number;
  readonly discard: () => void;
}

const retained = new Map<string, RetainedAnnotation>();

export function retainBrowserCaptureAnnotation(input: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly installationId: string;
  readonly lifetime: AbortSignal;
  readonly annotation: PreviewAnnotationPayload;
  readonly file: File | null;
  readonly screenshotFailed: boolean;
  readonly submission?: "attach" | "send";
  readonly releaseArtifact?: (artifactRef: string) => void;
}) {
  const annotationRef = `preview-annotation-${randomUUID()}`;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const consume = () => {
    retained.delete(annotationRef);
    clearTimeout(deadline);
    input.lifetime.removeEventListener("abort", discard);
  };
  const discard = () => {
    const artifactRef = retained.get(annotationRef)?.artifactRef;
    if (artifactRef) input.releaseArtifact?.(artifactRef);
    consume();
  };
  const entry = {
    environmentId: input.environmentId,
    threadId: input.threadId,
    installationId: input.installationId,
    annotation: input.annotation,
    file: input.file,
    screenshotFailed: input.screenshotFailed,
    submission: input.submission ?? "attach",
    artifactRef: null,
    expiresAt: Date.now() + 5 * 60_000,
    consume,
    discard,
  } satisfies RetainedAnnotation;
  for (const previous of retained.values()) {
    if (previous.expiresAt <= Date.now()) previous.discard();
  }
  retained.set(annotationRef, entry);
  const own = [...retained.values()].filter(
    (previous) =>
      previous.environmentId === input.environmentId &&
      previous.installationId === input.installationId,
  );
  for (const previous of own.slice(0, Math.max(0, own.length - 32))) previous.discard();
  deadline = setTimeout(discard, 5 * 60_000);
  input.lifetime.addEventListener("abort", discard, { once: true });
  if (input.lifetime.aborted) discard();
  return {
    annotationRef,
    discard,
    setArtifact(artifactRef: string) {
      const current = retained.get(annotationRef);
      if (current) retained.set(annotationRef, { ...current, artifactRef });
      else input.releaseArtifact?.(artifactRef);
    },
  };
}

export function readBrowserCaptureAnnotation(
  environmentId: string,
  threadId: string,
  installationId: string,
  annotationRef: string,
): BrowserCaptureAnnotation | null {
  const entry = retained.get(annotationRef);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    entry.discard();
    return null;
  }
  return entry.environmentId === environmentId &&
    entry.threadId === threadId &&
    entry.installationId === installationId
    ? entry
    : null;
}
