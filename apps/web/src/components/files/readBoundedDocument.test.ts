import { expect, it, vi } from "vite-plus/test";
import { readBoundedDocument } from "./readBoundedDocument";

it.each([
  { name: "an error status", status: 503, headers: {} },
  { name: "a declared oversize body", status: 200, headers: { "content-length": "11" } },
])("releases the response body it rejects for $name", async ({ status, headers }) => {
  const cancel = vi.fn(() => {
    throw new Error("cancel failed");
  });
  const body = new ReadableStream<Uint8Array>({ cancel });
  using _fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(body, { status, headers }));

  await expect(readBoundedDocument("/file.pdf", new AbortController().signal, 10)).rejects.toThrow(
    "This file is unavailable or too large to preview.",
  );
  expect(cancel).toHaveBeenCalledOnce();
});
