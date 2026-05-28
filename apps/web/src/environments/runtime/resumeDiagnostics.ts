type ResumeDiagnosticData = Record<string, unknown>;

export interface ResumeDiagnosticEntry {
  readonly ts: number;
  readonly kind: string;
  readonly reason?: string;
  readonly env?: string;
  readonly data?: ResumeDiagnosticData;
}

interface ResumeDiagnosticPayload {
  readonly reason?: string;
  readonly env?: string;
  readonly data?: ResumeDiagnosticData;
}

const RESUME_DIAGNOSTICS_STORAGE_KEY = "t3.resume-diagnostics";
const RESUME_DIAGNOSTICS_ENDPOINT = "/diagnostics/web-resume";
const RESUME_DIAGNOSTICS_LIMIT = 500;
const RESUME_DIAGNOSTICS_MAX_STORAGE_BYTES = 512 * 1024;
const RESUME_DIAGNOSTICS_FLUSH_DELAY_MS = 1_500;

let entries: ResumeDiagnosticEntry[] | null = null;
let pendingEntries: ResumeDiagnosticEntry[] = [];
let flushTimeoutId: ReturnType<typeof setTimeout> | null = null;

function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function readPersistedEntries(): ResumeDiagnosticEntry[] {
  const storage = getStorage();
  if (!storage) {
    return [];
  }
  try {
    const raw = storage.getItem(RESUME_DIAGNOSTICS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isResumeDiagnosticEntry).slice(-RESUME_DIAGNOSTICS_LIMIT);
  } catch {
    return [];
  }
}

function isResumeDiagnosticEntry(value: unknown): value is ResumeDiagnosticEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Number.isFinite(record.ts) && typeof record.kind === "string" && record.kind.length > 0;
}

function ensureEntries(): ResumeDiagnosticEntry[] {
  if (entries === null) {
    entries = readPersistedEntries();
  }
  return entries;
}

function persistEntries(nextEntries: ResumeDiagnosticEntry[]): void {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  let writableEntries = nextEntries.slice(-RESUME_DIAGNOSTICS_LIMIT);
  try {
    let serialized = JSON.stringify(writableEntries);
    while (writableEntries.length > 0 && serialized.length > RESUME_DIAGNOSTICS_MAX_STORAGE_BYTES) {
      writableEntries = writableEntries.slice(Math.ceil(writableEntries.length / 4));
      serialized = JSON.stringify(writableEntries);
    }
    storage.setItem(RESUME_DIAGNOSTICS_STORAGE_KEY, serialized);
  } catch {
    // Diagnostics must never affect resume behavior.
  }
}

function clearFlushTimer(): void {
  if (flushTimeoutId !== null) {
    clearTimeout(flushTimeoutId);
    flushTimeoutId = null;
  }
}

function scheduleFlush(): void {
  if (flushTimeoutId !== null || pendingEntries.length === 0) {
    return;
  }
  flushTimeoutId = setTimeout(() => {
    flushTimeoutId = null;
    flushResumeDiagnostics();
  }, RESUME_DIAGNOSTICS_FLUSH_DELAY_MS);
}

function sendEntries(nextEntries: ReadonlyArray<ResumeDiagnosticEntry>): boolean {
  if (nextEntries.length === 0 || typeof navigator === "undefined") {
    return true;
  }

  const sendBeacon = navigator.sendBeacon?.bind(navigator);
  if (!sendBeacon) {
    return true;
  }

  try {
    const body = JSON.stringify(nextEntries);
    const blob =
      typeof Blob === "undefined"
        ? body
        : new Blob([body], {
            type: "application/json",
          });
    sendBeacon(RESUME_DIAGNOSTICS_ENDPOINT, blob);
    return true;
  } catch {
    return true;
  }
}

export function recordResumeDiagnostic(kind: string, payload: ResumeDiagnosticPayload = {}): void {
  if (kind.length === 0) {
    return;
  }

  const entry: ResumeDiagnosticEntry = {
    ts: Date.now(),
    kind,
    ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
    ...(payload.env !== undefined ? { env: payload.env } : {}),
    ...(payload.data !== undefined ? { data: payload.data } : {}),
  };
  const currentEntries = ensureEntries();
  currentEntries.push(entry);
  if (currentEntries.length > RESUME_DIAGNOSTICS_LIMIT) {
    currentEntries.splice(0, currentEntries.length - RESUME_DIAGNOSTICS_LIMIT);
  }
  pendingEntries.push(entry);
  persistEntries(currentEntries);
  scheduleFlush();
}

export function flushResumeDiagnostics(): void {
  clearFlushTimer();
  if (pendingEntries.length === 0) {
    return;
  }

  const batch = pendingEntries;
  pendingEntries = [];
  if (!sendEntries(batch)) {
    pendingEntries = [...batch, ...pendingEntries].slice(-RESUME_DIAGNOSTICS_LIMIT);
    scheduleFlush();
  }
}
