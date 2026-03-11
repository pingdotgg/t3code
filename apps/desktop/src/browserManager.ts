import { WebContentsView, type BrowserWindow, type Rectangle } from "electron";
import type {
  BrowserClearThreadInput,
  BrowserEnsureTabInput,
  BrowserEvent,
  BrowserNavigateInput,
  BrowserSyncHostInput,
  BrowserTabRuntimeState,
  BrowserTabTargetInput,
  ThreadId,
} from "@t3tools/contracts";

const ERR_ABORTED = -3;
const MAX_LIVE_BROWSER_TABS = 3;

type BrowserTabRecord = {
  key: string;
  threadId: ThreadId;
  tabId: string;
  view: WebContentsView | null;
  state: BrowserTabRuntimeState;
  lastAccessedAt: number;
};

export interface BrowserManager {
  ensureTab: (input: BrowserEnsureTabInput) => Promise<void>;
  navigate: (input: BrowserNavigateInput) => Promise<void>;
  goBack: (input: BrowserTabTargetInput) => Promise<void>;
  goForward: (input: BrowserTabTargetInput) => Promise<void>;
  reload: (input: BrowserTabTargetInput) => Promise<void>;
  closeTab: (input: BrowserTabTargetInput) => Promise<void>;
  syncHost: (input: BrowserSyncHostInput) => void;
  clearThread: (input: BrowserClearThreadInput) => void;
  destroyAll: () => void;
}

interface BrowserManagerOptions {
  emitEvent: (event: BrowserEvent) => void;
  getWindow: () => BrowserWindow | null;
  openExternal: (url: string) => void | Promise<void>;
}

function recordKey(threadId: ThreadId, tabId: string): string {
  return `${threadId}\u0000${tabId}`;
}

function normalizeRuntimeUrl(url: string | null | undefined): string {
  if (!url || url.trim().length === 0) {
    return "about:blank";
  }
  return url;
}

function readBrowserTitle(view: WebContentsView, fallback: string | null): string | null {
  const title = view.webContents.getTitle().trim();
  if (title.length > 0) {
    return title;
  }
  return fallback;
}

function now(): number {
  return Date.now();
}

function statesEqual(left: BrowserTabRuntimeState, right: BrowserTabRuntimeState): boolean {
  return (
    left.url === right.url &&
    left.title === right.title &&
    left.faviconUrl === right.faviconUrl &&
    left.isLoading === right.isLoading &&
    left.canGoBack === right.canGoBack &&
    left.canGoForward === right.canGoForward &&
    left.lastError === right.lastError
  );
}

function sanitizeBounds(bounds: BrowserSyncHostInput["bounds"]): Rectangle | null {
  if (!bounds) {
    return null;
  }
  const x = Number.isFinite(bounds.x) ? Math.max(0, Math.round(bounds.x)) : null;
  const y = Number.isFinite(bounds.y) ? Math.max(0, Math.round(bounds.y)) : null;
  const width = Number.isFinite(bounds.width) ? Math.max(0, Math.round(bounds.width)) : null;
  const height = Number.isFinite(bounds.height) ? Math.max(0, Math.round(bounds.height)) : null;
  if (
    x === null ||
    y === null ||
    width === null ||
    height === null ||
    width === 0 ||
    height === 0
  ) {
    return null;
  }
  return { x, y, width, height };
}

