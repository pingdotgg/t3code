import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import * as Http from "alchemy/Http";
import type {
  ALBEvent,
  ALBResult,
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  LambdaFunctionURLEvent,
  LambdaFunctionURLResult,
} from "aws-lambda";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import type { Scope } from "effect/Scope";
import { type InvocationTimeoutError, withInvocationDeadline } from "./InvocationDeadline.ts";

export const isFunctionURLEvent = (event: any): event is LambdaFunctionURLEvent =>
  event.requestContext?.http?.method !== undefined;

/**
 * REST API (v1) AWS_PROXY events have a top-level `httpMethod` and a
 * `requestContext.resourcePath` field. They lack the `requestContext.http.*`
 * shape of Function URL / HTTP API (v2) events.
 */
export const isApiGatewayProxyEvent = (event: any): event is APIGatewayProxyEvent =>
  typeof event?.httpMethod === "string" && event?.requestContext?.resourcePath !== undefined;

/**
 * Application Load Balancer target events carry a `requestContext.elb` marker
 * (the target group ARN) and a top-level `httpMethod` + `path`.
 */
export const isAlbEvent = (event: any): event is ALBEvent =>
  typeof event?.httpMethod === "string" && event?.requestContext?.elb !== undefined;

// `HttpMiddleware.tracer` records the request on the `http.server` span only
// when the request finishes. A span the backstop flush ends early would ship
// without it, so record the method and path up front.
const annotateRequestSpan = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const span = yield* Effect.option(Effect.currentSpan);
    if (Option.isSome(span)) {
      span.value.attribute("http.request.method", request.method);
      span.value.attribute("url.path", new URL(request.url, "http://localhost").pathname);
    }
    return yield* self;
  });

export const makeFunctionHttpHandler = <Req>(
  handler: Http.HttpEffect<Req>,
  options: {
    /** Return Function URL responses as a {@link FunctionURLStream}. */
    responseStream?: boolean;
  } = {},
) => {
  // `HttpMiddleware.tracer` creates the `http.server` root span per request
  // (continuing an incoming `traceparent`), matching the Worker bridge's
  // fetch path. With the default no-op tracer this is free; with a telemetry
  // exporter installed the span is exported when the invocation scope
  // flushes.
  //
  // The invocation deadline sits INSIDE the span, so a request that runs
  // past the Function's `timeout` is interrupted within it: the `http.server`
  // span ends with `InvocationTimeoutError`, with every child span ended by
  // the interruption. No response is sent: the dispatcher holds the
  // invocation until Lambda's own timeout answers it. The dispatcher's outer
  // guard stands down when this one takes the deadline; see
  // `withInvocationDeadline`.
  const safeHandler = handler.pipe(
    Http.safeHttpEffect,
    withInvocationDeadline(),
    annotateRequestSpan,
    HttpMiddleware.tracer,
  );
  return (
    event: any,
  ):
    | Effect.Effect<
        ALBResult | APIGatewayProxyResult | LambdaFunctionURLResult | FunctionURLStream,
        InvocationTimeoutError,
        Exclude<Effect.Services<typeof handler>, HttpServerRequest.HttpServerRequest | Scope>
      >
    | undefined => {
    if (isFunctionURLEvent(event)) {
      const webRequest = functionUrlEventToWebRequest(event);
      const request = HttpServerRequest.fromWeb(webRequest).modify({
        url: webRequest.url,
        remoteAddress: Option.some(event.requestContext.http.sourceIp),
      });
      // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- safeHandler handles failures other than the invocation deadline; generic Exclude on R can't be proven statically
      return safeHandler.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.flatMap((response): Effect.Effect<LambdaFunctionURLResult | FunctionURLStream> =>
          options.responseStream
            ? toFunctionURLStream(response)
            : toLambdaFunctionURLResult(response),
        ),
      ) as Effect.Effect<
        LambdaFunctionURLResult | FunctionURLStream,
        InvocationTimeoutError,
        Exclude<Effect.Services<typeof handler>, HttpServerRequest.HttpServerRequest | Scope>
      >;
    }
    if (isAlbEvent(event)) {
      const webRequest = albEventToWebRequest(event);
      const request = HttpServerRequest.fromWeb(webRequest).modify({
        url: webRequest.url,
      });
      // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- safeHandler handles failures other than the invocation deadline; generic Exclude on R can't be proven statically
      return safeHandler.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        // The ALB result shape is the API Gateway v1 result shape (statusCode,
        // headers, multiValueHeaders, body, isBase64Encoded); ALB reads
        // whichever of headers/multiValueHeaders matches the target group's
        // multi-value-headers setting.
        Effect.flatMap(toApiGatewayProxyResult),
      ) as Effect.Effect<
        ALBResult,
        InvocationTimeoutError,
        Exclude<Effect.Services<typeof handler>, HttpServerRequest.HttpServerRequest | Scope>
      >;
    }
    if (isApiGatewayProxyEvent(event)) {
      const webRequest = apiGatewayProxyEventToWebRequest(event);
      const request = HttpServerRequest.fromWeb(webRequest).modify({
        url: webRequest.url,
        remoteAddress: Option.fromNullishOr(event.requestContext?.identity?.sourceIp),
      });
      // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- safeHandler handles failures other than the invocation deadline; generic Exclude on R can't be proven statically
      return safeHandler.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.flatMap(toApiGatewayProxyResult),
      ) as Effect.Effect<
        APIGatewayProxyResult,
        InvocationTimeoutError,
        Exclude<Effect.Services<typeof handler>, HttpServerRequest.HttpServerRequest | Scope>
      >;
    }
  };
};

