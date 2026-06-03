import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const TestHttpEffect = Effect.gen(function* () {
  const request = yield* HttpServerRequest;
  const url = new URL(request.originalUrl);
  const pathname = url.pathname;

  if (request.method === "GET" && pathname === "/inspect") {
    return yield* HttpServerResponse.json({
      method: request.method,
      url: request.url,
      originalUrl: request.originalUrl,
      host: request.headers.host,
      protocol: request.headers["x-forwarded-proto"],
      requestId: request.headers["x-request-id"],
      remoteAddress: Option.getOrUndefined(request.remoteAddress),
      query: Object.fromEntries(url.searchParams.entries()),
      cookies: request.cookies,
    });
  }

  if (request.method === "POST" && pathname === "/jobs") {
    const payload = (yield* request.json) as { content: string };
    const response = yield* HttpServerResponse.json(
      {
        method: request.method,
        url: request.url,
        payload,
      },
      {
        status: 201,
        headers: {
          "x-handler": "lambda-http",
        },
      },
    );

    return HttpServerResponse.setCookieUnsafe(
      response,
      "job-session",
      "created",
      {
        httpOnly: true,
        path: "/",
      },
    );
  }

  if (request.method === "GET" && pathname === "/binary") {
    return HttpServerResponse.uint8Array(new TextEncoder().encode("alchemy"), {
      headers: {
        "content-type": "application/octet-stream",
      },
    });
  }

  return HttpServerResponse.text("Not found", { status: 404 });
});
