import type { DesktopUpdateReleaseNote } from "@t3tools/contracts";
import { normalizeReleaseNotes } from "@t3tools/shared/releaseNotes";

const RELEASE_BY_TAG_URL = "https://api.github.com/repos/pingdotgg/t3code/releases/tags/v";

type ReleaseNotes = ReadonlyArray<DesktopUpdateReleaseNote>;

const releaseNotesByVersion = new Map<string, Promise<ReleaseNotes>>();

async function fetchReleaseNotes(version: string): Promise<ReleaseNotes> {
  const response = await fetch(`${RELEASE_BY_TAG_URL}${encodeURIComponent(version)}`);
  if (!response.ok) throw new Error(`Release notes request failed (${response.status}).`);
  const release = (await response.json()) as { readonly body?: unknown };
  return normalizeReleaseNotes(release.body, version, () => true).releaseNotes;
}

/**
 * Notes for the release a version-skewed server would update to. The client
 * asks GitHub itself because the older server cannot know about newer
 * releases. One request per version and session; failures resolve empty and
 * retry on the next call.
 */
export function loadServerUpdateReleaseNotes(version: string): Promise<ReleaseNotes> {
  const cached = releaseNotesByVersion.get(version);
  if (cached) return cached;
  const request = fetchReleaseNotes(version).catch(() => {
    releaseNotesByVersion.delete(version);
    return [];
  });
  releaseNotesByVersion.set(version, request);
  return request;
}
