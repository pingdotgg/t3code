import { makeFunctionHttpHandler } from "@/AWS/Lambda/HttpServer";
import type {
  LambdaFunctionURLEvent,
  LambdaFunctionURLResult,
} from "aws-lambda";
import * as Effect from "effect/Effect";
import type { Scope } from "effect/Scope";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { describe, expect, it } from "vitest";
import { TestHttpEffect } from "./HttpServer.fixture";

describe("AWS.Lambda.HttpServer", () => {
  it("maps a Function URL event into HttpServerRequest", async () => {
    const result = asStructuredResult(
      await invoke(
        makeEvent({
          rawPath: "/inspect",
          rawQueryString: "jobId=job-123&trace=1",
          headers: {
            "x-forwarded-proto": "https",
            "x-request-id": "req-123",
          },
          cookies: ["session=abc", "theme=dark"],
          requestContext: {
            http: {
              method: "GET",
              path: "/inspect",
              sourceIp: "203.0.113.42",
            },
          } as LambdaFunctionURLEvent["requestContext"],
        }),
      ),
    );

    expect(result.statusCode).toBe(200);
    expect(result.headers?.["content-type"]).toContain("application/json");
    expect(JSON.parse(result.body ?? "")).toEqual({
      method: "GET",
      url: "https://example.lambda-url.us-east-1.on.aws/inspect?jobId=job-123&trace=1",
      originalUrl:
        "https://example.lambda-url.us-east-1.on.aws/inspect?jobId=job-123&trace=1",
      host: "example.lambda-url.us-east-1.on.aws",
      protocol: "https",
      requestId: "req-123",
      remoteAddress: "203.0.113.42",
      query: {
        jobId: "job-123",
        trace: "1",
      },
      cookies: {
        session: "abc",
        theme: "dark",
      },
    });
  });

  it("maps HttpServerResponse into a Function URL result", async () => {
    const result = asStructuredResult(
      await invoke(
        makeEvent({
          rawPath: "/jobs",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            content: "ship it",
          }),
          requestContext: {
            http: {
              method: "POST",
              path: "/jobs",
            },
          } as LambdaFunctionURLEvent["requestContext"],
        }),
      ),
    );

    expect(result.statusCode).toBe(201);
    expect(result.headers).toMatchObject({
      "content-type": "application/json",
      "x-handler": "lambda-http",
    });
    expect(result.cookies).toHaveLength(1);
    expect(result.cookies?.[0]).toContain("job-session=created");
    expect(JSON.parse(result.body ?? "")).toEqual({
      method: "POST",
      url: "https://example.lambda-url.us-east-1.on.aws/jobs",
      payload: {
        content: "ship it",
      },
    });
    expect(result.body).not.toContain("HttpServerResponse");
  });

  it("base64 encodes binary responses", async () => {
    const result = asStructuredResult(
      await invoke(
        makeEvent({
          rawPath: "/binary",
          requestContext: {
            http: {
              method: "GET",
              path: "/binary",
            },
          } as LambdaFunctionURLEvent["requestContext"],
        }),
      ),
    );

    expect(result.statusCode).toBe(200);
    expect(result.headers?.["content-type"]).toBe("application/octet-stream");
    expect(result.isBase64Encoded).toBe(true);
    expect(Buffer.from(result.body ?? "", "base64").toString("utf8")).toBe(
      "alchemy",
    );
  });

  it("uses shared Http error handling for defects", async () => {
    const result = asStructuredResult(
      await invoke(
        makeEvent({
          rawPath: "/boom",
          requestContext: {
            http: {
              method: "GET",
              path: "/boom",
            },
          } as LambdaFunctionURLEvent["requestContext"],
        }),
        Effect.fail({ message: "Boom" } as any).pipe(Effect.orDie),
      ),
    );

    expect(result.statusCode).toBe(500);
    expect(result.headers?.["content-type"]).toContain("text/plain");
    expect(result.body).toBe("Internal Server Error");
  });
});

const invoke = async (
  event: LambdaFunctionURLEvent,
  handler: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    any,
    HttpServerRequest.HttpServerRequest | Scope
  > = TestHttpEffect,
): Promise<LambdaFunctionURLResult> => {
  const out = makeFunctionHttpHandler(handler)(event);
  if (!Effect.isEffect(out)) {
    throw new Error("Expected Effect from Function URL handler");
  }
  return Effect.runPromise(out);
};

const makeEvent = (
  overrides: Partial<LambdaFunctionURLEvent> = {},
): LambdaFunctionURLEvent => {
  const event: LambdaFunctionURLEvent = {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/",
    rawQueryString: "",
    cookies: undefined,
    headers: {
      host: "example.lambda-url.us-east-1.on.aws",
      "x-forwarded-proto": "https",
    },
    queryStringParameters: undefined,
    requestContext: {
      accountId: "123456789012",
      apiId: "api-id",
      domainName: "example.lambda-url.us-east-1.on.aws",
      domainPrefix: "example",
      http: {
        method: "GET",
        path: "/",
        protocol: "HTTP/1.1",
        sourceIp: "203.0.113.10",
        userAgent: "vitest",
      },
      requestId: "request-id",
      routeKey: "$default",
      stage: "$default",
      time: "09/Mar/2026:00:00:00 +0000",
      timeEpoch: 1741478400000,
    },
    body: undefined,
    pathParameters: undefined,
    isBase64Encoded: false,
    stageVariables: undefined,
  };

  return {
    ...event,
    ...overrides,
    headers: {
      ...event.headers,
      ...overrides.headers,
    },
    requestContext: {
      ...event.requestContext,
      ...overrides.requestContext,
      http: {
        ...event.requestContext.http,
        ...overrides.requestContext?.http,
      },
    },
  };
};

const asStructuredResult = (
  result: LambdaFunctionURLResult,
): Exclude<LambdaFunctionURLResult, string> => {
  if (typeof result === "string") {
    throw new Error(`Expected a structured Lambda response, got: ${result}`);
  }

  return result;
};
