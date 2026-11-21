// @effect-diagnostics nodeBuiltinImport:off -- Fake Electron net request and response emitters.
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type DownloadOptions = Parameters<ElectronHttpExecutor["download"]>[2];
type FakeRequest = NodeEvents.EventEmitter & { abort: () => void };

// electron-updater is CommonJS, so a spy goes on the module object its require() returns.
const fsModule = NodeModule.createRequire(import.meta.url)("node:fs") as typeof NodeFS;
const openForReading = fsModule.createReadStream;
// electron-updater's own dependency, which apps/desktop does not declare.
const { CancellationToken, CancellationError } = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("electron-updater"),
)("builder-util-runtime") as {
  CancellationToken: new () => DownloadOptions["cancellationToken"];
  CancellationError: new () => Error;
};
const RELEASE = "hello world";
// Larger than a file stream's buffer, so its "drain" marks a write of it as committed to disk.
const PREFIX = "a".repeat(1 << 20);
const LARGE_RELEASE = `${PREFIX}world`;
const RESUMED_RANGE = `bytes ${PREFIX.length}-${LARGE_RELEASE.length - 1}/${LARGE_RELEASE.length}`;

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

// The temp update file already holds `onDisk`, as the differential downloader's output can.
function startDownload(onDisk: string, release = RELEASE) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "electron-http-executor-"));
  const destination = NodePath.join(dir, "update.AppImage");
  NodeFS.writeFileSync(destination, onDisk);
  const createWriteStream = vi.spyOn(fsModule, "createWriteStream");
  const createReadStream = vi.spyOn(fsModule, "createReadStream");
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
  const cancellationToken = new CancellationToken();
  const first = NodeEvents.EventEmitter.once(created, "request");
  const result = executor.download(new URL("https://example.com/update.AppImage"), destination, {
    cancellationToken,
    sha512: NodeCrypto.createHash("sha512").update(release).digest("base64"),
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
  // The first request answers 200 and writes `body` to the file, then stalls before the end.
  const stallAfterWriting = async (body: string) => {
    const [{ request }] = await first;
    const response = startResponse(request, 200, { "content-length": String(release.length) });
    const fileOut = createWriteStream.mock.results[0]!.value as NodeFS.WriteStream;
    const committed = NodeEvents.EventEmitter.once(fileOut, "drain");
    response.write(body);
    await committed;
    const closed = NodeEvents.EventEmitter.once(fileOut, "close");
    const retry = nextRequest();
    await vi.advanceTimersByTimeAsync(60_000);
    await closed;
    await vi.advanceTimersByTimeAsync(2_000);
    return retry;
  };
  return {
    destination,
    first,
    nextRequest,
    stallAfterWriting,
    result,
    cancel: () => cancellationToken.cancel(),
    // Resolves once the file is open for its digest check, before any of it is read.
    readOpened: () =>
      new Promise<void>((resolve) => {
        createReadStream.mockImplementationOnce((...args) => {
          const stream = openForReading(...args);
          stream.once("open", () => resolve());
          return stream;
        });
      }),
    requestCount: () => requestCount,
    read: () => NodeFS.readFileSync(destination, "utf8"),
    [Symbol.dispose]: () => {
      createWriteStream.mockRestore();
      createReadStream.mockRestore();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function startResponse(request: FakeRequest, statusCode: number, headers: Record<string, string>) {
  const response = Object.assign(new NodeStream.PassThrough(), {
    statusCode,
    statusMessage: "",
    headers,
  });
  request.emit("response", response);
  return response;
}

function respond(
  request: FakeRequest,
  statusCode: number,
  headers: Record<string, string>,
  body: string,
) {
  startResponse(request, statusCode, { "content-length": String(body.length), ...headers }).end(
    body,
  );
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

  it.each([
    {
      name: "resumes a stalled download from the bytes already written",
      written: PREFIX,
      retry: { status: 206, headers: { "content-range": RESUMED_RANGE }, body: "world" },
    },
    {
      name: "accepts a file that already holds every byte when the retry is past the end",
      written: LARGE_RELEASE,
      retry: {
        status: 416,
        headers: { "content-range": `bytes */${LARGE_RELEASE.length}` },
        body: "",
      },
    },
    {
      name: "starts over when the server ignores the range",
      written: PREFIX,
      retry: { status: 200, headers: {}, body: LARGE_RELEASE },
    },
  ])("$name", async ({ written, retry: { status, headers, body } }) => {
    using download = startDownload("", LARGE_RELEASE);

    const { request: unanswered, headers: first } = await download.stallAfterWriting(written);
    expect(first.Range).toBe(`bytes=${written.length}-`);
    // A retry that fails before any response still resumes after the bytes the first one wrote.
    const retry = download.nextRequest();
    unanswered.emit("error", new Error("net::ERR_TIMED_OUT"));
    await vi.advanceTimersByTimeAsync(4_000);
    const { request, headers: second } = await retry;
    expect(second.Range).toBe(`bytes=${written.length}-`);
    respond(request, status, headers, body);

    await expect(download.result).resolves.toBe(download.destination);
    expect(download.read()).toBe(LARGE_RELEASE);
  });

  it("fails a file past the end of the release when the caller cancels its digest check", async () => {
    using download = startDownload("", LARGE_RELEASE);

    const { request } = await download.stallAfterWriting(LARGE_RELEASE);
    const opened = download.readOpened();
    respond(request, 416, { "content-range": `bytes */${LARGE_RELEASE.length}` }, "");
    await opened;
    download.cancel();

    await expect(download.result).rejects.toBeInstanceOf(CancellationError);
  });

  it("fails a file past the end of the release whose bytes do not match it", async () => {
    using download = startDownload("", LARGE_RELEASE);

    const { request } = await download.stallAfterWriting(`b${LARGE_RELEASE.slice(1)}`);
    respond(request, 416, { "content-range": `bytes */${LARGE_RELEASE.length}` }, "");

    await expect(download.result).rejects.toMatchObject({ code: "ERR_CHECKSUM_MISMATCH" });
    expect(download.requestCount()).toBe(2);
  });

  it("fails a resumed download whose earlier bytes do not match the release", async () => {
    using download = startDownload("", LARGE_RELEASE);

    const { request } = await download.stallAfterWriting(`b${PREFIX.slice(1)}`);
    respond(request, 206, { "content-range": RESUMED_RANGE }, "world");

    await expect(download.result).rejects.toMatchObject({ code: "ERR_CHECKSUM_MISMATCH" });
  });

  it("gives up after three retries without resuming from a file it did not write", async () => {
    using download = startDownload("differential output");
    for (const backoff of [2_000, 4_000, 8_000]) {
      const retry = download.nextRequest();
      await vi.advanceTimersByTimeAsync(60_000 + backoff);
      expect((await retry).headers.Range).toBeUndefined();
    }
    const outcome = expect(download.result).rejects.toThrow("Request timed out");

    await vi.advanceTimersByTimeAsync(60_000);
    await outcome;
    expect(download.requestCount()).toBe(4);
  });

  it("does not retry a request that fails for another reason", async () => {
    using download = startDownload("");
    const [{ request }] = await download.first;
    const outcome = expect(download.result).rejects.toThrow("net::ERR_CONNECTION_REFUSED");

    request.emit("error", new Error("net::ERR_CONNECTION_REFUSED"));
    await outcome;
    expect(download.requestCount()).toBe(1);
  });
});
