// @effect-diagnostics globalDate:off - Playwright callbacks run outside the Effect runtime.
import {
  PreviewTabId,
  type PreviewAutomationNetworkBody,
  type PreviewAutomationNetworkInput,
  type PreviewAutomationNetworkLog,
  type PreviewAutomationNetworkRequest,
} from "@t3tools/contracts";
import type { Page, Request, Response } from "playwright-core";

import {
  DIAGNOSTIC_BUFFER_LIMIT,
  ServerBrowserOperationError,
  withoutDataPayload,
} from "./ServerBrowserPage.ts";

const DEFAULT_LIST_LIMIT = 20;
const URL_CHARS = 2048;
const HEADER_COUNT_LIMIT = 40;
const HEADER_VALUE_CHARS = 512;
const BODY_BYTES = 16_000;
/** Playwright reads a whole body into memory, so a larger declared one is never fetched. */
const BODY_FETCH_BYTES = 5_000_000;
const REDACTED = "[redacted]";
// Sites name their credential headers freely, so match the words rather than a fixed list.
const SENSITIVE_HEADER = /auth|cookie|token|secret|password|session|api-?key|csrf|xsrf/i;
const TEXT_CONTENT_TYPE =
  /^\s*(text\/|application\/([\w.-]+\+)?(json|xml|(x-)?javascript|ecmascript|x-www-form-urlencoded|graphql)\b|image\/svg\+xml)/i;

interface TrackedRequest {
  readonly id: string;
  readonly request: Request;
  readonly startedAt: number;
  response: Response | null;
  finishedAt: number | null;
  errorText: string | null;
}

export const redactHeaders = (headers: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.entries(headers)
      .slice(0, HEADER_COUNT_LIMIT)
      .map(([name, value]) => [
        name,
        SENSITIVE_HEADER.test(name) ? REDACTED : value.slice(0, HEADER_VALUE_CHARS),
      ]),
  );

const declaredLength = (headers: Readonly<Record<string, string>>) => {
  const length = Number(headers["content-length"]);
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
};

const isText = (contentType: string | undefined, bytes?: Uint8Array) =>
  contentType === undefined || contentType.trim() === ""
    ? bytes !== undefined && !bytes.subarray(0, 1024).includes(0)
    : TEXT_CONTENT_TYPE.test(contentType);

export const bodyOf = (
  bytes: Uint8Array,
  contentType: string | undefined,
): PreviewAutomationNetworkBody => {
  if (!isText(contentType, bytes)) {
    return { sizeBytes: bytes.byteLength, truncated: false, omitted: "binary" };
  }
  const truncated = bytes.byteLength > BODY_BYTES;
  // Streaming decode holds back a code point the cut splits instead of emitting U+FFFD.
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, BODY_BYTES), {
    stream: truncated,
  });
  return { text, sizeBytes: bytes.byteLength, truncated };
};

const receivedBodyBytes = async (response: Response) => {
  try {
    return (await response.request().sizes()).responseBodySize;
  } catch {
    return undefined;
  }
};

const responseBodyOf = async (response: Response): Promise<PreviewAutomationNetworkBody> => {
  const headers = response.headers();
  const contentType = headers["content-type"];
  const declared = declaredLength(headers);
  const received = await receivedBodyBytes(response);
  // Chunked framing wins over a conflicting content-length, so the larger size bounds the fetch.
  const size =
    declared === undefined && received === undefined
      ? undefined
      : Math.max(declared ?? 0, received ?? 0);
  const known = size === undefined ? {} : { sizeBytes: size };
  if (contentType !== undefined && !isText(contentType)) {
    return { ...known, truncated: false, omitted: "binary" };
  }
  // Both sizes count encoded bytes, and body() decompresses, so a compressed body has no bound.
  const compressed =
    (headers["content-encoding"] ?? "identity").trim().toLowerCase() !== "identity";
  // A body that arrived with no bytes came from a cache or a prefetch, which body() fetches again
  // without any bound.
  if (compressed || (received ?? 0) <= 0 || (size ?? 0) > BODY_FETCH_BYTES) {
    return { ...known, truncated: true, omitted: "unavailable" };
  }
  try {
    return bodyOf(await response.body(), contentType);
  } catch {
    // Redirects have no body, and Chromium evicts bodies after navigations or under memory pressure.
    return { ...known, truncated: false, omitted: "unavailable" };
  }
};

