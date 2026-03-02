import AsyncStorage from "@react-native-async-storage/async-storage";

const BACKEND_PROFILES_KEY = "t3.mobile.backendProfiles.v1";
const ACTIVE_BACKEND_ID_KEY = "t3.mobile.activeBackendId.v1";
const URL_PROTOCOL_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;

export interface BackendProfile {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly authToken: string | null;
  readonly createdAt: string;
  readonly lastConnectedAt: string | null;
}

interface StoredBackendState {
  readonly profiles: BackendProfile[];
  readonly activeProfileId: string | null;
}

interface NormalizedBackendInput {
  readonly name: string;
  readonly url: string;
  readonly authToken: string | null;
}

function isString(input: unknown): input is string {
  return typeof input === "string";
}

function toBackendProfile(input: unknown): BackendProfile | null {
  if (!input || typeof input !== "object") return null;

  const value = input as Record<string, unknown>;
  if (!isString(value.id) || !isString(value.name) || !isString(value.url) || !isString(value.createdAt)) {
    return null;
  }

  const authToken = isString(value.authToken) ? value.authToken : null;
  const lastConnectedAt = isString(value.lastConnectedAt) ? value.lastConnectedAt : null;

  return {
    id: value.id,
    name: value.name,
    url: value.url,
    authToken: authToken && authToken.length > 0 ? authToken : null,
    createdAt: value.createdAt,
    lastConnectedAt,
  };
}

function parseStoredProfiles(raw: string | null): BackendProfile[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    const profiles: BackendProfile[] = [];
    for (const candidate of parsed) {
      const profile = toBackendProfile(candidate);
      if (profile) {
        profiles.push(profile);
      }
    }
    return profiles;
  } catch {
    return [];
  }
}

function toWsUrl(input: string): URL {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("Server URL is required.");
  }

  const withProtocol = URL_PROTOCOL_PATTERN.test(trimmed) ? trimmed : `ws://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error("Enter a valid server URL.");
  }

  if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  } else if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  }

  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("Server URL must use ws:// or wss://.");
  }

  parsed.hash = "";
  return parsed;
}

function buildBackendName(url: URL): string {
  const path = url.pathname.replace(/\/$/, "");
  if (!path || path === "/") {
    return url.host;
  }
  return `${url.host}${path}`;
}

export function createBackendProfileId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeBackendInput(urlInput: string, authTokenInput: string): NormalizedBackendInput {
  const parsed = toWsUrl(urlInput);
  const tokenFromUrl = parsed.searchParams.get("token")?.trim() || "";
  parsed.searchParams.delete("token");

  const inputToken = authTokenInput.trim();
  const authToken = inputToken.length > 0 ? inputToken : tokenFromUrl.length > 0 ? tokenFromUrl : null;

  return {
    name: buildBackendName(parsed),
    url: parsed.toString(),
    authToken,
  };
}

export function buildSocketUrl(profile: Pick<BackendProfile, "url" | "authToken">): string {
  const parsed = new URL(profile.url);
  const token = profile.authToken?.trim();
  if (token) {
    parsed.searchParams.set("token", token);
  } else {
    parsed.searchParams.delete("token");
  }
  return parsed.toString();
}

export async function loadBackendState(): Promise<StoredBackendState> {
  const [rawProfiles, rawActiveProfileId] = await Promise.all([
    AsyncStorage.getItem(BACKEND_PROFILES_KEY),
    AsyncStorage.getItem(ACTIVE_BACKEND_ID_KEY),
  ]);

  return {
    profiles: parseStoredProfiles(rawProfiles),
    activeProfileId: rawActiveProfileId && rawActiveProfileId.length > 0 ? rawActiveProfileId : null,
  };
}

export async function saveBackendProfiles(profiles: readonly BackendProfile[]): Promise<void> {
  await AsyncStorage.setItem(BACKEND_PROFILES_KEY, JSON.stringify(profiles));
}

export async function setActiveBackendProfileId(profileId: string | null): Promise<void> {
  if (!profileId) {
    await AsyncStorage.removeItem(ACTIVE_BACKEND_ID_KEY);
    return;
  }
  await AsyncStorage.setItem(ACTIVE_BACKEND_ID_KEY, profileId);
}