export function createBrowserManager(options: BrowserManagerOptions): BrowserManager {
  const records = new Map<string, BrowserTabRecord>();
  let activeHost: BrowserSyncHostInput | null = null;
  let attachedRecordKey: string | null = null;

  const emitState = (
    record: BrowserTabRecord,
    patch: Partial<BrowserTabRuntimeState> = {},
    emitOptions: { preferBlankTitle?: boolean } = {},
  ): void => {
    const runtimeUrl = record.view
      ? normalizeRuntimeUrl(record.view.webContents.getURL())
      : normalizeRuntimeUrl(record.state.url);
    const fallbackTitle =
      emitOptions.preferBlankTitle || runtimeUrl === "about:blank" ? null : record.state.title;
    const nextState: BrowserTabRuntimeState = {
      url: patch.url ?? runtimeUrl ?? record.state.url,
      title:
        patch.title !== undefined
          ? patch.title
          : record.view
            ? readBrowserTitle(record.view, fallbackTitle ?? record.state.title)
            : (fallbackTitle ?? record.state.title),
      faviconUrl:
        patch.faviconUrl !== undefined ? patch.faviconUrl : (record.state.faviconUrl ?? null),
      isLoading: patch.isLoading ?? (record.view ? record.view.webContents.isLoading() : false),
      canGoBack: patch.canGoBack ?? (record.view ? record.view.webContents.canGoBack() : false),
      canGoForward:
        patch.canGoForward ?? (record.view ? record.view.webContents.canGoForward() : false),
      lastError: patch.lastError !== undefined ? patch.lastError : record.state.lastError,
    };
    if (nextState.url === "about:blank" && nextState.title === "") {
      nextState.title = null;
    }
    if (statesEqual(record.state, nextState)) {
      return;
    }
    record.state = nextState;
    options.emitEvent({
      type: "tab-state",
      threadId: record.threadId,
      tabId: record.tabId,
      state: nextState,
    });
  };

  const touchRecord = (record: BrowserTabRecord): void => {
    record.lastAccessedAt = now();
  };

  const detachRecord = (record: BrowserTabRecord | null): void => {
    if (!record?.view) {
      return;
    }
    record.view.setVisible(false);
    const window = options.getWindow();
    if (!window) {
      return;
    }
    if (window.contentView.children.includes(record.view)) {
      window.contentView.removeChildView(record.view);
    }
  };

  const disposeRecordView = (record: BrowserTabRecord): void => {
    const view = record.view;
    if (!view) {
      return;
    }
    if (attachedRecordKey === record.key) {
      detachRecord(record);
      attachedRecordKey = null;
    } else {
      view.setVisible(false);
      const window = options.getWindow();
      if (window && window.contentView.children.includes(view)) {
        window.contentView.removeChildView(view);
      }
    }
    record.view = null;
    if (!view.webContents.isDestroyed()) {
      view.webContents.close({ waitForBeforeUnload: false });
    }
    emitState(record, {
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
    });
  };

  const enforceLiveTabBudget = (protectedRecordKey: string | null): void => {
    const liveRecords = [...records.values()].filter((record) => record.view !== null);
    if (liveRecords.length <= MAX_LIVE_BROWSER_TABS) {
      return;
    }
    const protectedKeys = new Set<string>();
    if (protectedRecordKey) {
      protectedKeys.add(protectedRecordKey);
    }
    if (activeHost?.visible && activeHost.tabId) {
      protectedKeys.add(recordKey(activeHost.threadId, activeHost.tabId));
    }
    const evictionCandidates = liveRecords
      .filter((record) => !protectedKeys.has(record.key))
      .toSorted((left, right) => left.lastAccessedAt - right.lastAccessedAt);

    while (liveRecords.filter((record) => record.view !== null).length > MAX_LIVE_BROWSER_TABS) {
      const nextCandidate = evictionCandidates.shift();
      if (!nextCandidate) {
        break;
      }
      disposeRecordView(nextCandidate);
    }
  };

  const wireRecordEvents = (record: BrowserTabRecord, view: WebContentsView): void => {
    const { webContents } = view;
    const isCurrentView = () => record.view === view;
    const emitIfCurrent = (
      patch: Partial<BrowserTabRuntimeState> = {},
      emitOptions: { preferBlankTitle?: boolean } = {},
    ) => {
      if (!isCurrentView()) {
        return;
      }
      touchRecord(record);
      emitState(record, patch, emitOptions);
    };

    webContents.setWindowOpenHandler(({ url }) => {
      void options.openExternal(url);
      return { action: "deny" };
    });
    webContents.on("did-start-loading", () => {
      emitIfCurrent({ isLoading: true, lastError: null });
    });
    webContents.on("did-stop-loading", () => {
      emitIfCurrent({ isLoading: false });
    });
    webContents.on("did-navigate", (_event, url) => {
      emitIfCurrent({ url: normalizeRuntimeUrl(url), lastError: null }, { preferBlankTitle: true });
    });
    webContents.on("did-navigate-in-page", (_event, url) => {
      emitIfCurrent({ url: normalizeRuntimeUrl(url), lastError: null }, { preferBlankTitle: true });
    });
    webContents.on("page-title-updated", (event, title) => {
      event.preventDefault();
      emitIfCurrent({ title: title.trim().length > 0 ? title : null });
    });
    webContents.on("page-favicon-updated", (_event, favicons) => {
      emitIfCurrent({ faviconUrl: favicons[0] ?? null });
    });
    webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === ERR_ABORTED) {
          return;
        }
        emitIfCurrent({
          url: normalizeRuntimeUrl(validatedURL),
          isLoading: false,
          lastError: errorDescription || "Failed to load page.",
        });
      },
    );
    webContents.on("render-process-gone", (_event, details) => {
      emitIfCurrent({
        isLoading: false,
        lastError: `Browser tab crashed (${details.reason}).`,
      });
    });
    webContents.once("destroyed", () => {
      if (!isCurrentView()) {
        return;
      }
      if (attachedRecordKey === record.key) {
        attachedRecordKey = null;
      }
      record.view = null;
      emitState(record, {
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
      });
      syncAttachedView();
    });
  };

  const createLiveViewForRecord = (
    record: BrowserTabRecord,
    options: { restoreFromState?: boolean } = {},
  ): WebContentsView => {
    if (record.view) {
      touchRecord(record);
      return record.view;
    }
    const view = new WebContentsView();
    view.setVisible(false);
    record.view = view;
    touchRecord(record);
    wireRecordEvents(record, view);
    if (options.restoreFromState && record.state.url !== "about:blank") {
      void loadRecordUrl(record, record.state.url);
    }
    enforceLiveTabBudget(record.key);
    return view;
  };

  const syncAttachedView = (): void => {
    const window = options.getWindow();
    const desiredRecord =
      activeHost && activeHost.visible && activeHost.tabId && sanitizeBounds(activeHost.bounds)
        ? (records.get(recordKey(activeHost.threadId, activeHost.tabId)) ?? null)
        : null;
    const attachedRecord = attachedRecordKey ? (records.get(attachedRecordKey) ?? null) : null;
    if (attachedRecord && (!window || !desiredRecord || desiredRecord.key !== attachedRecord.key)) {
      detachRecord(attachedRecord);
      attachedRecordKey = null;
    }
    if (!window || !desiredRecord || !activeHost) {
      return;
    }
    const bounds = sanitizeBounds(activeHost.bounds);
    if (!bounds) {
      detachRecord(desiredRecord);
      attachedRecordKey = null;
      return;
    }
    createLiveViewForRecord(desiredRecord, { restoreFromState: true });
    touchRecord(desiredRecord);
    if (!desiredRecord.view) {
      return;
    }
    desiredRecord.view.setBounds(bounds);
    desiredRecord.view.setVisible(true);
    window.contentView.addChildView(desiredRecord.view);
    attachedRecordKey = desiredRecord.key;
  };

  const destroyRecord = (record: BrowserTabRecord): void => {
    disposeRecordView(record);
    records.delete(record.key);
    syncAttachedView();
  };

  const createRecord = (input: BrowserEnsureTabInput): BrowserTabRecord => {
    const key = recordKey(input.threadId, input.tabId);
    const record: BrowserTabRecord = {
      key,
      threadId: input.threadId,
      tabId: input.tabId,
      view: null,
      state: {
        url: normalizeRuntimeUrl(input.url),
        title: null,
        faviconUrl: null,
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        lastError: null,
      },
      lastAccessedAt: now(),
    };
    records.set(key, record);
    emitState(record, { url: normalizeRuntimeUrl(input.url) }, { preferBlankTitle: true });
    return record;
  };

  const loadRecordUrl = async (record: BrowserTabRecord, url: string): Promise<void> => {
    createLiveViewForRecord(record);
    emitState(
      record,
      {
        url,
        title: url === "about:blank" ? null : record.state.title,
        faviconUrl: url === "about:blank" ? null : record.state.faviconUrl,
        isLoading: url !== "about:blank",
        lastError: null,
      },
      { preferBlankTitle: url === "about:blank" },
    );
    try {
      if (!record.view) {
        return;
      }
      await record.view.webContents.loadURL(url);
    } catch (error) {
      if (!record.view || record.view.webContents.isDestroyed()) {
        return;
      }
      emitState(record, {
        url,
        isLoading: false,
        lastError: error instanceof Error ? error.message : "Failed to load page.",
      });
    }
  };

  const ensureTab = async (input: BrowserEnsureTabInput): Promise<void> => {
    const key = recordKey(input.threadId, input.tabId);
    const existing = records.get(key);
    if (existing) {
      return;
    }
    createRecord(input);
    syncAttachedView();
  };

  return {
    ensureTab,
    navigate: async (input) => {
      await ensureTab(input);
      const record = records.get(recordKey(input.threadId, input.tabId));
      if (!record) {
        return;
      }
      await loadRecordUrl(record, input.url);
      syncAttachedView();
    },
    goBack: async (input) => {
      const record = records.get(recordKey(input.threadId, input.tabId));
      if (!record?.view || !record.view.webContents.canGoBack()) {
        return;
      }
      touchRecord(record);
      record.view.webContents.goBack();
    },
    goForward: async (input) => {
      const record = records.get(recordKey(input.threadId, input.tabId));
      if (!record?.view || !record.view.webContents.canGoForward()) {
        return;
      }
      touchRecord(record);
      record.view.webContents.goForward();
    },
    reload: async (input) => {
      const record = records.get(recordKey(input.threadId, input.tabId));
      if (!record) {
        return;
      }
      if (!record.view) {
        await loadRecordUrl(record, record.state.url);
        syncAttachedView();
        return;
      }
      touchRecord(record);
      record.view.webContents.reload();
    },
    closeTab: async (input) => {
      const record = records.get(recordKey(input.threadId, input.tabId));
      if (!record) {
        return;
      }
      destroyRecord(record);
    },
    syncHost: (input) => {
      activeHost = input;
      syncAttachedView();
    },
    clearThread: (input) => {
      for (const record of records.values()) {
        if (record.threadId !== input.threadId) {
          continue;
        }
        destroyRecord(record);
      }
      if (activeHost?.threadId === input.threadId) {
        activeHost = {
          threadId: input.threadId,
          tabId: null,
          visible: false,
          bounds: null,
        };
      }
      syncAttachedView();
    },
    destroyAll: () => {
      activeHost = null;
      for (const record of records.values()) {
        destroyRecord(record);
      }
    },
  };
}
