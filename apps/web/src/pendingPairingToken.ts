const STORAGE_KEY = "t3.pendingPairingToken";
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

type StoredToken = {
  readonly token: string;
  readonly savedAt: number;
};

function readStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function parseStored(raw: string | null): StoredToken | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredToken>;
    if (typeof parsed.token !== "string" || parsed.token.length === 0) return null;
    if (typeof parsed.savedAt !== "number" || !Number.isFinite(parsed.savedAt)) return null;
    return { token: parsed.token, savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

function isExpired(stored: StoredToken, now: number): boolean {
  return now - stored.savedAt > TOKEN_TTL_MS;
}

export function savePendingPairingToken(token: string, now: number = Date.now()): void {
  const trimmed = token.trim();
  if (trimmed.length === 0) return;
  const storage = readStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ token: trimmed, savedAt: now }));
  } catch {
    // localStorage quota or disabled — silently drop
  }
}

export function peekPendingPairingToken(now: number = Date.now()): string | null {
  const storage = readStorage();
  if (!storage) return null;
  const stored = parseStored(storage.getItem(STORAGE_KEY));
  if (!stored) return null;
  if (isExpired(stored, now)) {
    storage.removeItem(STORAGE_KEY);
    return null;
  }
  return stored.token;
}

export function consumePendingPairingToken(now: number = Date.now()): string | null {
  const token = peekPendingPairingToken(now);
  clearPendingPairingToken();
  return token;
}

export function clearPendingPairingToken(): void {
  const storage = readStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
