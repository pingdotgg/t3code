// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { afterEach, assert, beforeEach, describe, it, vi } from "vitest";
import { getAssetWithMetadataFromKV } from "../src/utils/kv.ts";
import type { AssetMetadata } from "../src/utils/kv.ts";
import type { MockInstance } from "vitest";

describe("[Asset Worker] Fetching assets from KV", () => {
  describe("getAssetWithMetadataFromKV()", () => {
    let mockKVNamespace: KVNamespace;
    let spy: MockInstance;

    beforeEach(() => {
      mockKVNamespace = {
        getWithMetadata: () => Promise.resolve(),
      } as unknown as KVNamespace;

      spy = vi.spyOn(mockKVNamespace, "getWithMetadata");
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should return the asset value and metadata, if asset was found in the KV store", async ({
      expect,
    }) => {
      spy.mockReturnValueOnce(
        Promise.resolve({
          value: "<html>Hello world</html>",
          metadata: {
            contentType: "text/html",
          },
        }) as unknown as Promise<
          KVNamespaceGetWithMetadataResult<ReadableStream, AssetMetadata>
        >,
      );

      const asset = await getAssetWithMetadataFromKV(mockKVNamespace, "abcd");
      assert(asset);
      expect(asset.value).toEqual("<html>Hello world</html>");
      expect(asset.metadata).toEqual({
        contentType: "text/html",
      });
      expect(spy).toHaveBeenCalledOnce();
    });

    it("should throw an error if something went wrong while fetching the asset", async ({
      expect,
    }) => {
      spy.mockReturnValue(Promise.reject("Oeps! Something went wrong"));

      await expect(() =>
        getAssetWithMetadataFromKV(mockKVNamespace, "abcd"),
      ).rejects.toThrow("KV GET abcd failed.");
    });

    it("should retry once by default if something went wrong while fetching the asset", async ({
      expect,
    }) => {
      spy.mockReturnValue(Promise.reject("Oeps! Something went wrong"));

      await expect(() =>
        getAssetWithMetadataFromKV(mockKVNamespace, "abcd"),
      ).rejects.toThrow("KV GET abcd failed.");
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("should support custom number of retries", async ({ expect }) => {
      spy.mockReturnValue(Promise.reject("Oeps! Something went wrong"));

      await expect(() =>
        getAssetWithMetadataFromKV(mockKVNamespace, "abcd", undefined, 2),
      ).rejects.toThrow("KV GET abcd failed.");
      expect(spy).toHaveBeenCalledTimes(3);
    });

    it("should inject message with error", async ({ expect }) => {
      spy.mockReturnValue(
        Promise.reject(new Error("Oeps! Something went wrong")),
      );

      await expect(() =>
        getAssetWithMetadataFromKV(mockKVNamespace, "abcd"),
      ).rejects.toThrow("KV GET abcd failed: Oeps! Something went wrong");
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("should retry on 404 and cache with shorter ttl", async ({ expect }) => {
      let attempts = 0;
      spy.mockImplementation(() => {
        if (attempts++ === 0) {
          return Promise.resolve({
            value: null,
          }) as unknown as Promise<
            KVNamespaceGetWithMetadataResult<ReadableStream, AssetMetadata>
          >;
        } else {
          return Promise.resolve({
            value: "<html>Hello world</html>",
            metadata: {
              contentType: "text/html",
            },
          }) as unknown as Promise<
            KVNamespaceGetWithMetadataResult<ReadableStream, AssetMetadata>
          >;
        }
      });

      const asset = await getAssetWithMetadataFromKV(mockKVNamespace, "abcd");
      expect(asset?.value).toBeTruthy();
      // Once for the initial call, once for the 404
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });
});
