import { expect, it, vi } from "vite-plus/test";

import { readMediaPng } from "./mediaContent";

it("copies a remote PNG through the environment when browser access is blocked", async () => {
  const png = new Blob(["image bytes"], { type: "image/png" });
  using fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce(new Response(png));
  const fallback = vi.fn(async () => "https://environment.test/api/assets/signed/image.png");

  expect(await readMediaPng("https://images.example.com/image.png", fallback)).toEqual(png);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://images.example.com/image.png",
    "https://environment.test/api/assets/signed/image.png",
  ]);
  expect(fallback).toHaveBeenCalledOnce();
});

it("keeps readable images on the direct path", async () => {
  const png = new Blob(["image bytes"], { type: "image/png" });
  using _fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(png));
  const fallback = vi.fn();

  expect(await readMediaPng("https://images.example.com/image.png", fallback)).toEqual(png);
  expect(fallback).not.toHaveBeenCalled();
});

it("does not turn an environment HTTP failure into a remote fetch", async () => {
  using _fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 403 }));
  const fallback = vi.fn();

  await expect(
    readMediaPng("https://environment.test/api/assets/image.png", fallback),
  ).rejects.toThrow("HTTP 403");
  expect(fallback).not.toHaveBeenCalled();
});
