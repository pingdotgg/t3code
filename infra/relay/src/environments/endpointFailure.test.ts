import { describe, expect, it } from "@effect/vitest";

import { classifyEndpointResponse, classifyTransportFailure } from "./endpointFailure.ts";

describe("classifyEndpointResponse", () => {
  it.each([
    [530, "error code: 1033", "tunnel_down"],
    [530, "", "tunnel_down"],
    [530, "error code: 1016", "dns"],
    [502, "Bad Gateway", "origin_unreachable"],
    [503, "", "origin_unreachable"],
    [521, "error code: 521", "refused"],
    [524, "", "timeout"],
    [526, "", "tls"],
    [404, "Not Found", "invalid_response"],
    [200, "<html>", "invalid_response"],
  ] as const)("maps HTTP %i with body %j to %s", (status, body, expected) => {
    expect(classifyEndpointResponse(status, body)).toBe(expected);
  });
});

describe("classifyTransportFailure", () => {
  const nested = (code: string) =>
    new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });

  it.each([
    ["ENOTFOUND", "dns"],
    ["ECONNREFUSED", "refused"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE: certificate", "tls"],
    ["UND_ERR_CONNECT_TIMEOUT", "timeout"],
    ["ECONNRESET", "unknown"],
  ] as const)("reads %s from the cause chain", (code, expected) => {
    expect(classifyTransportFailure(nested(code))).toBe(expected);
  });
});