const functionUrlEventToWebRequest = (event: LambdaFunctionURLEvent): Request => {
  // `requestContext.http.protocol` is the HTTP version ("HTTP/1.1"), never a
  // URL scheme — without `x-forwarded-proto` (real Function URLs always set
  // it; local emulators may not) fall back to https.
  const protocol = event.headers["x-forwarded-proto"] ?? "https";
  const host = event.headers.host ?? event.requestContext.domainName;
  const url = `${protocol}://${host}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ""}`;
  const method = event.requestContext.http.method;
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers)) {
    if (value !== undefined) {
      headers.set(key, value);
    }
  }
  if (event.cookies?.length) {
    headers.set("cookie", event.cookies.join("; "));
  }

  let body: string | ArrayBuffer | undefined;
  if (event.body !== undefined) {
    body = event.isBase64Encoded
      ? Uint8Array.from(atob(event.body), (c) => c.charCodeAt(0)).buffer
      : event.body;
  }

  return new Request(url, {
    method,
    headers,
    body: body && method !== "GET" && method !== "HEAD" ? body : undefined,
  });
};

const albEventToWebRequest = (event: ALBEvent): Request => {
  const headers = new Headers();
  if (event.multiValueHeaders) {
    for (const [key, values] of Object.entries(event.multiValueHeaders)) {
      if (!values) continue;
      for (const value of values) {
        if (value !== undefined && value !== null) {
          headers.append(key, value);
        }
      }
    }
  }
  if (event.headers) {
    for (const [key, value] of Object.entries(event.headers)) {
      if (value !== undefined && value !== null && !headers.has(key)) {
        headers.set(key, value);
      }
    }
  }

  const protocol = headers.get("x-forwarded-proto") ?? headers.get("X-Forwarded-Proto") ?? "http";
  const host = headers.get("host") ?? headers.get("Host") ?? "alb";

  // Unlike API Gateway, ALB does NOT URL-decode the path or query-string
  // parameters — they arrive still percent-encoded, so join them verbatim
  // (re-encoding would double-encode).
  const queryParts: string[] = [];
  if (event.multiValueQueryStringParameters) {
    for (const [k, vs] of Object.entries(event.multiValueQueryStringParameters)) {
      if (!vs) continue;
      for (const v of vs) {
        queryParts.push(`${k}=${v ?? ""}`);
      }
    }
  } else if (event.queryStringParameters) {
    for (const [k, v] of Object.entries(event.queryStringParameters)) {
      if (v === undefined || v === null) continue;
      queryParts.push(`${k}=${v}`);
    }
  }
  const queryString = queryParts.length > 0 ? `?${queryParts.join("&")}` : "";

  const url = `${protocol}://${host}${event.path ?? "/"}${queryString}`;
  const method = event.httpMethod;

  let body: string | ArrayBuffer | undefined;
  if (event.body !== null && event.body !== undefined) {
    body = event.isBase64Encoded
      ? Uint8Array.from(atob(event.body), (c) => c.charCodeAt(0)).buffer
      : event.body;
  }

  return new Request(url, {
    method,
    headers,
    body: body && method !== "GET" && method !== "HEAD" ? body : undefined,
  });
};

