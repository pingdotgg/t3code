import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const BT709_FULL_RANGE_CICP = [1, 1, 0, 1] as const;
const SRGB_GAMMA = [0, 0, 177, 143] as const;
const SRGB_CHROMATICITIES = [
  0, 0, 122, 38, 0, 0, 128, 132, 0, 0, 250, 0, 0, 0, 128, 232, 0, 0, 117, 48, 0, 0, 234, 96, 0, 0,
  58, 152, 0, 0, 23, 112,
] as const;
const INITIAL_GITHUB_USER_ATTACHMENT_BUFFER_BYTES = 64 * 1024;
const MAX_GITHUB_USER_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const GITHUB_USER_ATTACHMENT_REQUEST_TIMEOUT = Duration.seconds(10);
const GITHUB_USER_ATTACHMENT_BODY_TIMEOUT = Duration.seconds(30);
const GITHUB_ASSET_REDIRECT_HOST_PATTERN =
  /^github-production-user-asset-[a-z0-9]+\.s3\.amazonaws\.com$/i;
const SUPPORTED_IMAGE_CONTENT_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export class GitHubUserAttachmentFetchError extends Schema.TaggedErrorClass<GitHubUserAttachmentFetchError>()(
  "GitHubUserAttachmentFetchError",
  {
    reason: Schema.Literals([
      "content-type",
      "redirect",
      "response-too-large",
      "status",
      "transport",
    ]),
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "The GitHub user attachment could not be loaded.";
  }
}
const isGitHubUserAttachmentFetchError = Schema.is(GitHubUserAttachmentFetchError);

function transportFailure(cause: unknown): GitHubUserAttachmentFetchError {
  return isGitHubUserAttachmentFetchError(cause)
    ? cause
    : new GitHubUserAttachmentFetchError({ reason: "transport", cause });
}

function bytesEqualAt(bytes: Uint8Array, offset: number, expected: ReadonlyArray<number>): boolean {
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * Newer Chromium versions honor cICP ahead of legacy PNG color metadata. Some macOS screenshots
 * describe the same pixels as full-range BT.709 in cICP and as sRGB in gAMA/cHRM. Remove only the
 * conflicting cICP chunk from that exact combination so decoders use the existing sRGB metadata.
 */
function stripConflictingBt709Cicp(bytes: Uint8Array): Uint8Array {
  if (bytes.length < PNG_SIGNATURE.length || !bytesEqualAt(bytes, 0, PNG_SIGNATURE)) return bytes;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cicpOffset = -1;
  let hasSrgbGamma = false;
  let hasSrgbChromaticities = false;
  let offset: number = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const dataLength = view.getUint32(offset, false);
    const dataOffset = offset + 8;
    const chunkEnd = dataOffset + dataLength + 4;
    if (chunkEnd > bytes.length) return bytes;

    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "cICP") {
      // PNG permits one cICP chunk. Leave duplicate or other profiles untouched.
      if (
        cicpOffset !== -1 ||
        dataLength !== BT709_FULL_RANGE_CICP.length ||
        !bytesEqualAt(bytes, dataOffset, BT709_FULL_RANGE_CICP)
      )
        return bytes;
      cicpOffset = offset;
    } else if (type === "gAMA") {
      hasSrgbGamma ||=
        dataLength === SRGB_GAMMA.length && bytesEqualAt(bytes, dataOffset, SRGB_GAMMA);
    } else if (type === "cHRM") {
      hasSrgbChromaticities ||=
        dataLength === SRGB_CHROMATICITIES.length &&
        bytesEqualAt(bytes, dataOffset, SRGB_CHROMATICITIES);
    }
    offset = chunkEnd;
  }

  if (offset !== bytes.length || cicpOffset === -1 || !hasSrgbGamma || !hasSrgbChromaticities)
    return bytes;
  const chunkLength = 12 + BT709_FULL_RANGE_CICP.length;
  bytes.copyWithin(cicpOffset, cicpOffset + chunkLength);
  return bytes.subarray(0, bytes.length - chunkLength);
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
) =>
  effect.pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.timeout(GITHUB_USER_ATTACHMENT_REQUEST_TIMEOUT),
    Effect.mapError(transportFailure),
  );

const readLimitedBody = Effect.fn("GitHubUserAttachment.readLimitedBody")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const declaredLength = Number(response.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_GITHUB_USER_ATTACHMENT_BYTES) {
    return yield* new GitHubUserAttachmentFetchError({ reason: "response-too-large" });
  }

  const initialCapacity =
    Number.isSafeInteger(declaredLength) && declaredLength >= 0
      ? declaredLength
      : INITIAL_GITHUB_USER_ATTACHMENT_BUFFER_BYTES;
  let bytes = new Uint8Array(initialCapacity);
  let byteLength = 0;
  yield* response.stream.pipe(
    Stream.runForEach((chunk) => {
      const nextByteLength = byteLength + chunk.length;
      if (nextByteLength > MAX_GITHUB_USER_ATTACHMENT_BYTES) {
        return Effect.fail(new GitHubUserAttachmentFetchError({ reason: "response-too-large" }));
      }
      if (nextByteLength > bytes.length) {
        const nextCapacity = Math.min(
          MAX_GITHUB_USER_ATTACHMENT_BYTES,
          Math.max(nextByteLength, bytes.length * 2, INITIAL_GITHUB_USER_ATTACHMENT_BUFFER_BYTES),
        );
        const grown = new Uint8Array(nextCapacity);
        grown.set(bytes.subarray(0, byteLength));
        bytes = grown;
      }
      bytes.set(chunk, byteLength);
      byteLength = nextByteLength;
      return Effect.void;
    }),
    Effect.timeout(GITHUB_USER_ATTACHMENT_BODY_TIMEOUT),
    Effect.mapError(transportFailure),
  );

  return bytes.subarray(0, byteLength);
});

export const loadGitHubUserAttachment = Effect.fn("GitHubUserAttachment.loadGitHubUserAttachment")(
  function* (sourceUrl: string) {
    const httpClient = yield* HttpClient.HttpClient;
    const initialResponse = yield* executeWithoutRedirects(httpClient.get(sourceUrl));
    const response =
      initialResponse.status >= 300 && initialResponse.status < 400
        ? yield* Effect.gen(function* () {
            const redirectUrl = initialResponse.headers.location
              ? trustedRedirectUrl(initialResponse.headers.location, sourceUrl)
              : null;
            if (redirectUrl === null) {
              return yield* new GitHubUserAttachmentFetchError({ reason: "redirect" });
            }
            return yield* executeWithoutRedirects(httpClient.get(redirectUrl));
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
      bytes: contentType === "image/png" ? stripConflictingBt709Cicp(bytes) : bytes,
      contentType,
    };
  },
);
