import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import {
  ASSET_READ_RETRY_DELAYS_MS,
  isAssetReadLimitError,
  readAssetWithRetry,
  sharedLoad,
} from "./assetLoader.ts";

const asset = (path) => ({ bytes: new Uint8Array([path.length]), mediaType: "x", sha256: path });
const limit = () => new Error("Installation asset read limit reached");
const neverAborted = new AbortController().signal;
const noWait = () => Promise.resolve();

NodeTest.describe("terminal asset loading (cold-load read cap)", () => {
  NodeTest.it("every mount shares one sequential set of reads", async () => {
    // Side panel + dock, each replayed by StrictMode: four mounts. The runtime
    // allows 4 concurrent reads per installation, so the mounts share one
    // sequential set of reads rather than each loading its own.
    let inFlight = 0;
    let peak = 0;
    const reads = [];
    const host = {
      async readAsset(path) {
        reads.push(path);
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight--;
        return asset(path);
      },
    };
    const load = sharedLoad(async (h) => {
      const read = h.readAsset.bind(h);
      const vt = await readAssetWithRetry(read, "vt.wasm", neverAborted, [], noWait);
      const pty = await readAssetWithRetry(read, "pty.wasm", neverAborted, [], noWait);
      const font = await readAssetWithRetry(read, "font.woff2", neverAborted, [], noWait);
      return [vt.sha256, pty.sha256, font.sha256];
    });
    const results = await Promise.all([load(host), load(host), load(host), load(host)]);
    NodeAssert.deepEqual(reads, ["vt.wasm", "pty.wasm", "font.woff2"]);
    NodeAssert.equal(peak, 1);
    for (const result of results)
      NodeAssert.deepEqual(result, ["vt.wasm", "pty.wasm", "font.woff2"]);
    // A later mount reuses the finished load without reading again.
    await load(host);
    NodeAssert.equal(reads.length, 3);
  });

  NodeTest.it("a failed shared load is forgotten so the next mount retries", async () => {
    let calls = 0;
    const load = sharedLoad(async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return "ok";
    });
    const key = {};
    await NodeAssert.rejects(Promise.all([load(key), load(key)]), /boom/);
    NodeAssert.equal(calls, 1);
    NodeAssert.equal(await load(key), "ok");
    NodeAssert.equal(calls, 2);
  });

  NodeTest.it("retries a read refused by the runtime cap, with backoff", async () => {
    const waits = [];
    let attempts = 0;
    const read = async (path) => {
      attempts++;
      if (attempts < 3) throw limit();
      return asset(path);
    };
    const result = await readAssetWithRetry(
      read,
      "vt.wasm",
      neverAborted,
      [10, 20, 40],
      async (ms) => {
        waits.push(ms);
      },
    );
    NodeAssert.equal(result.sha256, "vt.wasm");
    NodeAssert.deepEqual(waits, [10, 20]);
  });

  NodeTest.it("gives up after the last backoff and surfaces the cap error", async () => {
    let attempts = 0;
    const read = async () => {
      attempts++;
      throw limit();
    };
    await NodeAssert.rejects(
      readAssetWithRetry(read, "vt.wasm", neverAborted, [1, 1], noWait),
      /asset read limit reached/,
    );
    NodeAssert.equal(attempts, 3);
  });

  NodeTest.it("does not retry other failures or a cancelled read", async () => {
    let attempts = 0;
    const digest = async () => {
      attempts++;
      throw new Error("Installed asset digest mismatch");
    };
    await NodeAssert.rejects(
      readAssetWithRetry(digest, "vt.wasm", neverAborted, [1], noWait),
      /digest/,
    );
    NodeAssert.equal(attempts, 1);

    const aborted = AbortSignal.abort();
    attempts = 0;
    const capped = async () => {
      attempts++;
      throw limit();
    };
    await NodeAssert.rejects(readAssetWithRetry(capped, "vt.wasm", aborted, [1], noWait), /limit/);
    NodeAssert.equal(attempts, 1);
  });

  NodeTest.it("a cancel during the backoff issues no further read", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const capped = async () => {
      attempts++;
      throw limit();
    };
    await NodeAssert.rejects(
      readAssetWithRetry(capped, "vt.wasm", controller.signal, [1, 1], async () => {
        controller.abort();
      }),
      /limit/,
    );
    NodeAssert.equal(attempts, 1);
  });

  NodeTest.it("recognises both runtime caps and nothing else", () => {
    NodeAssert.equal(isAssetReadLimitError(limit()), true);
    NodeAssert.equal(isAssetReadLimitError(new Error("Asset read limit reached")), true);
    NodeAssert.equal(isAssetReadLimitError(new Error("Package asset is not declared")), false);
    NodeAssert.equal(isAssetReadLimitError("Asset read limit reached"), false);
    NodeAssert.ok(ASSET_READ_RETRY_DELAYS_MS.length > 0);
  });
});
