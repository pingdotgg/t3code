/**
 * Replies are read aloud by a read-aloud server on the paired PC (Edge's
 * natural voices via edge-tts), on the T3 server's host at port 3776.
 * `EXPO_PUBLIC_T3_READ_ALOUD_URL` overrides the address at build time.
 */

import { READ_ALOUD_VOICE_NAME } from "../../lib/readAloudVoiceName";

export const READ_ALOUD_SERVER_PORT = 3776;
export const DEFAULT_READ_ALOUD_VOICE = "en-US-AvaMultilingualNeural";

export interface ReadAloudVoice {
  readonly shortName: string;
  readonly gender: string;
  readonly personalities: string;
}

export function isReadAloudVoiceName(value: string): boolean {
  return READ_ALOUD_VOICE_NAME.test(value);
}

function trimSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * The PC's address for a connection, or null when the phone doesn't reach the PC directly.
 * A relay or SSH link's address belongs to the relay or a local tunnel, so the reply's text
 * would go somewhere other than the PC.
 */
export function readAloudBaseUrl(targetTag: string, httpBaseUrl: string): string | null {
  return targetTag === "PrimaryConnectionTarget" || targetTag === "BearerConnectionTarget"
    ? httpBaseUrl
    : null;
}

/** The read-aloud server's origin for a connection, or null when it can't be derived. */
export function resolveReadAloudServerUrl(
  httpBaseUrl: string | null,
  override: string | undefined = process.env.EXPO_PUBLIC_T3_READ_ALOUD_URL,
): string | null {
  const configured = override?.trim();
  if (configured) return trimSlashes(configured);
  if (!httpBaseUrl) return null;
  try {
    const url = new URL(httpBaseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.protocol = "http:";
    url.port = String(READ_ALOUD_SERVER_PORT);
    return url.origin;
  } catch {
    return null;
  }
}

/** "en-US-AvaMultilingualNeural" -> "Ava (Multilingual) · US" */
export function readAloudVoiceLabel(shortName: string): string {
  const match = /^([a-z]{2,3})-([A-Za-z]+)-(.+?)(Multilingual)?Neural$/.exec(shortName);
  if (!match) return shortName;
  const [, , region, name, multilingual] = match;
  const spaced = name!.replace(/-/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return `${spaced}${multilingual ? " (Multilingual)" : ""} · ${region}`;
}

/** English voices, US first, like the desktop picker. */
export function sortReadAloudVoices(voices: ReadonlyArray<ReadAloudVoice>): ReadAloudVoice[] {
  return [...voices]
    .filter((voice) => voice.shortName.startsWith("en-") && isReadAloudVoiceName(voice.shortName))
    .sort((a, b) => {
      const aUs = a.shortName.startsWith("en-US-") ? 0 : 1;
      const bUs = b.shortName.startsWith("en-US-") ? 0 : 1;
      return aUs - bUs || a.shortName.localeCompare(b.shortName);
    });
}

const REQUEST_TIMEOUT_MS = 15_000;

async function request(url: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch {
    throw new Error(
      "Couldn't reach the read-aloud server on your PC. Check that the PC is on and Tailscale is connected.",
    );
  } finally {
    clearTimeout(timer);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : `The read-aloud server answered ${response.status}.`;
    throw new Error(message);
  }
  return body;
}

/** Starts speech on the PC and returns the URL that streams its MP3. */
export async function requestSpeech(
  serverUrl: string,
  input: { readonly text: string; readonly voice: string },
): Promise<string> {
  const body = await request(`${serverUrl}/speak`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: input.text, voice: input.voice }),
  });
  if (
    typeof body !== "object" ||
    body === null ||
    !("url" in body) ||
    typeof body.url !== "string"
  ) {
    throw new Error("The read-aloud server sent an unexpected answer.");
  }
  return `${serverUrl}${body.url}`;
}

export async function fetchReadAloudVoices(serverUrl: string): Promise<ReadAloudVoice[]> {
  const body = await request(`${serverUrl}/voices`);
  if (!Array.isArray(body)) return [];
  return sortReadAloudVoices(
    body.filter(
      (voice): voice is ReadAloudVoice =>
        typeof voice === "object" &&
        voice !== null &&
        typeof voice.shortName === "string" &&
        typeof voice.gender === "string",
    ),
  );
}
