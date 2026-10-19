import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { AcpRegistryAgentIcon } from "./AcpRegistryIcon";

const url = "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg";
const fetchIcon = vi.fn<typeof fetch>();
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("caches", undefined);
  vi.stubGlobal("fetch", fetchIcon);
  fetchIcon.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const image = () => container.querySelector("img");
const fallback = () => container.querySelector('[data-slot="acp-icon-fallback"]');

it("falls back to the raw allowlisted CDN URL when the validating fetch is blocked", async () => {
  // The official CDN serves no CORS headers, so the fetch can reject even
  // though native <img> loading works.
  fetchIcon.mockRejectedValue(new TypeError("Failed to fetch"));
  await act(async () => root.render(<AcpRegistryAgentIcon icon={url} />));

  await vi.waitFor(() => expect(image()?.getAttribute("src")).toBe(url));
  expect(image()?.referrerPolicy).toBe("no-referrer");
  expect(fallback()).not.toBeNull();
});

function serve(body: string) {
  fetchIcon.mockResolvedValue(
    new Response(body, { status: 200, headers: { "content-type": "image/svg+xml" } }),
  );
}

it("swaps the fallback for the validated blob once the image loads", async () => {
  serve('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>');
  await act(async () => root.render(<AcpRegistryAgentIcon icon={url} />));

  await vi.waitFor(() => expect(fallback()).toBeNull());
  expect(image()?.src).toMatch(/^blob:/);
  expect(image()?.checkVisibility()).toBe(true);
});

it("keeps the fallback and drops the image when the validated blob fails to decode", async () => {
  serve("not an svg");
  await act(async () => root.render(<AcpRegistryAgentIcon icon={url} />));

  await vi.waitFor(() => expect(fetchIcon).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(image()).toBeNull());
  expect(fallback()).not.toBeNull();
});

it("never renders an icon from outside the official CDN", async () => {
  await act(async () =>
    root.render(<AcpRegistryAgentIcon icon="https://cdn.agentclientprotocol.com.evil/icon.svg" />),
  );
  expect(fetchIcon).not.toHaveBeenCalled();
  expect(image()).toBeNull();
  expect(fallback()).not.toBeNull();
});
