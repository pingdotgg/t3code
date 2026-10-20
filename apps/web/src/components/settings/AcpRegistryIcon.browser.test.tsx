import { expect, it, vi } from "vite-plus/test";

import { render, stubGlobal, type Screen } from "../../../test/render";
import { AcpRegistryAgentIcon } from "./AcpRegistryIcon";

const url = "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg";

function setup() {
  const fetchIcon = vi.fn<typeof fetch>();
  const stack = new DisposableStack();
  stack.use(stubGlobal("caches", undefined));
  stack.use(stubGlobal("fetch", fetchIcon));
  return { fetchIcon, [Symbol.dispose]: () => stack.dispose() };
}

const image = (screen: Screen) => screen.container.querySelector("img");
const fallback = (screen: Screen) =>
  screen.container.querySelector('[data-slot="acp-icon-fallback"]');

it("falls back to the raw allowlisted CDN URL when the validating fetch is blocked", async () => {
  using env = setup();
  // The official CDN serves no CORS headers, so the fetch can reject even
  // though native <img> loading works.
  env.fetchIcon.mockRejectedValue(new TypeError("Failed to fetch"));
  await using screen = await render(<AcpRegistryAgentIcon icon={url} />);

  await vi.waitFor(() => expect(image(screen)?.getAttribute("src")).toBe(url));
  expect(image(screen)?.referrerPolicy).toBe("no-referrer");
  expect(fallback(screen)).not.toBeNull();
});

function serve(fetchIcon: ReturnType<typeof setup>["fetchIcon"], body: string) {
  fetchIcon.mockResolvedValue(
    new Response(body, { status: 200, headers: { "content-type": "image/svg+xml" } }),
  );
}

it("swaps the fallback for the validated blob once the image loads", async () => {
  using env = setup();
  serve(env.fetchIcon, '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>');
  await using screen = await render(<AcpRegistryAgentIcon icon={url} />);

  await vi.waitFor(() => expect(fallback(screen)).toBeNull());
  expect(image(screen)?.src).toMatch(/^blob:/);
  expect(image(screen)?.checkVisibility()).toBe(true);
});

it("keeps the fallback and drops the image when the validated blob fails to decode", async () => {
  using env = setup();
  serve(env.fetchIcon, "not an svg");
  await using screen = await render(<AcpRegistryAgentIcon icon={url} />);

  await vi.waitFor(() => expect(env.fetchIcon).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(image(screen)).toBeNull());
  expect(fallback(screen)).not.toBeNull();
});

it("never renders an icon from outside the official CDN", async () => {
  using env = setup();
  await using screen = await render(
    <AcpRegistryAgentIcon icon="https://cdn.agentclientprotocol.com.evil/icon.svg" />,
  );
  expect(env.fetchIcon).not.toHaveBeenCalled();
  expect(image(screen)).toBeNull();
  expect(fallback(screen)).not.toBeNull();
});
