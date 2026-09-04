import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const BT709_FULL_RANGE_CICP = [1, 1, 0, 1] as const;
const PNG_COLOR_PROFILE_CHUNKS = new Set(["cICP", "cHRM", "gAMA", "iCCP", "sRGB"]);
const MAX_GITHUB_USER_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const GITHUB_ASSET_REDIRECT_HOST_PATTERN =
  /^github-production-user-asset-[a-z0-9]+\.s3\.amazonaws\.com$/i;
const SUPPORTED_IMAGE_CONTENT_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export class GitHubUserAttachmentFetchError extends Data.TaggedError(
  "GitHubUserAttachmentFetchError",
)<{
  readonly reason: "content-type" | "redirect" | "response-too-large" | "status" | "transport";
  readonly status?: number;
}> {
  override get message(): string {
    return "The GitHub user attachment could not be loaded.";
  }
}

function bytesEqualAt(bytes: Uint8Array, offset: number, expected: ReadonlyArray<number>): boolean {
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * Chromium's newer PNG decoder color-manages cICP and legacy gAMA/cHRM metadata that GitHub's
 * rendering effectively ignores. macOS screenshots can contain both descriptions and render
 * much darker in Chromium as a result. When that exact BT.709 declaration is present, remove
 * the color-description chunks so the original compressed pixels are interpreted as sRGB.
 */
export function stripBt709ColorMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < PNG_SIGNATURE.length || !bytesEqualAt(bytes, 0, PNG_SIGNATURE)) return bytes;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Array<{
    readonly start: number;
    readonly end: number;
    readonly type: string;
    readonly dataOffset: number;
    readonly dataLength: number;
  }> = [];
  let offset: number = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const dataLength = view.getUint32(offset, false);
    const dataOffset = offset + 8;
    const chunkEnd = dataOffset + dataLength + 4;
    if (chunkEnd > bytes.length) return bytes;

    chunks.push({
      start: offset,
      end: chunkEnd,
      type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)),
      dataOffset,
      dataLength,
    });
    offset = chunkEnd;
  }

  if (offset !== bytes.length) return bytes;
  const hasBt709Cicp = chunks.some(
    (chunk) =>
      chunk.type === "cICP" &&
      chunk.dataLength === BT709_FULL_RANGE_CICP.length &&
      bytesEqualAt(bytes, chunk.dataOffset, BT709_FULL_RANGE_CICP),
  );
  if (!hasBt709Cicp) return bytes;

  const removedChunks = chunks.filter((chunk) => PNG_COLOR_PROFILE_CHUNKS.has(chunk.type));
  const removedByteCount = removedChunks.reduce((sum, chunk) => sum + chunk.end - chunk.start, 0);
  const normalized = new Uint8Array(bytes.length - removedByteCount);
  let sourceOffset = 0;
  let destinationOffset = 0;
  for (const chunk of removedChunks) {
    normalized.set(bytes.subarray(sourceOffset, chunk.start), destinationOffset);
    destinationOffset += chunk.start - sourceOffset;
    sourceOffset = chunk.end;
  }
  normalized.set(bytes.subarray(sourceOffset), destinationOffset);
  return normalized;
}

function trustedRedirectUrl(location: string, sourceUrl: string): string | null {
  try {
    const url = new URL(location, sourceUrl);
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      GITHUB_ASSET_REDIRECT_HOST_PATTERN.test(url.hostname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

const executeWithoutRedirects = <E, R>(
  effect: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>,
) => effect.pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));

const readLimitedBody = Effect.fn("GitHubUserAttachment.readLimitedBody")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const declaredLength = Number(response.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_GITHUB_USER_ATTACHMENT_BYTES) {
    return yield* new GitHubUserAttachmentFetchError({ reason: "response-too-large" });
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  yield* response.stream.pipe(
    Stream.runForEach((chunk) => {
      byteLength += chunk.length;
      if (byteLength > MAX_GITHUB_USER_ATTACHMENT_BYTES) {
        return Effect.fail(new GitHubUserAttachmentFetchError({ reason: "response-too-large" }));
      }
      chunks.push(chunk);
      return Effect.void;
    }),
    Effect.mapError((error) =>
      error instanceof GitHubUserAttachmentFetchError
        ? error
        : new GitHubUserAttachmentFetchError({ reason: "transport" }),
    ),
  );

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
});

export const loadGitHubUserAttachment = Effect.fn("GitHubUserAttachment.loadGitHubUserAttachment")(
  function* (sourceUrl: string) {
    const httpClient = yield* HttpClient.HttpClient;
    const initialResponse = yield* executeWithoutRedirects(httpClient.get(sourceUrl)).pipe(
      Effect.mapError(() => new GitHubUserAttachmentFetchError({ reason: "transport" })),
    );
    const response =
      initialResponse.status >= 300 && initialResponse.status < 400
        ? yield* Effect.gen(function* () {
            const redirectUrl = initialResponse.headers.location
              ? trustedRedirectUrl(initialResponse.headers.location, sourceUrl)
              : null;
            if (redirectUrl === null) {
              return yield* new GitHubUserAttachmentFetchError({ reason: "redirect" });
            }
            return yield* executeWithoutRedirects(httpClient.get(redirectUrl)).pipe(
              Effect.mapError(() => new GitHubUserAttachmentFetchError({ reason: "transport" })),
            );
          })
        : initialResponse;

    if (response.status < 200 || response.status >= 300) {
      return yield* new GitHubUserAttachmentFetchError({
        reason: "status",
        status: response.status,
      });
    }
    const contentType = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType === undefined || !SUPPORTED_IMAGE_CONTENT_TYPES.has(contentType)) {
      return yield* new GitHubUserAttachmentFetchError({ reason: "content-type" });
    }

    const bytes = yield* readLimitedBody(response);
    return {
      bytes: contentType === "image/png" ? stripBt709ColorMetadata(bytes) : bytes,
      contentType,
    };
  },
);
