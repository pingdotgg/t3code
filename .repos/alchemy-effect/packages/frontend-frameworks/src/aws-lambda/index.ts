/**
 * `@alchemy.run/frontend-frameworks/aws-lambda` — the web adapter AWS
 * deploy targets wrap around a framework's fetch handler.
 *
 * A Lambda behind a Function URL receives payload-v2 events. Frameworks
 * (Astro, SvelteKit, Waku, Octane, ...) emit a web-standard fetch handler
 * (`(request: Request) => Promise<Response>`). This module converts
 * between the two:
 *
 * - {@link toRequest} — payload-v2 event → web `Request`, honoring
 *   `x-forwarded-host`/`x-forwarded-proto` (set by the CloudFront edge
 *   router) so the framework sees the viewer-facing URL.
 * - {@link toLambdaHandler} — fetch handler → streaming Lambda handler
 *   (`awslambda.streamifyResponse` + `HttpResponseStream`); requires the
 *   Function URL to use `invokeMode: RESPONSE_STREAM`.
 * - {@link toBufferedLambdaHandler} — fetch handler → buffered handler
 *   returning a complete payload-v2 response object, for `invokeMode:
 *   BUFFERED` (the default) and API Gateway HTTP APIs.
 */

/** The slice of a Lambda Function URL (payload v2) event this adapter reads. */
export interface FunctionUrlEvent {
  readonly version?: string;
  readonly rawPath: string;
  readonly rawQueryString?: string;
  readonly headers?: Record<string, string | undefined>;
  readonly cookies?: ReadonlyArray<string>;
  readonly body?: string | undefined;
  readonly isBase64Encoded?: boolean;
  readonly requestContext: {
    readonly domainName?: string;
    readonly http: {
      readonly method: string;
      readonly sourceIp?: string;
    };
  };
}

/** The payload-v2 response shape the buffered handler returns. */
export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: Array<string>;
  body: string;
  isBase64Encoded: boolean;
}

/** A web-standard fetch handler as frameworks emit them. */
export type FetchHandler = (request: Request) => Response | Promise<Response>;

/**
 * The `awslambda` global the Lambda Node.js runtime provides. Declared
 * structurally so this module type-checks outside the Lambda sandbox.
 */
interface AwsLambdaGlobal {
  streamifyResponse: (
    handler: (
      event: FunctionUrlEvent,
      responseStream: NodeJS.WritableStream & { end: () => void },
      context: unknown,
    ) => Promise<void>,
  ) => unknown;
  HttpResponseStream: {
    from: (
      stream: unknown,
      metadata: {
        statusCode: number;
        headers: Record<string, string>;
        cookies?: Array<string>;
      },
    ) => NodeJS.WritableStream & { end: () => void };
  };
}

const awslambdaGlobal = (): AwsLambdaGlobal => {
  const g = (globalThis as { awslambda?: AwsLambdaGlobal }).awslambda;
  if (g === undefined) {
    throw new Error(
      "The `awslambda` global is missing — streaming handlers only run on the AWS Lambda Node.js runtime.",
    );
  }
  return g;
};

/**
 * Convert a Function URL (payload v2) event into a web `Request`.
 *
 * The URL host prefers `x-forwarded-host` (set by the CloudFront edge
 * router) over the Function URL's own domain so framework-side absolute
 * URLs (redirects, canonical links) carry the viewer-facing host.
 */
export const toRequest = (event: FunctionUrlEvent): Request => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(name, value);
  }
  if (event.cookies !== undefined && event.cookies.length > 0) {
    headers.set("cookie", event.cookies.join("; "));
  }
  const host =
    headers.get("x-forwarded-host") ??
    event.requestContext.domainName ??
    headers.get("host") ??
    "localhost";
  const proto = headers.get("x-forwarded-proto") ?? "https";
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `${proto}://${host}${event.rawPath}${query}`;
  const method = event.requestContext.http.method;
  const body =
    event.body === undefined || method === "GET" || method === "HEAD"
      ? undefined
      : event.isBase64Encoded
        ? Buffer.from(event.body, "base64")
        : event.body;
  return new Request(url, {
    method,
    headers,
    body,
    // Node's fetch types require half-duplex for streamed bodies.
    ...(body !== undefined ? { duplex: "half" } : {}),
  } as RequestInit);
};

/** Split a `Response`'s headers into plain headers + set-cookie list. */
const splitHeaders = (
  response: Response,
): { headers: Record<string, string>; cookies: Array<string> } => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") headers[name] = value;
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  return { headers, cookies };
};

/**
 * Wrap a fetch handler as a **streaming** Lambda handler. Export the result
 * as `handler` and deploy behind a Function URL with
 * `invokeMode: RESPONSE_STREAM`.
 *
 * ```ts
 * import { toLambdaHandler } from "@alchemy.run/frontend-frameworks/aws-lambda";
 * import { fetchHandler } from "./framework-server-entry";
 *
 * export const handler = toLambdaHandler(fetchHandler);
 * ```
 */
export const toLambdaHandler = (fetchHandler: FetchHandler): unknown => {
  const aws = awslambdaGlobal();
  return aws.streamifyResponse(async (event, responseStream) => {
    const response = await fetchHandler(toRequest(event));
    const { headers, cookies } = splitHeaders(response);
    const stream = aws.HttpResponseStream.from(responseStream, {
      statusCode: response.status,
      headers,
      ...(cookies.length > 0 ? { cookies } : {}),
    });
    if (response.body === null) {
      // HttpResponseStream requires at least one write for the metadata
      // frame to flush.
      stream.write("");
      stream.end();
      return;
    }
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stream.write(value);
    }
    stream.end();
  });
};

/**
 * Wrap a fetch handler as a **buffered** Lambda handler returning a
 * complete payload-v2 response — for `invokeMode: BUFFERED` Function URLs
 * and API Gateway HTTP APIs.
 */
export const toBufferedLambdaHandler =
  (fetchHandler: FetchHandler) =>
  async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
    const response = await fetchHandler(toRequest(event));
    const { headers, cookies } = splitHeaders(response);
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "";
    const isText =
      /^text\/|application\/(json|javascript|xml|xhtml\+xml|rss\+xml)/.test(
        contentType,
      );
    return {
      statusCode: response.status,
      headers,
      ...(cookies.length > 0 ? { cookies } : {}),
      body: isText ? bytes.toString("utf8") : bytes.toString("base64"),
      isBase64Encoded: !isText,
    };
  };
