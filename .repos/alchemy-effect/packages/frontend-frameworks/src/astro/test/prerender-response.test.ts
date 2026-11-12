import type { PrerenderRenderMetadata } from "astro";
import { describe, expect, it } from "vitest";
import { readFramedPrerenderResponse } from "../prerender-response.ts";
import {
  createFramedPrerenderResponse,
  PRERENDER_RESPONSE_CONTENT_TYPE,
} from "../runtime/utils/prerender-response.ts";

const metadata = {
  contentEntryKeys: ["posts/hello-world"],
  staticImages: [["/_astro/logo.png", { originalSrcPath: "/src/assets/logo.png" }]],
  referencedImages: ["/src/assets/logo.png"],
} as unknown as PrerenderRenderMetadata;

/** Re-chunk a framed body one byte at a time, so no read lines up with a frame boundary. */
const byteByByte = async (response: Response): Promise<Response> => {
  const bytes = new Uint8Array(await response.arrayBuffer());
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < bytes.byteLength) controller.enqueue(bytes.subarray(index, ++index));
        else controller.close();
      },
    }),
    { headers: response.headers },
  );
};

/** Frame raw metadata JSON by hand, to feed the reader payloads the writer never produces. */
const frame = (json: string, body = new Uint8Array()): Response => {
  const metadataBytes = new TextEncoder().encode(json);
  const bytes = new Uint8Array(4 + metadataBytes.byteLength + body.byteLength);
  new DataView(bytes.buffer).setUint32(0, metadataBytes.byteLength);
  bytes.set(metadataBytes, 4);
  bytes.set(body, 4 + metadataBytes.byteLength);
  return new Response(bytes, { headers: { "Content-Type": PRERENDER_RESPONSE_CONTENT_TYPE } });
};

describe("framed prerender response", () => {
  it("round-trips status, headers, body, and render metadata", async () => {
    const framed = createFramedPrerenderResponse(
      new Response("<h1>about</h1>", {
        status: 201,
        statusText: "Created",
        headers: { "content-type": "text/html", "x-custom": "yes" },
      }),
      metadata,
    );
    expect(framed.headers.get("Content-Type")).toBe(PRERENDER_RESPONSE_CONTENT_TYPE);

    const { response, metadata: decoded } = await readFramedPrerenderResponse(framed);
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(response.headers.get("x-custom")).toBe("yes");
    expect(await response.text()).toBe("<h1>about</h1>");
    expect(decoded).toEqual(metadata);
  });

  it("reassembles a frame split across arbitrary chunk boundaries", async () => {
    const body = new Uint8Array(1024).map((_, index) => index % 256);
    const framed = await byteByByte(createFramedPrerenderResponse(new Response(body), metadata));

    const { response, metadata: decoded } = await readFramedPrerenderResponse(framed);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    expect(decoded).toEqual(metadata);
  });

  it("carries a body-less response without metadata", async () => {
    const framed = createFramedPrerenderResponse(new Response(null, { status: 204 }), undefined);

    const { response, metadata: decoded } = await readFramedPrerenderResponse(framed);
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(decoded).toBeUndefined();
  });

  it("rejects a response that is not framed", async () => {
    await expect(readFramedPrerenderResponse(new Response("<h1>about</h1>"))).rejects.toThrow(
      "The prerender response is not framed.",
    );
  });

  it("rejects a failed transport response", async () => {
    await expect(
      readFramedPrerenderResponse(new Response("boom", { status: 500 })),
    ).rejects.toThrow("The framed prerender request failed (500");
  });

  it("rejects a frame that ends before its metadata", async () => {
    const truncated = new Uint8Array(await frame('{"status":200}').arrayBuffer()).subarray(0, 8);
    await expect(
      readFramedPrerenderResponse(
        new Response(truncated, { headers: { "Content-Type": PRERENDER_RESPONSE_CONTENT_TYPE } }),
      ),
    ).rejects.toThrow("The framed prerender response ended unexpectedly.");
  });

  it("rejects a zero metadata length", async () => {
    await expect(readFramedPrerenderResponse(frame(""))).rejects.toThrow(
      "The framed prerender response metadata length is invalid.",
    );
  });

  it("rejects metadata that is not JSON", async () => {
    await expect(readFramedPrerenderResponse(frame("not json"))).rejects.toThrow();
  });

  it("rejects an out-of-range status", async () => {
    await expect(
      readFramedPrerenderResponse(
        frame(JSON.stringify({ status: 700, statusText: "", headers: [], hasBody: false })),
      ),
    ).rejects.toThrow();
  });

  it("rejects malformed headers", async () => {
    await expect(
      readFramedPrerenderResponse(
        frame(JSON.stringify({ status: 200, statusText: "", headers: [["x"]], hasBody: false })),
      ),
    ).rejects.toThrow();
  });

  it("rejects a body on a null-body status", async () => {
    await expect(
      readFramedPrerenderResponse(
        frame(JSON.stringify({ status: 304, statusText: "", headers: [], hasBody: true })),
      ),
    ).rejects.toThrow("a null-body status cannot carry a body");
  });
});
