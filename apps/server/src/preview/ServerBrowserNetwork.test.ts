import * as NodeEvents from "node:events";

import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vite-plus/test";

import { bodyOf, NetworkLog, redactHeaders } from "./ServerBrowserNetwork.ts";

const makePage = () => {
  const events = new NodeEvents.EventEmitter();
  return {
    page: { on: (name: string, listener: never) => events.on(name, listener) } as unknown as Page,
    emit: (name: string, value: unknown) => events.emit(name, value),
  };
};

const makeRequest = (
  url: string,
  options: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly postData?: string;
    readonly errorText?: string;
    readonly responseBodySize?: number | null;
  } = {},
) => ({
  url: () => url,
  method: () => options.method ?? "GET",
  resourceType: () => "fetch",
  headers: () => options.headers ?? {},
  postDataBuffer: () => (options.postData === undefined ? null : Buffer.from(options.postData)),
  failure: () => (options.errorText === undefined ? null : { errorText: options.errorText }),
  // Playwright gives a finished request its sizes; null stands for the call failing.
  sizes: async () => {
    if (options.responseBodySize === null) throw new Error("Unable to fetch sizes");
    return { responseBodySize: options.responseBodySize ?? 64 };
  },
});

const makeResponse = (
  request: ReturnType<typeof makeRequest>,
  status: number,
  headers: Record<string, string>,
  body: string | Buffer = "",
) => ({
  request: () => request,
  status: () => status,
  headers: () => headers,
  body: vi.fn(async () => (typeof body === "string" ? Buffer.from(body) : body)),
});

const setup = () => {
  let now = Date.parse("2026-10-30T12:00:00.000Z");
  const log = new NetworkLog(() => now);
  const { page, emit } = makePage();
  log.record(page);
  return {
    log,
    advance: (ms: number) => {
      now += ms;
    },
    start: (request: ReturnType<typeof makeRequest>) => emit("request", request),
    respond: (response: ReturnType<typeof makeResponse>) => emit("response", response),
    finish: (request: ReturnType<typeof makeRequest>) => emit("requestfinished", request),
    fail: (request: ReturnType<typeof makeRequest>) => emit("requestfailed", request),
  };
};

