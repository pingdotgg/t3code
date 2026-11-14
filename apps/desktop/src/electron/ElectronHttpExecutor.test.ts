// @effect-diagnostics nodeBuiltinImport:off -- Fake Electron net request and response emitters.
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type DownloadOptions = Parameters<ElectronHttpExecutor["download"]>[2];
type FakeRequest = NodeEvents.EventEmitter & { abort: () => void };

const RELEASE = "hello world";

function startRequest() {
  const request = Object.assign(new NodeEvents.EventEmitter(), { abort: vi.fn() });
  const response = new NodeEvents.EventEmitter();
  const reject = vi.fn();
  new ElectronHttpExecutor().addErrorAndTimeoutHandlers(request, reject);
  // Electron's net.ClientRequest emits these as soon as the request body is sent, before any response.
  request.emit("finish");
  request.emit("close");
  return { request, response, reject };
}

// The temp update file already holds `onDisk`, as if an earlier attempt had written it.
function startDownload(onDisk: string) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "electron-http-executor-"));
  const destination = NodePath.join(dir, "update.AppImage");
  NodeFS.writeFileSync(destination, onDisk);
  const created = new NodeEvents.EventEmitter();
  let requestCount = 0;
  const executor = new ElectronHttpExecutor();
  executor.createRequest = (options: { headers: Record<string, string> }, callback) => {
    const request = Object.assign(new NodeEvents.EventEmitter(), { abort: vi.fn(), end: vi.fn() });
    request.on("response", callback);
    requestCount++;
    created.emit("request", { request, headers: options.headers });
    return request as unknown as Electron.ClientRequest;
  };
  const cancellationToken = {
    cancelled: false,
    createPromise: (
      callback: (
        resolve: (value: unknown) => void,
        reject: (error: Error) => void,
        onCancel: () => void,
      ) => void,
    ) => new Promise((resolve, reject) => callback(resolve, reject, () => {})),
  } as unknown as DownloadOptions["cancellationToken"];
  const first = NodeEvents.EventEmitter.once(created, "request");
  const result = executor.download(new URL("https://example.com/update.AppImage"), destination, {
    cancellationToken,
    sha512: NodeCrypto.createHash("sha512").update(RELEASE).digest("base64"),
  });
  // A download that settles instead of sending another request fails the wait with its error.
  const settled = result.then(() => {
    throw new Error("The download finished without another request");
  });
  settled.catch(() => {});
  const nextRequest = async () => {
    const [request] = await Promise.race([
      NodeEvents.EventEmitter.once(created, "request"),
      settled,
    ]);
    return request as { request: FakeRequest; headers: Record<string, string> };
  };
  return {
    destination,
    first,
    nextRequest,
    result,
    requestCount: () => requestCount,
    read: () => NodeFS.readFileSync(destination, "utf8"),
    [Symbol.dispose]: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
}

function respond(
  request: FakeRequest,
  statusCode: number,
  headers: Record<string, string>,
  body: string,
) {
  const response = Object.assign(new NodeStream.PassThrough(), {
    statusCode,
    statusMessage: "",
    headers: { "content-length": String(body.length), ...headers },
  });
  request.emit("response", response);
  response.end(body);
}

describe("ElectronHttpExecutor idle timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts a request that receives no response for 60 seconds", () => {
    const { request, reject } = startRequest();

    vi.advanceTimersByTime(59_999);
    expect(reject).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(request.abort).toHaveBeenCalledOnce();
    expect(reject).toHaveBeenCalledWith(new Error("Request timed out"));
  });

  it("keeps a slow download alive while data keeps arriving", () => {
    const { request, response, reject } = startRequest();
    request.emit("response", response);

    for (let elapsed = 0; elapsed < 180_000; elapsed += 30_000) {
      vi.advanceTimersByTime(30_000);
      response.emit("data", Buffer.alloc(1));
    }

    expect(request.abort).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });

  it("stops the timer once the response ends", () => {
    const { request, response, reject } = startRequest();
    request.emit("response", response);

    response.emit("end");
    vi.advanceTimersByTime(600_000);

    expect(request.abort).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });

  it("resumes a stalled download from the bytes already written", async () => {
    using download = startDownload("hello ");
    const retry = download.nextRequest();

    await vi.advanceTimersByTimeAsync(60_000 + 2_000);
    const { request, headers } = await retry;
    expect(headers.Range).toBe("bytes=6-");
    respond(request, 206, { "content-range": "bytes 6-10/11" }, "world");

    await expect(download.result).resolves.toBe(download.destination);
    expect(download.read()).toBe(RELEASE);
  });

  it("starts over when the server ignores the range", async () => {
    using download = startDownload("HELLO ");
    const [{ request: first }] = await download.first;
    const retry = download.nextRequest();

    first.emit("error", new Error("net::ERR_TIMED_OUT"));
    await vi.advanceTimersByTimeAsync(2_000);
    const { request, headers } = await retry;
    expect(headers.Range).toBe("bytes=6-");
    respond(request, 200, {}, RELEASE);

    await expect(download.result).resolves.toBe(download.destination);
    expect(download.read()).toBe(RELEASE);
  });

  it("fails a resumed download whose earlier bytes do not match the release", async () => {
    using download = startDownload("HELLO ");
    const retry = download.nextRequest();

    await vi.advanceTimersByTimeAsync(60_000 + 2_000);
    const { request } = await retry;
    respond(request, 206, { "content-range": "bytes 6-10/11" }, "world");

    await expect(download.result).rejects.toMatchObject({ code: "ERR_CHECKSUM_MISMATCH" });
  });

  it("gives up after three retries", async () => {
    using download = startDownload("");
    for (const backoff of [2_000, 4_000, 8_000]) {
      const retry = download.nextRequest();
      await vi.advanceTimersByTimeAsync(60_000 + backoff);
      await retry;
    }
    const outcome = expect(download.result).rejects.toThrow("Request timed out");

    await vi.advanceTimersByTimeAsync(60_000);
    await outcome;
    expect(download.requestCount()).toBe(4);
  });

  it("does not retry a request that fails for another reason", async () => {
    using download = startDownload("hello ");
    const [{ request }] = await download.first;
    const outcome = expect(download.result).rejects.toThrow("net::ERR_CONNECTION_REFUSED");

    request.emit("error", new Error("net::ERR_CONNECTION_REFUSED"));
    await outcome;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(download.requestCount()).toBe(1);
  });
});
