// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { describe, it } from "vitest";
import {
  CONTENT_HASH_OFFSET,
  ENTRY_SIZE,
  HEADER_SIZE,
  PATH_HASH_OFFSET,
  PATH_HASH_SIZE,
} from "../../../shared/constants.ts";
import AssetManifestFixture from "../fixtures/AssetManifest.bin";
import { binarySearch, hashPath } from "../src/assets-manifest.ts";

const encoder = new TextEncoder();

async function SHA_256(value: string, length: number) {
  const data = encoder.encode(value);
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    data.buffer as ArrayBuffer,
  );
  return new Uint8Array(hashBuffer, 0, length);
}

function hexToBytes(hex: string) {
  if (!hex.match(/^([0-9a-f]{2})+$/gi)) {
    throw new TypeError(`Invalid byte string:  ${hex}`);
  }

  return new Uint8Array(
    hex.match(/[0-9a-f]{2}/gi)?.map((b) => parseInt(b, 16)) ?? [],
  );
}

const encode = async (
  assetEntries: Array<{ path: string; contentHash: string }>,
) => {
  const entries = await Promise.all(
    assetEntries.map(async (entry) => ({
      path: entry.path,
      contentHash: entry.contentHash,
      pathHashBytes: await SHA_256(entry.path, PATH_HASH_SIZE),
    })),
  );
  entries.sort((a, b) => compare(a.pathHashBytes, b.pathHashBytes));

  const assetManifestBytes = new Uint8Array(
    HEADER_SIZE + entries.length * ENTRY_SIZE,
  );

  for (const [i, { pathHashBytes, contentHash }] of entries.entries()) {
    const contentHashBytes = hexToBytes(contentHash);
    const entryOffset = HEADER_SIZE + i * ENTRY_SIZE;

    assetManifestBytes.set(pathHashBytes, entryOffset + PATH_HASH_OFFSET);
    assetManifestBytes.set(contentHashBytes, entryOffset + CONTENT_HASH_OFFSET);
  }

  return assetManifestBytes.buffer;
};

describe("encode()", () => {
  it("works", async ({ expect }) => {
    const snapshotValue = new Uint8Array(AssetManifestFixture);

    const computedValue = new Uint8Array(
      await encode([
        {
          path: "/path1",
          contentHash: "0123456789abcdef0123456789abcdef",
        },
        {
          path: "/path2",
          contentHash: "1123456789abcdef0123456789abcdef",
        },
        {
          path: "/path3",
          contentHash: "ABCDEF01231230123131231FDFFEDFDF",
        },
      ]),
    );
    expect(compare(computedValue, snapshotValue)).toBe(0);

    const invalidContentHashValue = new Uint8Array(
      await encode([
        {
          path: "/path1",
          contentHash: "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
        },
        {
          path: "/path2",
          contentHash: "1123456789abcdef0123456789abcdef",
        },
        {
          path: "/path3",
          contentHash: "ABCDEF01231230123131231FDFFEDFDF",
        },
      ]),
    );
    expect(compare(invalidContentHashValue, snapshotValue)).not.toBe(0);

    const invalidPathValue = new Uint8Array(
      await encode([
        {
          path: "/path123",
          contentHash: "0123456789abcdef0123456789abcdef",
        },
        {
          path: "/path2",
          contentHash: "1123456789abcdef0123456789abcdef",
        },
        {
          path: "/path3",
          contentHash: "ABCDEF01231230123131231FDFFEDFDF",
        },
      ]),
    );
    expect(compare(invalidPathValue, snapshotValue)).not.toBe(0);
  });
});

const makePathForId = (id: number) => `/path${id}`;

const makeManifestOfLength = async (length: number) => {
  const entries = new Array(length).fill(undefined).map((_, i) => ({
    path: makePathForId(i),
    contentHash: String(i).padEnd(32, "f"),
  }));
  return { entries, manifest: await encode(entries) };
};

describe("search methods", () => {
  describe("binary search", () => {
    it("doesn't error for an empty manifest", async ({ expect }) => {
      const { manifest } = await makeManifestOfLength(0);
      const foundEntry = binarySearch(
        new Uint8Array(manifest),
        await hashPath("/path"),
      );
      expect(foundEntry).toBe(false);
    });

    it("works for a single entry manifest", async ({ expect }) => {
      const { manifest, entries } = await makeManifestOfLength(1);
      for (const searchEntry of entries) {
        const path = await hashPath(searchEntry.path);
        const foundEntry = binarySearch(
          new Uint8Array(manifest),
          path,
        ) as Uint8Array;
        expect(foundEntry).not.toBe(false);
        expect(foundEntry).toEqual(hexToBytes(searchEntry.contentHash));
      }
    });

    it("works for a two entry manifest", async ({ expect }) => {
      const { manifest, entries } = await makeManifestOfLength(2);
      for (const searchEntry of entries) {
        const path = await hashPath(searchEntry.path);
        const foundEntry = binarySearch(
          new Uint8Array(manifest),
          path,
        ) as Uint8Array;
        expect(foundEntry).not.toBe(false);
        expect(foundEntry).toEqual(hexToBytes(searchEntry.contentHash));
      }
    });

    it("works for a three entry manifest", async ({ expect }) => {
      const { manifest, entries } = await makeManifestOfLength(3);
      for (const searchEntry of entries) {
        const path = await hashPath(searchEntry.path);
        const foundEntry = binarySearch(
          new Uint8Array(manifest),
          path,
        ) as Uint8Array;
        expect(foundEntry).not.toBe(false);
        expect(foundEntry).toEqual(hexToBytes(searchEntry.contentHash));
      }
    });

    it("works for a 20,000 entry manifest", async ({ expect }) => {
      const { manifest, entries } = await makeManifestOfLength(20_000);
      for (const searchEntry of entries) {
        const path = await hashPath(searchEntry.path);
        const foundEntry = binarySearch(
          new Uint8Array(manifest),
          path,
        ) as Uint8Array;
        expect(foundEntry).not.toBe(false);
        expect(foundEntry).toEqual(hexToBytes(searchEntry.contentHash));
      }
    });

    it("returns false for non-existent paths", async ({ expect }) => {
      const { manifest } = await makeManifestOfLength(10);
      for (const searchEntry of [
        new Uint8Array(PATH_HASH_SIZE),
        new Uint8Array(PATH_HASH_SIZE).fill(127),
        new Uint8Array(PATH_HASH_SIZE).fill(255),
      ]) {
        const foundEntry = binarySearch(new Uint8Array(manifest), searchEntry);
        expect(foundEntry).toBe(false);
      }
    });

    it("throws an error if the search value is longer than the current value", async ({
      expect,
    }) => {
      const { manifest } = await makeManifestOfLength(10);
      expect(() => {
        binarySearch(
          new Uint8Array(manifest),
          new Uint8Array(PATH_HASH_SIZE + 1).fill(127),
        );
      }).toThrowErrorMatchingInlineSnapshot(
        `[TypeError: Search value should have a length of ${PATH_HASH_SIZE}]`,
      );
    });
  });
});

/**
 * Compare two Uint8Array values
 * @param a First array
 * @param b Second array
 * @returns -1 if a < b, 1 if a > b, 0 if equal
 */
function compare(a: Uint8Array, b: Uint8Array) {
  if (a.byteLength < b.byteLength) {
    return -1;
  }
  if (a.byteLength > b.byteLength) {
    return 1;
  }

  for (const [i, v] of a.entries()) {
    const bVal = b[i] as number;
    if (v < bVal) {
      return -1;
    }
    if (v > bVal) {
      return 1;
    }
  }

  return 0;
}
