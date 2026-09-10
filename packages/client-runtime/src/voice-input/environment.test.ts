import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { FetchHttpClient } from "effect/unstable/http";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  PrimaryConnectionTarget,
  type PreparedConnection,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";
import { transcribeEnvironmentPcm } from "./environment.ts";

const environmentId = Schema.decodeUnknownSync(EnvironmentId)("voice-test");
const prepared = (
  httpBaseUrl: string,
  httpAuthorization: PreparedHttpAuthorization | null = null,
): PreparedConnection => ({
  environmentId,
  label: "test",
  httpBaseUrl,
  socketUrl: "ws://localhost/ws",
  httpAuthorization,
  target: new PrimaryConnectionTarget({
    environmentId,
    label: "test",
    httpBaseUrl,
    wsBaseUrl: "ws://localhost",
  }),
});
for (const url of [
  "http://remote.example",
  "http://127.0.0.1.evil.example",
  "http://192.168.1.1",
]) {
  it.effect(`does not send audio or credentials to ${url}`, () =>
    Effect.gen(function* () {
      const fetch = vi.fn(async () => Response.json({ text: "hello" }));
      const result = yield* transcribeEnvironmentPcm(prepared(url), new Uint8Array(4)).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.result,
      );
      expect(Result.isFailure(result) && result.failure).toMatchObject({
        message: "Voice input requires HTTPS for remote environments.",
      });
      expect(fetch).not.toHaveBeenCalled();
    }),
  );
}
for (const url of [
  "https://remote.example",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://[::1]:3000",
]) {
  it.effect(`allows protected or loopback transport ${url}`, () =>
    Effect.gen(function* () {
      const fetch = vi.fn(async () => Response.json({ text: "hello" }));
      expect(
        yield* transcribeEnvironmentPcm(prepared(url), new Uint8Array(4)).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, fetch),
        ),
      ).toEqual({ text: "hello" });
      expect(fetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ redirect: "error", credentials: "include" }),
      );
    }),
  );
}

it.effect("does not send browser cookies with bearer-authenticated voice requests", () =>
  Effect.gen(function* () {
    const fetch = vi.fn(async () => Response.json({ text: "hello" }));
    yield* transcribeEnvironmentPcm(
      prepared("https://remote.example", { _tag: "Bearer", token: "secret" }),
      new Uint8Array(4),
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    const requestInit = fetch.mock.calls[0]?.[1];
    expect(requestInit).toEqual(expect.objectContaining({ redirect: "error" }));
    expect(requestInit?.credentials).toBeUndefined();
  }),
);
