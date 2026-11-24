import { expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/http";

import { requestUrl } from "./requestUrl.ts";

const forwarded = (protocol: string, path = "/ws") =>
  HttpServerRequest.fromWeb(
    new Request(`http://127.0.0.1:3773${path}`, {
      headers: { host: "t3.example.com", "x-forwarded-proto": protocol },
    }),
  );

const urlOf = (request: HttpServerRequest.HttpServerRequest) =>
  Option.getOrThrowWith(requestUrl(request), () => new Error("no url"));

it("uses the scheme a TLS-terminating proxy forwards for an HTTP upgrade", () => {
  // Traefik sends `wss` for the upgraded /ws request and `https` for plain HTTP.
  expect(urlOf(forwarded("wss")).protocol).toBe("https:");
  expect(urlOf(forwarded("wss")).href).toBe("https://t3.example.com/ws");
});

it("keeps https and ignores a forwarded origin from an already-TLS hop", () => {
  expect(urlOf(forwarded("https")).protocol).toBe("https:");
  expect(urlOf(forwarded("http")).protocol).toBe("http:");
});
