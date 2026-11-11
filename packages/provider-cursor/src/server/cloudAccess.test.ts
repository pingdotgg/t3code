import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { makeCursorCloudAccess } from "./cloudAccess.ts";

it.effect("checks cloud access with the current SDK credential and reports upstream failures", () =>
  Effect.gen(function* () {
    let key = "test-secret";
    let response = Response.json({ userEmail: "test@example.com" });
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const client = HttpClient.make((request) => {
      requests.push(request);
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    });
    const cloud = yield* makeCursorCloudAccess({
      requireApiKey: Effect.sync(() => key),
      withAccess: (task) => task,
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
    yield* cloud.check;
    expect(requests.at(-1)?.url).toBe("https://api.cursor.com/v1/me");
    expect(requests.at(-1)?.headers.authorization).toBe("Bearer test-secret");
    key = "refreshed-sdk-key";
    response = new Response("private upstream failure", { status: 503 });
    const error = yield* cloud.check.pipe(Effect.flip);
    expect(error.status).toBe(503);
    expect(error.message).not.toContain("private upstream failure");
    expect(requests.at(-1)?.headers.authorization).toBe("Bearer refreshed-sdk-key");
    expect(requests).toHaveLength(2);
    response = Response.json("unexpected");
    expect((yield* cloud.check.pipe(Effect.flip)).reason).toBe("response");
  }),
);
