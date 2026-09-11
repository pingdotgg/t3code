import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => effect(),
    useState: reactHookHarness.useState,
  };
});

import {
  AcpRegistryAgentIcon,
  loadCachedAcpRegistryIcon,
  officialAcpRegistryIconUrlForAgentId,
  resolveOfficialAcpRegistryIconUrl,
} from "./AcpRegistryIcon";

describe("ACP Registry icon cache", () => {
  const stored = new Map<string, Response>();
  const match = vi.fn(async (url: string) => stored.get(url)?.clone());
  const put = vi.fn(async (url: string, response: Response) => {
    stored.set(url, response.clone());
  });
  const fetchIcon = vi.fn();

  beforeEach(() => {
    hooks.reset();
    stored.clear();
    match.mockClear();
    put.mockClear();
    fetchIcon.mockReset();
    vi.stubGlobal("caches", { open: vi.fn(async () => ({ match, put })) });
    vi.stubGlobal("fetch", fetchIcon);
  });

  it("single-flights the first fetch and serves later reads from persistent cache", async () => {
    const url = "https://cdn.agentclientprotocol.com/registry/icons/cache-test.svg";
    fetchIcon.mockResolvedValue(
      new Response("<svg/>", {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      }),
    );

    const [first, concurrent] = await Promise.all([
      loadCachedAcpRegistryIcon(url),
      loadCachedAcpRegistryIcon(url),
    ]);
    const cached = await loadCachedAcpRegistryIcon(url);

    expect(first.type).toBe("image/svg+xml");
    expect(concurrent.size).toBe(first.size);
    expect(cached.size).toBe(first.size);
    expect(fetchIcon).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledOnce();
  });

  it("rejects oversized image responses before caching", async () => {
    const url = "https://cdn.agentclientprotocol.com/registry/icons/oversized.svg";
    fetchIcon.mockResolvedValue(
      new Response("too large", {
        status: 200,
        headers: {
          "content-length": String(513 * 1_024),
          "content-type": "image/svg+xml",
        },
      }),
    );

    await expect(loadCachedAcpRegistryIcon(url)).rejects.toThrow("too large");
    expect(put).not.toHaveBeenCalled();
  });

  it("falls back to the network when CacheStorage cannot be opened", async () => {
    const url = "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg";
    vi.stubGlobal("caches", {
      open: vi.fn(async () => {
        throw new Error("CacheStorage unavailable");
      }),
    });
    fetchIcon.mockResolvedValue(
      new Response("<svg/>", {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      }),
    );

    await expect(loadCachedAcpRegistryIcon(url)).resolves.toMatchObject({
      type: "image/svg+xml",
    });
    expect(fetchIcon).toHaveBeenCalledWith(url, {
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  });

  it("accepts only credential-free HTTPS URLs on the official CDN", () => {
    expect(
      resolveOfficialAcpRegistryIconUrl(
        "https://cdn.agentclientprotocol.com/registry/icons/gemini.png",
      ),
    ).toBe("https://cdn.agentclientprotocol.com/registry/icons/gemini.png");
    expect(
      resolveOfficialAcpRegistryIconUrl("http://cdn.agentclientprotocol.com/icon.png"),
    ).toBeNull();
    expect(
      resolveOfficialAcpRegistryIconUrl("https://cdn.agentclientprotocol.com.evil/icon.png"),
    ).toBeNull();
    expect(
      resolveOfficialAcpRegistryIconUrl("https://user@cdn.agentclientprotocol.com/icon.png"),
    ).toBeNull();
    expect(
      resolveOfficialAcpRegistryIconUrl("https://cdn.agentclientprotocol.com:8443/icon.png"),
    ).toBeNull();
    expect(officialAcpRegistryIconUrlForAgentId("kilo")).toBe(
      "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg",
    );
    expect(officialAcpRegistryIconUrlForAgentId("../kilo")).toBeNull();
  });

  it("falls back to the raw allowlisted CDN URL when the validating fetch is blocked", async () => {
    const url = "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg";
    // The official CDN serves no CORS headers, so the fetch can reject even
    // though native <img> loading works.
    fetchIcon.mockRejectedValue(new TypeError("Failed to fetch"));
    hooks.beginRender();
    AcpRegistryAgentIcon({ icon: url });

    await new Promise((resolve) => setTimeout(resolve, 0));
    hooks.beginRender();
    const tree = AcpRegistryAgentIcon({ icon: url }) as ReactElement<Record<string, unknown>>;
    const image = visitElements(tree, (element) => element.type === "img");
    expect(image?.props).toMatchObject({ src: url, referrerPolicy: "no-referrer" });
    expect(
      visitElements(tree, (element) => element.props["data-slot"] === "acp-icon-fallback"),
    ).not.toBeNull();
  });

  it("renders only the validated blob object URL and keeps the fallback until load", async () => {
    const url = "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg";
    const objectUrl = "blob:t3/kilo-icon";
    Object.assign(URL, {
      createObjectURL: vi.fn(() => objectUrl),
      revokeObjectURL: vi.fn(),
    });
    fetchIcon.mockResolvedValue(
      new Response("<svg/>", {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      }),
    );
    hooks.beginRender();
    const validating = AcpRegistryAgentIcon({ icon: url }) as ReactElement<Record<string, unknown>>;

    // The raw CDN URL is never rendered; only the fallback shows while the
    // blob is fetched and validated.
    expect(visitElements(validating, (element) => element.type === "img")).toBeNull();
    expect(
      visitElements(validating, (element) => element.props["data-slot"] === "acp-icon-fallback"),
    ).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 0));
    hooks.beginRender();
    const loading = AcpRegistryAgentIcon({ icon: url }) as ReactElement<Record<string, unknown>>;
    const loadingImage = visitElements(loading, (element) => element.type === "img");

    expect(loadingImage?.props).toMatchObject({
      src: objectUrl,
      alt: "",
      decoding: "async",
      referrerPolicy: "no-referrer",
    });
    expect(loadingImage?.props.className).not.toContain("dark:invert");
    expect(loadingImage?.props.className).toContain("invisible");
    expect(
      visitElements(loading, (element) => element.props["data-slot"] === "acp-icon-fallback"),
    ).not.toBeNull();

    (loadingImage?.props.onLoad as (() => void) | undefined)?.();
    hooks.beginRender();
    const loaded = AcpRegistryAgentIcon({ icon: url }) as ReactElement<Record<string, unknown>>;
    expect(
      visitElements(loaded, (element) => element.type === "img")?.props.className,
    ).not.toContain("invisible");
    expect(
      visitElements(loaded, (element) => element.props["data-slot"] === "acp-icon-fallback"),
    ).toBeNull();

    const loadedImage = visitElements(loaded, (element) => element.type === "img");
    (loadedImage?.props.onError as (() => void) | undefined)?.();
    hooks.beginRender();
    const failed = AcpRegistryAgentIcon({ icon: url }) as ReactElement<Record<string, unknown>>;
    expect(visitElements(failed, (element) => element.type === "img")).toBeNull();
    expect(
      visitElements(failed, (element) => element.props["data-slot"] === "acp-icon-fallback"),
    ).not.toBeNull();
  });
});
