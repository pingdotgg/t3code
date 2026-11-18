import type { AnnotationCapture, AnnotationRecord } from "@t3tools/contracts";
import type { Annotation } from "./types";

/** What the page environment provides on `window.__CONN_ANNOTATIONS__`. */
export type ConnAnnotations = {
  list(): Promise<ReadonlyArray<AnnotationRecord>>;
  submit(capture: AnnotationCapture): Promise<AnnotationRecord>;
  remove(ids: ReadonlyArray<string>): Promise<void>;
  /** Calls `onChange` when the stored annotations change; returns the unsubscribe. */
  subscribe(onChange: () => void): () => void;
  /** Native pixels of a viewport rect (CSS px) as a data URL; desktop tabs only. */
  capture?(rect: { x: number; y: number; width: number; height: number }): Promise<string | null>;
};

declare global {
  interface Window {
    __CONN_ANNOTATIONS__?: ConnAnnotations;
  }
}

/** Delivers annotations to the Conn server and reads them back. */
export type AnnotationTransport = {
  submit: (annotation: Annotation) => Promise<unknown>;
  /** Every record the transport knows. Resolved records remove pins. */
  list: () => Promise<ReadonlyArray<unknown>>;
  remove: (ids: ReadonlyArray<string>) => Promise<void>;
  /** Call `refresh` when records change; returns the unsubscribe. */
  subscribe: (refresh: () => void) => () => void;
};

/** The capture fields the server stores; local delivery state stays in the page. */
export function toCapture(annotation: Annotation): AnnotationCapture {
  const {
    number: _number,
    revision: _revision,
    delivery: _delivery,
    syncError: _syncError,
    summary: _summary,
    question: _question,
    status: _status,
    ...capture
  } = annotation;
  return { ...capture, source: "browser" } as AnnotationCapture;
}

/** The transport the page environment provides, or undefined when this page has none. */
export function connTransport(): AnnotationTransport | undefined {
  const conn = typeof window === "undefined" ? undefined : window.__CONN_ANNOTATIONS__;
  if (!conn) return undefined;
  return {
    submit: (annotation) => conn.submit(toCapture(annotation)),
    list: () => conn.list(),
    remove: (ids) => conn.remove(ids),
    subscribe: (refresh) => conn.subscribe(refresh),
  };
}