describe("NetworkLog", () => {
  it("lists the newest matching requests with their state, status and timing", async () => {
    const network = setup();
    const page = makeRequest("http://localhost:5173/");
    const api = makeRequest("http://localhost:5173/api/items", { method: "POST" });
    const refused = makeRequest("http://localhost:4000/api/health", {
      errorText: "net::ERR_CONNECTION_REFUSED",
    });
    const polling = makeRequest("http://localhost:5173/api/events");
    network.start(page);
    network.respond(makeResponse(page, 200, {}));
    network.advance(40);
    network.finish(page);
    network.start(api);
    network.advance(12);
    network.respond(makeResponse(api, 422, {}));
    network.advance(3);
    network.finish(api);
    network.start(refused);
    network.advance(5);
    network.fail(refused);
    network.start(polling);

    const listed = await network.log.query("tab-1", { urlIncludes: "/api/" });
    expect(listed).toEqual({
      tabId: "tab-1",
      matched: 3,
      requests: [
        expect.objectContaining({
          id: "r2",
          method: "POST",
          url: "http://localhost:5173/api/items",
          state: "finished",
          status: 422,
          startedAt: "2026-10-30T12:00:00.040Z",
          durationMs: 15,
        }),
        expect.objectContaining({
          id: "r3",
          state: "failed",
          status: null,
          errorText: "net::ERR_CONNECTION_REFUSED",
          durationMs: 5,
        }),
        expect.objectContaining({ id: "r4", state: "pending", status: null, durationMs: null }),
      ],
    });
    expect(listed.requests[0]).not.toHaveProperty("requestHeaders");

    const newest = await network.log.query("tab-1", { limit: 1 });
    expect(newest.matched).toBe(4);
    expect(newest.requests.map((request) => request.id)).toEqual(["r4"]);
  });

  it("returns one request's redacted headers and text bodies", async () => {
    const network = setup();
    const login = makeRequest("http://localhost:5173/api/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
        "x-session-id": "abc",
        accept: "application/json",
      },
      postData: '{"user":"ada"}',
    });
    network.start(login);
    network.respond(
      makeResponse(
        login,
        200,
        { "content-type": "application/json; charset=utf-8", "set-cookie": "sid=1" },
        '{"ok":true}',
      ),
    );
    network.finish(login);

    const { requests } = await network.log.query("tab-1", { requestId: "r1" });
    expect(requests).toEqual([
      expect.objectContaining({
        id: "r1",
        requestHeaders: {
          "content-type": "application/json",
          authorization: "[redacted]",
          "x-session-id": "[redacted]",
          accept: "application/json",
        },
        responseHeaders: {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": "[redacted]",
        },
        requestBody: { text: '{"user":"ada"}', sizeBytes: 14, truncated: false },
        responseBody: { text: '{"ok":true}', sizeBytes: 11, truncated: false },
      }),
    ]);
  });

  it("never reads binary, oversized, or unfinished response bodies", async () => {
    const network = setup();
    const image = makeRequest("http://localhost:5173/logo.png");
    const imageResponse = makeResponse(image, 200, {
      "content-type": "image/png",
      "content-length": "2048",
    });
    const dump = makeRequest("http://localhost:5173/dump.json");
    const dumpResponse = makeResponse(dump, 200, {
      "content-type": "application/json",
      "content-length": "80000000",
    });
    const stream = makeRequest("http://localhost:5173/api/stream");
    const streamResponse = makeResponse(stream, 200, { "content-type": "text/event-stream" });
    for (const [request, response] of [
      [image, imageResponse],
      [dump, dumpResponse],
      [stream, streamResponse],
    ] as const) {
      network.start(request);
      network.respond(response);
    }
    network.finish(image);
    network.finish(dump);

    const detail = async (requestId: string) =>
      (await network.log.query("tab-1", { requestId })).requests[0];
    expect((await detail("r1"))?.responseBody).toEqual({
      sizeBytes: 2048,
      truncated: false,
      omitted: "binary",
    });
    expect((await detail("r2"))?.responseBody).toEqual({
      sizeBytes: 80_000_000,
      truncated: true,
      omitted: "unavailable",
    });
    const pending = await detail("r3");
    expect(pending?.state).toBe("pending");
    expect(pending).not.toHaveProperty("responseBody");
    expect(imageResponse.body).not.toHaveBeenCalled();
    expect(dumpResponse.body).not.toHaveBeenCalled();
    expect(streamResponse.body).not.toHaveBeenCalled();
  });

  it("bounds a chunked body without a declared length by the bytes received", async () => {
    const network = setup();
    const export_ = makeRequest("http://localhost:5173/api/export", {
      responseBodySize: 6_000_000,
    });
    const exportResponse = makeResponse(export_, 200, { "content-type": "application/json" });
    const small = makeRequest("http://localhost:5173/api/small", { responseBodySize: 11 });
    const smallResponse = makeResponse(
      small,
      500,
      { "content-type": "application/json" },
      '{"ok":false}',
    );
    for (const [request, response] of [
      [export_, exportResponse],
      [small, smallResponse],
    ] as const) {
      network.start(request);
      network.respond(response);
      network.finish(request);
    }

    const detail = async (requestId: string) =>
      (await network.log.query("tab-1", { requestId })).requests[0]?.responseBody;
    expect(await detail("r1")).toEqual({
      sizeBytes: 6_000_000,
      truncated: true,
      omitted: "unavailable",
    });
    expect(exportResponse.body).not.toHaveBeenCalled();
    expect(await detail("r2")).toEqual({ text: '{"ok":false}', sizeBytes: 12, truncated: false });
  });

  it("bounds a body by the bytes received when they exceed its content-length", async () => {
    const network = setup();
    const request = makeRequest("http://localhost:5173/api/conflict", {
      responseBodySize: 6_000_000,
    });
    const response = makeResponse(request, 200, {
      "content-type": "application/json",
      "content-length": "10",
      "transfer-encoding": "chunked",
    });
    network.start(request);
    network.respond(response);
    network.finish(request);

    const { requests } = await network.log.query("tab-1", { requestId: "r1" });
    expect(requests[0]?.responseBody).toEqual({
      sizeBytes: 6_000_000,
      truncated: true,
      omitted: "unavailable",
    });
    expect(response.body).not.toHaveBeenCalled();
  });

  it("never reads a body Chromium received no bytes for, such as a cached or prefetched one", async () => {
    const network = setup();
    const request = makeRequest("http://localhost:5173/api/cached", { responseBodySize: 0 });
    const response = makeResponse(request, 200, {
      "content-type": "application/json",
      "content-length": "100",
    });
    network.start(request);
    network.respond(response);
    network.finish(request);

    const { requests } = await network.log.query("tab-1", { requestId: "r1" });
    expect(requests[0]?.responseBody).toEqual({
      sizeBytes: 100,
      truncated: true,
      omitted: "unavailable",
    });
    expect(response.body).not.toHaveBeenCalled();
  });

  it("never reads a compressed body, whose decoded size nothing bounds", async () => {
    const network = setup();
    const request = makeRequest("http://localhost:5173/api/report", { responseBodySize: 1_000 });
    const response = makeResponse(request, 200, {
      "content-type": "application/json",
      "content-encoding": "br",
    });
    network.start(request);
    network.respond(response);
    network.finish(request);

    const { requests } = await network.log.query("tab-1", { requestId: "r1" });
    expect(requests[0]?.responseBody).toEqual({
      sizeBytes: 1_000,
      truncated: true,
      omitted: "unavailable",
    });
    expect(response.body).not.toHaveBeenCalled();
  });

  it("reports a body Chromium no longer holds as unavailable", async () => {
    const network = setup();
    const request = makeRequest("http://localhost:5173/api/old");
    const response = makeResponse(request, 200, { "content-type": "application/json" });
    response.body.mockRejectedValueOnce(new Error("No resource with given identifier found"));
    network.start(request);
    network.respond(response);
    network.finish(request);

    const { requests } = await network.log.query("tab-1", { requestId: "r1" });
    expect(requests[0]?.responseBody).toEqual({
      sizeBytes: 64,
      truncated: false,
      omitted: "unavailable",
    });
  });

  it("never reads a body whose size neither the headers nor Chromium report", async () => {
    const network = setup();
    const request = makeRequest("http://localhost:5173/api/unknown", { responseBodySize: null });
    const response = makeResponse(request, 200, { "content-type": "application/json" }, "{}");
    network.start(request);
    network.respond(response);
    network.finish(request);

    const { requests } = await network.log.query("tab-1", { requestId: "r1" });
    expect(requests[0]?.responseBody).toEqual({ truncated: true, omitted: "unavailable" });
    expect(response.body).not.toHaveBeenCalled();
  });

  it("keeps the newest 200 requests and says when a listed id has aged out", async () => {
    const network = setup();
    for (let index = 0; index < 205; index++) {
      network.start(makeRequest(`http://localhost:5173/asset/${index}`));
    }

    const listed = await network.log.query("tab-1", { limit: 50 });
    expect(listed.matched).toBe(200);
    expect(listed.requests.at(-1)?.id).toBe("r205");
    await expect(network.log.query("tab-1", { requestId: "r5" })).rejects.toThrow(
      "Request r5 is no longer in this tab's log",
    );
    await expect(network.log.query("tab-1", { requestId: "r6" })).resolves.toMatchObject({
      requests: [{ id: "r6", url: "http://localhost:5173/asset/5" }],
    });
  });
});