/** Every request a tab made, newest last, kept as Playwright objects so details cost nothing until asked for. */
export class NetworkLog {
  private readonly entries: Array<TrackedRequest> = [];
  private readonly byRequest = new WeakMap<Request, TrackedRequest>();
  private sequence = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  record(page: Page) {
    page.on("request", (request) => {
      const entry: TrackedRequest = {
        id: `r${++this.sequence}`,
        request,
        startedAt: this.now(),
        response: null,
        finishedAt: null,
        errorText: null,
      };
      this.byRequest.set(request, entry);
      this.entries.push(entry);
      if (this.entries.length > DIAGNOSTIC_BUFFER_LIMIT) {
        this.entries.splice(0, this.entries.length - DIAGNOSTIC_BUFFER_LIMIT);
      }
    });
    page.on("response", (response) => {
      const entry = this.byRequest.get(response.request());
      if (entry) entry.response = response;
    });
    page.on("requestfinished", (request) => {
      const entry = this.byRequest.get(request);
      if (entry) entry.finishedAt = this.now();
    });
    page.on("requestfailed", (request) => {
      const entry = this.byRequest.get(request);
      if (!entry) return;
      entry.finishedAt = this.now();
      entry.errorText = request.failure()?.errorText ?? "";
    });
  }

  private summary(entry: TrackedRequest): PreviewAutomationNetworkRequest {
    const { request, response, errorText, finishedAt } = entry;
    return {
      id: entry.id,
      method: request.method(),
      url: withoutDataPayload(request.url()).slice(0, URL_CHARS),
      resourceType: request.resourceType(),
      state: errorText !== null ? "failed" : finishedAt !== null ? "finished" : "pending",
      status: response?.status() ?? null,
      ...(errorText ? { errorText } : {}),
      startedAt: new Date(entry.startedAt).toISOString(),
      durationMs:
        finishedAt === null ? null : Math.max(0, Math.round(finishedAt - entry.startedAt)),
    };
  }

  private async detail(entry: TrackedRequest): Promise<PreviewAutomationNetworkRequest> {
    const { request, response } = entry;
    const requestHeaders = request.headers();
    const posted = request.postDataBuffer();
    const finished = entry.finishedAt !== null && entry.errorText === null;
    return {
      ...this.summary(entry),
      requestHeaders: redactHeaders(requestHeaders),
      ...(response ? { responseHeaders: redactHeaders(response.headers()) } : {}),
      ...(posted ? { requestBody: bodyOf(posted, requestHeaders["content-type"]) } : {}),
      // A pending body would wait for the whole response, which may never end.
      ...(response && finished ? { responseBody: await responseBodyOf(response) } : {}),
    };
  }

  async query(
    tabId: string,
    input: PreviewAutomationNetworkInput,
  ): Promise<PreviewAutomationNetworkLog> {
    if (input.requestId !== undefined) {
      const entry = this.entries.find((candidate) => candidate.id === input.requestId);
      if (!entry) {
        throw new ServerBrowserOperationError(
          "PreviewAutomationExecutionError",
          `Request ${input.requestId} is no longer in this tab's log, which keeps the newest ${DIAGNOSTIC_BUFFER_LIMIT}. List the requests again.`,
        );
      }
      return { tabId: PreviewTabId.make(tabId), matched: 1, requests: [await this.detail(entry)] };
    }
    const { urlIncludes } = input;
    const matches =
      urlIncludes === undefined
        ? this.entries
        : this.entries.filter((entry) =>
            withoutDataPayload(entry.request.url()).includes(urlIncludes),
          );
    return {
      tabId: PreviewTabId.make(tabId),
      matched: matches.length,
      requests: matches
        .slice(-(input.limit ?? DEFAULT_LIST_LIMIT))
        .map((entry) => this.summary(entry)),
    };
  }
}
