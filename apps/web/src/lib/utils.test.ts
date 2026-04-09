import { assert, describe, expect, it, vi } from "vitest";

const { resolvePrimaryEnvironmentBootstrapUrlMock } = vi.hoisted(() => ({
  resolvePrimaryEnvironmentBootstrapUrlMock: vi.fn(() => "http://bootstrap.test:4321"),
}));

vi.mock("../environmentBootstrap", () => ({
  resolvePrimaryEnvironmentBootstrapUrl: resolvePrimaryEnvironmentBootstrapUrlMock,
}));

import { isWindowsPlatform } from "./utils";
import { resolveServerUrl } from "./utils";

describe("isWindowsPlatform", () => {
  it("matches Windows platform identifiers", () => {
    assert.isTrue(isWindowsPlatform("Win32"));
    assert.isTrue(isWindowsPlatform("Windows"));
    assert.isTrue(isWindowsPlatform("windows_nt"));
  });

  it("does not match darwin", () => {
    assert.isFalse(isWindowsPlatform("darwin"));
  });
});

describe("resolveServerUrl", () => {
  it("falls back to the bootstrap environment URL when the explicit URL is empty", () => {
    expect(resolveServerUrl({ url: "" })).toBe("http://bootstrap.test:4321/");
  });

  it("uses the bootstrap environment URL when no explicit URL is provided", () => {
    expect(resolveServerUrl()).toBe("http://bootstrap.test:4321/");
  });

  it("prefers an explicit URL override", () => {
    expect(
      resolveServerUrl({
        url: "https://override.test:9999",
        protocol: "wss",
        pathname: "/rpc",
        searchParams: { hello: "world" },
      }),
    ).toBe("wss://override.test:9999/rpc?hello=world");
  });

  it("does not evaluate the bootstrap resolver when an explicit URL is provided", () => {
    resolvePrimaryEnvironmentBootstrapUrlMock.mockImplementationOnce(() => {
      throw new Error("bootstrap unavailable");
    });

    expect(resolveServerUrl({ url: "https://override.test:9999" })).toBe(
      "https://override.test:9999/",
    );
  });
});
