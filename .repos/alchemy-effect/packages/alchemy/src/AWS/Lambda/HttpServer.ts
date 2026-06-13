import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  LambdaFunctionURLEvent,
  LambdaFunctionURLResult,
} from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Scope } from "effect/Scope";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Http from "../../Http.ts";

export const isFunctionURLEvent = (
  event: any,
): event is LambdaFunctionURLEvent => {
  return event.requestContext?.http?.method !== undefined;
};

/**
 * REST API (v1) AWS_PROXY events have a top-level `httpMethod` and a
 * `requestContext.resourcePath` field. They lack the `requestContext.http.*`
 * shape of Function URL / HTTP API (v2) events.
 */
export const isApiGatewayProxyEvent = (
  event: any,
): event is APIGatewayProxyEvent => {
  return (
    typeof event?.httpMethod === "string" &&
    event?.requestContext?.resourcePath !== undefined
  );
};

export const makeFunctionHttpHandler = <Req>(handler: Http.HttpEffect<Req>) => {
  const safeHandler = Http.safeHttpEffect(handler);
  return (event: any) => {
    if (isFunctionURLEvent(event)) {
      const webRequest = functionUrlEventToWebRequest(event);
      const request = HttpServerRequest.fromWeb(webRequest).modify({
        url: webRequest.url,
        remoteAddress: Option.some(event.requestContext.http.sourceIp),
      });
      return safeHandler.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.flatMap(toLambdaFunctionURLResult),
      ) as Effect.Effect<
        LambdaFunctionURLResult,
        never,
        Exclude<
          Effect.Services<typeof handler>,
          HttpServerRequest.HttpServerRequest | Scope
        >
      >;
    }
    if (isApiGatewayProxyEvent(event)) {
      const webRequest = apiGatewayProxyEventToWebRequest(event);
      const request = HttpServerRequest.fromWeb(webRequest).modify({
        url: webRequest.url,
        remoteAddress: Option.fromNullishOr(
          event.requestContext?.identity?.sourceIp,
        ),
      });
      return safeHandler.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.flatMap(toApiGatewayProxyResult),
      ) as Effect.Effect<
        APIGatewayProxyResult,
        never,
        Exclude<
          Effect.Services<typeof handler>,
          HttpServerRequest.HttpServerRequest | Scope
        >
      >;
    }
  };
};

const functionUrlEventToWebRequest = (
  event: LambdaFunctionURLEvent,
): Request => {
  const protocol =
    event.headers["x-forwarded-proto"] ??
    event.requestContext.http.protocol ??
    "https";
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

const apiGatewayProxyEventToWebRequest = (
  event: APIGatewayProxyEvent,
): Request => {
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

  const protocol =
    headers.get("x-forwarded-proto") ??
    headers.get("X-Forwarded-Proto") ??
    "https";
  const host =
    headers.get("host") ??
    headers.get("Host") ??
    event.requestContext.domainName ??
    "lambda";
  const stage = event.requestContext.stage;
  // API Gateway prefixes paths with the stage when invoked via the default
  // execute-api endpoint; `event.path` already contains that. Use it as-is.
  const path = event.path ?? "/";

  const queryParts: string[] = [];
  if (event.multiValueQueryStringParameters) {
    for (const [k, vs] of Object.entries(
      event.multiValueQueryStringParameters,
    )) {
      if (!vs) continue;
      for (const v of vs) {
        queryParts.push(
          `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`,
        );
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
    const cookies =
      typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];

    headers.delete("set-cookie");

    if (!webResponse.body) {
      return {
        statusCode: webResponse.status,
        headers: Object.fromEntries(headers.entries()),
        cookies: cookies.length > 0 ? cookies : undefined,
      };
    }

    const bytes = new Uint8Array(
      yield* Effect.promise(() => webResponse.arrayBuffer()),
    );
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

    const bytes = new Uint8Array(
      yield* Effect.promise(() => webResponse.arrayBuffer()),
    );
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
