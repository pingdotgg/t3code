import {
  prsReadApi,
  prsWriteApi,
  type PrsCapabilities,
  type PrsFilesViewedResult,
  type PrsRef,
  type PrsWriteOperationsSupport,
} from "@t3tools/extension-sdk/catalogue";
import { bindApi } from "@t3tools/extension-sdk/capabilities";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  prsFileViewed,
  prsFileViewedStates,
  prsRevertViewedOverlay,
  prsSettleViewedOverlay,
  prsViewedFilesEnabled,
} from "./prsViewModel.js";

const EMPTY_OVERLAY: ReadonlyMap<string, boolean> = new Map();

export function usePrsFilesViewed(
  host: ClientHost,
  session: ViewSession,
  reference: PrsRef | null,
  store: PrsCapabilities["viewedFiles"],
  operations: PrsWriteOperationsSupport | null,
  readSupported: boolean,
  revision: string,
  onFailure: () => void,
  onSuccess: () => void,
) {
  const enabled = readSupported && prsViewedFilesEnabled(store, operations);
  const scope = useRef({
    queued: new Map<string, boolean>(),
    sentBy: new Map<string, number>(),
    answered: new Set<string>(),
    request: 0,
    read: 0,
    timer: null as ReturnType<typeof setTimeout> | null,
    disposed: false,
  });
  const [read, setRead] = useState<{
    result: PrsFilesViewedResult | null;
    error: boolean;
  }>({ result: null, error: false });
  const [pressed, setPressed] = useState<{ overlay: ReadonlyMap<string, boolean> }>({
    overlay: EMPTY_OVERLAY,
  });
  const states = useMemo(() => prsFileViewedStates(read.result), [read.result]);
  const latestFailure = useRef(onFailure);
  const latestSuccess = useRef(onSuccess);
  useEffect(() => {
    latestFailure.current = onFailure;
    latestSuccess.current = onSuccess;
  }, [onFailure, onSuccess]);
  const changeOverlay = useCallback(
    (change: (current: ReadonlyMap<string, boolean>) => ReadonlyMap<string, boolean>) =>
      setPressed((current) => {
        const overlay = change(current.overlay);
        return overlay === current.overlay ? current : { overlay };
      }),
    [],
  );

  const readViewed = useCallback(async () => {
    const current = scope.current;
    if (!enabled || reference === null || current.disposed || session.signal.aborted) return;
    const request = ++current.read;
    const api = bindApi(prsReadApi, host, session.context, "^1.2.0");
    const files: PrsFilesViewedResult["files"][number][] = [];
    let cursor: string | null = null;
    let truncated = false;
    let snapshot: string | undefined;
    let restarted = false;
    try {
      while (true) {
        const page: PrsFilesViewedResult = await api.invoke(
          "filesViewed",
          { ...reference, ...(cursor === null ? {} : { cursor }) },
          session.signal,
        );
        if (current.disposed || session.signal.aborted || current.read !== request) return;
        if (cursor !== null && page.snapshot !== snapshot) {
          if (restarted) throw new Error("Viewed files changed while paging.");
          restarted = true;
          files.length = 0;
          truncated = false;
          cursor = null;
          snapshot = undefined;
          continue;
        }
        if (page.nextCursor !== null && Number(page.nextCursor) <= Number(cursor ?? "0"))
          throw new Error("Viewed files cursor did not advance.");
        snapshot = page.snapshot;
        files.push(...page.files);
        truncated ||= page.truncated;
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
      const result = { files, truncated, nextCursor: null };
      const pending = new Set([...current.queued.keys(), ...current.sentBy.keys()]);
      const answered = new Set<string>();
      for (const path of current.answered) {
        if (!pending.has(path)) {
          answered.add(path);
          current.answered.delete(path);
        }
      }
      const nextStates = prsFileViewedStates(result);
      changeOverlay((overlay) => prsSettleViewedOverlay(overlay, nextStates, pending, answered));
      setRead({ result, error: false });
    } catch {
      if (!current.disposed && !session.signal.aborted && current.read === request)
        setRead((current) => ({ ...current, error: true }));
    }
  }, [enabled, reference, host, session, changeOverlay]);

  useEffect(() => {
    void readViewed();
  }, [readViewed, revision]);

  const flush = () => {
    const current = scope.current;
    current.timer = null;
    if (reference === null || current.queued.size === 0 || session.signal.aborted) return;
    const files = [...current.queued].map(([path, viewed]) => ({ path, viewed }));
    current.queued.clear();
    const request = ++current.request;
    for (const file of files) current.sentBy.set(file.path, request);
    void bindApi(prsWriteApi, host, session.context, "^1.1.0")
      .invoke("setFilesViewed", { ...reference, files }, session.signal)
      .then(
        () => {
          if (current.disposed || session.signal.aborted) return;
          for (const file of files) {
            if (current.sentBy.get(file.path) !== request) continue;
            current.sentBy.delete(file.path);
            if (!current.queued.has(file.path)) current.answered.add(file.path);
          }
          latestSuccess.current();
          void readViewed();
        },
        () => {
          if (current.disposed || session.signal.aborted) return;
          const owned = new Set<string>();
          for (const file of files) {
            if (current.sentBy.get(file.path) !== request) continue;
            current.sentBy.delete(file.path);
            if (!current.queued.has(file.path)) owned.add(file.path);
          }
          if (owned.size === 0) return;
          changeOverlay((current) => prsRevertViewedOverlay(current, owned));
          latestFailure.current();
          void readViewed();
        },
      );
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    const current = scope.current;
    current.disposed = false;
    return () => {
      if (current.timer !== null) {
        clearTimeout(current.timer);
        flushRef.current();
      }
      current.disposed = true;
    };
  }, []);

  const setViewed = useCallback(
    (path: string, viewed: boolean) => {
      if (!enabled) return;
      changeOverlay((current) => new Map(current).set(path, viewed));
      const current = scope.current;
      current.queued.set(path, viewed);
      if (current.timer !== null) clearTimeout(current.timer);
      current.timer = setTimeout(() => flushRef.current(), 400);
    },
    [enabled, changeOverlay],
  );

  return {
    enabled,
    file: (path: string) => prsFileViewed(path, states, pressed.overlay),
    setViewed,
    truncated: read.result?.truncated === true,
    error: read.error,
  };
}
