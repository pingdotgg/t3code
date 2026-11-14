import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
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
});