const apiGatewayProxyEventToWebRequest = (event: APIGatewayProxyEvent): Request => {
  const headers = new Headers();
  if (event.multiValueHeaders) {
    for (const [key, values] of Object.entries(event.multiValueHeaders)) {
      if (!values) continue;
      for (const value of values) {
        if (value !== undefined && value !== null) {
          headers.append(key, value);
        }
      }
    }
  }
  if (event.headers) {
    for (const [key, value] of Object.entries(event.headers)) {
      if (value !== undefined && value !== null && !headers.has(key)) {
        headers.set(key, value);
      }
    }
  }

  const protocol = headers.get("x-forwarded-proto") ?? headers.get("X-Forwarded-Proto") ?? "https";
  const host =
    headers.get("host") ?? headers.get("Host") ?? event.requestContext.domainName ?? "lambda";
  const stage = event.requestContext.stage;
  // API Gateway prefixes paths with the stage when invoked via the default
  // execute-api endpoint; `event.path` already contains that. Use it as-is.
  const path = event.path ?? "/";

  const queryParts: string[] = [];
  if (event.multiValueQueryStringParameters) {
    for (const [k, vs] of Object.entries(event.multiValueQueryStringParameters)) {
      if (!vs) continue;
      for (const v of vs) {
        queryParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`);
      }
    }
  } else if (event.queryStringParameters) {
    for (const [k, v] of Object.entries(event.queryStringParameters)) {
      if (v === undefined || v === null) continue;
      queryParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
  }
  const queryString = queryParts.length > 0 ? `?${queryParts.join("&")}` : "";

  const url = `${protocol}://${host}${path}${queryString}`;
  const method = event.httpMethod;

  let body: string | ArrayBuffer | undefined;
  if (event.body !== null && event.body !== undefined) {
    body = event.isBase64Encoded
      ? Uint8Array.from(atob(event.body), (c) => c.charCodeAt(0)).buffer
      : event.body;
  }

  // Reference `stage` so static analysis sees it as used; the variable is
  // useful when constructing fully-qualified URLs in downstream code.
  void stage;

  return new Request(url, {
    method,
    headers,
    body: body && method !== "GET" && method !== "HEAD" ? body : undefined,
  });
};

const toLambdaFunctionURLResult = (
  response: HttpServerResponse.HttpServerResponse,
): Effect.Effect<LambdaFunctionURLResult> =>
  Effect.gen(function* () {
    const context = yield* Effect.context();
    const webResponse = HttpServerResponse.toWeb(response, { context });
    const headers = new Headers(webResponse.headers);
    const cookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];

    headers.delete("set-cookie");

    if (!webResponse.body) {
      return {
        statusCode: webResponse.status,
        headers: Object.fromEntries(headers.entries()),
        cookies: cookies.length > 0 ? cookies : undefined,
      };
    }

    const bytes = new Uint8Array(yield* Effect.promise(() => webResponse.arrayBuffer()));
    const isTextual = isTextualContentType(headers.get("content-type"));
    const body =
      bytes.length === 0
        ? undefined
        : isTextual
          ? new TextDecoder().decode(bytes)
          : Buffer.from(bytes).toString("base64");

    return {
      statusCode: webResponse.status,
      headers: Object.fromEntries(headers.entries()),
      body,
      cookies: cookies.length > 0 ? cookies : undefined,
      isBase64Encoded: body !== undefined && !isTextual ? true : undefined,
    };
  });

const toApiGatewayProxyResult = (
  response: HttpServerResponse.HttpServerResponse,
): Effect.Effect<APIGatewayProxyResult> =>
  Effect.gen(function* () {
    const context = yield* Effect.context();
    const webResponse = HttpServerResponse.toWeb(response, { context });
    const headers = new Headers(webResponse.headers);

    const multiValueHeaders: { [name: string]: string[] } = {};
    const singleHeaders: { [name: string]: string } = {};
    for (const [key, value] of headers.entries()) {
      if (multiValueHeaders[key]) {
        multiValueHeaders[key].push(value);
      } else {
        multiValueHeaders[key] = [value];
        singleHeaders[key] = value;
      }
    }

    if (!webResponse.body) {
      return {
        statusCode: webResponse.status,
        headers: singleHeaders,
        multiValueHeaders,
        body: "",
      };
    }

    const bytes = new Uint8Array(yield* Effect.promise(() => webResponse.arrayBuffer()));
    const isTextual = isTextualContentType(headers.get("content-type"));
    const isBase64 = bytes.length > 0 && !isTextual;
    const body =
      bytes.length === 0
        ? ""
        : isTextual
          ? new TextDecoder().decode(bytes)
          : Buffer.from(bytes).toString("base64");

    return {
      statusCode: webResponse.status,
      headers: singleHeaders,
      multiValueHeaders,
      body,
      isBase64Encoded: isBase64,
    };
  });

const isTextualContentType = (contentType: string | null): boolean => {
  if (!contentType) {
    return false;
  }

  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("javascript") ||
    normalized.includes("form-urlencoded")
  );
};

/**
 * Set by the deploy when the Function URL uses `invokeMode:
 * "RESPONSE_STREAM"`; the runtime then exports a streaming handler.
 */
export const RESPONSE_STREAM_ENV = "ALCHEMY_LAMBDA_RESPONSE_STREAM";

interface ResponseStreamMetadata {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
}

/** The `awslambda` global the Lambda Node.js runtime installs. */
interface AwsLambdaGlobal {
  streamifyResponse: (
    handler: (event: any, responseStream: NodeJS.WritableStream, context: any) => Promise<void>,
  ) => (event: any, context: any) => Promise<any>;
  HttpResponseStream: {
    from: (
      stream: NodeJS.WritableStream,
      metadata: ResponseStreamMetadata,
    ) => NodeJS.WritableStream;
  };
}

const awslambda = () => (globalThis as unknown as { awslambda?: AwsLambdaGlobal }).awslambda;

/**
 * Whether this sandbox serves a `RESPONSE_STREAM` Function URL. Dies on a
 * malformed flag: the deploy writes it, so a bad value is a deploy bug, not
 * something a handler can recover from.
 */
export const isResponseStreaming: Effect.Effect<boolean> = Config.Boolean(RESPONSE_STREAM_ENV).pipe(
  Config.withDefault(false),
  Effect.map((streaming) => streaming && awslambda() !== undefined),
  Effect.orDie,
);

/** A Function URL response whose body is still being produced. */
interface FunctionURLStream {
  readonly _tag: "FunctionURLStream";
  readonly metadata: ResponseStreamMetadata;
  readonly body: ReadableStream<Uint8Array> | null;
}

// As in the Cloudflare Worker bridge, the body stream takes over the request
// scope and closes it when it finishes: the dispatcher returns as soon as
// the headers are ready, and sees the scope as ejected.
const toFunctionURLStream = (
  response: HttpServerResponse.HttpServerResponse,
): Effect.Effect<FunctionURLStream> =>
  Effect.map(Effect.context(), (context) => {
    const webResponse = HttpServerResponse.toWeb(HttpEffect.scopeTransferToStream(response), {
      context,
    });
    const headers = new Headers(webResponse.headers);
    const cookies = headers.getSetCookie();
    headers.delete("set-cookie");
    return {
      _tag: "FunctionURLStream",
      metadata: {
        statusCode: webResponse.status,
        headers: Object.fromEntries(headers.entries()),
        ...(cookies.length > 0 ? { cookies } : {}),
      },
      body: webResponse.body,
    };
  });

const isFunctionURLStream = (result: unknown): result is FunctionURLStream =>
  (result as FunctionURLStream | undefined)?._tag === "FunctionURLStream";

/**
 * Wrap the Lambda dispatcher with `awslambda.streamifyResponse`. A Function
 * URL response is piped into the response stream as its body is produced;
 * any other listener's result (an SQS batch response, a direct `Invoke`) is
 * written as JSON, which a buffered `Invoke` returns as its payload.
 */
export const streamifyHandler = (dispatch: (event: any, context: any) => Promise<unknown>) => {
  const aws = awslambda()!;
  return aws.streamifyResponse(async (event, responseStream, context) => {
    const result = await dispatch(event, context);
    if (!isFunctionURLStream(result)) {
      responseStream.end(JSON.stringify(result) ?? "");
      return;
    }
    const stream = aws.HttpResponseStream.from(responseStream, result.metadata);
    if (result.body === null) {
      // The metadata prelude is only flushed by a write.
      stream.end("");
      return;
    }
    await pipeline(Readable.fromWeb(result.body as unknown as NodeReadableStream), stream);
  });
};
