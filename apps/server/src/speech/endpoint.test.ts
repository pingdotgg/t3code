// @effect-diagnostics-next-line nodeBuiltinImport:off - Exercises the real HTTP wire format, redirects, and cancellation against a local fixture.
import * as NodeHttp from "node:http";
import { expect, it, vi } from "vite-plus/test";
import { transcribeSpeechEndpoint } from "./endpoint.ts";

const endpoint = {
  url: "https://speech.example.test/v1/audio/transcriptions",
  model: "parakeet",
  apiKey: "",
};
const input = () => ({
  endpoint,
  pcm: new Float32Array([-1, -0.5, 0, 0.5, 1]),
  language: "auto",
  signal: new AbortController().signal,
});

async function serve(handler: NodeHttp.RequestListener) {
  const server = NodeHttp.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return {
    url: `http://127.0.0.1:${address.port}/v1/audio/transcriptions`,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

it("uploads mono PCM16 WAV and returns the endpoint transcript over HTTP", async () => {
  const received = Promise.withResolvers<{ headers: Headers; body: FormData }>();
  await using server = await serve((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      void new Response(Buffer.concat(chunks), { headers })
        .formData()
        .then((body) => received.resolve({ headers, body }), received.reject);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ text: "Bonjour le monde." }));
    });
  });
  const result = await transcribeSpeechEndpoint({
    ...input(),
    endpoint: { ...endpoint, url: server.url, apiKey: "test-key" },
    language: "fr",
  });
  expect(result).toBe("Bonjour le monde.");
  const { headers, body } = await received.promise;
  expect(headers.get("authorization")).toBe("Bearer test-key");
  expect(body.get("model")).toBe("parakeet");
  expect(body.get("language")).toBe("fr");
  expect(body.get("response_format")).toBe("json");
  const file = body.get("file") as File;
  expect(file.type).toBe("audio/wav");
  expect(file.name).toBe("recording.wav");
  const wav = await file.arrayBuffer();
  const view = new DataView(wav);
  expect(new TextDecoder().decode(new Uint8Array(wav, 0, 4))).toBe("RIFF");
  expect(new TextDecoder().decode(new Uint8Array(wav, 8, 8))).toBe("WAVEfmt ");
  expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
  expect(view.getUint16(20, true)).toBe(1);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(16_000);
  expect(view.getUint16(34, true)).toBe(16);
  expect(view.getUint32(40, true)).toBe(10);
  expect(Array.from({ length: 5 }, (_, index) => view.getInt16(44 + index * 2, true))).toEqual([
    -32768, -16384, 0, 16384, 32767,
  ]);
});

it("omits automatic language and absent credentials", async () => {
  using network = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ text: "" }));
  expect(await transcribeSpeechEndpoint(input())).toBe("");
  const request = network.mock.calls[0]![1]!;
  expect(new Headers(request.headers).has("authorization")).toBe(false);
  expect((request.body as FormData).has("language")).toBe(false);
});

it.each([
  { response: () => new Response("private error details", { status: 401 }), message: "HTTP 401" },
  {
    response: () => new Response("private malformed body"),
    message: "JSON object with a text field",
  },
  { response: () => Response.json({ text: 123 }), message: "JSON object with a text field" },
  {
    response: () => Response.json({ text: "x".repeat(100_001) }),
    message: "JSON object with a text field",
  },
  { response: () => new Response("x".repeat(1_048_577)), message: "response is too large" },
])("rejects unsafe or invalid responses: $message", async ({ response, message }) => {
  using _network = vi.spyOn(globalThis, "fetch").mockResolvedValue(response());
  await expect(transcribeSpeechEndpoint(input())).rejects.toThrow(message);
});

it("does not follow a redirect with audio or credentials", async () => {
  let requests = 0;
  await using server = await serve((_request, response) => {
    requests += 1;
    response.writeHead(307, { Location: "/another-destination" });
    response.end();
  });
  await expect(
    transcribeSpeechEndpoint({
      ...input(),
      endpoint: { ...endpoint, url: server.url, apiKey: "test-key" },
    }),
  ).rejects.toThrow();
  expect(requests).toBe(1);
});

it.each(["cancellation", "timeout"] as const)("aborts a stalled response on %s", async (reason) => {
  const started = Promise.withResolvers<void>();
  await using server = await serve((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"text":"');
    started.resolve();
  });
  const caller = new AbortController();
  const timeout = new AbortController();
  using _timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
  const pending = transcribeSpeechEndpoint({
    ...input(),
    signal: caller.signal,
    endpoint: { ...endpoint, url: server.url },
  });
  const rejected = expect(pending).rejects.toThrow();
  await started.promise;
  (reason === "timeout" ? timeout : caller).abort();
  await rejected;
});