describe("bodyOf", () => {
  it("cuts long text on a character boundary", () => {
    const body = bodyOf(Buffer.from(`${"a".repeat(15_999)}é tail`), "text/plain");
    expect(body.truncated).toBe(true);
    expect(body.sizeBytes).toBe(16_006);
    expect(body.text).toBe("a".repeat(15_999));
  });

  it("treats untyped bodies with NUL bytes as binary", () => {
    expect(bodyOf(Buffer.from([0x50, 0x4b, 0x00, 0x01]), undefined)).toEqual({
      sizeBytes: 4,
      truncated: false,
      omitted: "binary",
    });
    expect(bodyOf(Buffer.from("name=ada"), undefined).text).toBe("name=ada");
  });
});

describe("redactHeaders", () => {
  it("redacts credential-bearing headers whatever the site calls them", () => {
    expect(
      redactHeaders({
        Cookie: "a=1",
        "X-Api-Key": "k",
        "X-CSRF-Token": "t",
        "proxy-authorization": "Basic x",
        "cache-control": "no-store",
      }),
    ).toEqual({
      Cookie: "[redacted]",
      "X-Api-Key": "[redacted]",
      "X-CSRF-Token": "[redacted]",
      "proxy-authorization": "[redacted]",
      "cache-control": "no-store",
    });
  });
});
