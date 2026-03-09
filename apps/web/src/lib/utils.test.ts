import { afterEach, assert, describe, it, vi } from "vitest";

import { isWindowsPlatform, randomUuid } from "./utils";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe("randomUuid", () => {
  it("uses crypto.randomUUID when available", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "11111111-2222-4333-8444-555555555555",
    });

    assert.equal(randomUuid(), "11111111-2222-4333-8444-555555555555");
  });

  it("builds a UUID from getRandomValues when randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = index;
        }
        return bytes;
      },
    });

    const uuid = randomUuid();
    assert.match(uuid, UUID_V4_PATTERN);
    assert.equal(uuid, "00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("falls back to Math.random when crypto is unavailable", () => {
    vi.stubGlobal("crypto", undefined);

    const uuid = randomUuid();
    assert.match(uuid, UUID_V4_PATTERN);
  });
});
