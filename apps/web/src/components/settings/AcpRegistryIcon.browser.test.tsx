import { expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";
import { AcpRegistryAgentIcon } from "./AcpRegistryIcon";

it.each([
  { name: "custom fetch failure", official: false, outcome: "network", direct: false },
  { name: "custom oversized image", official: false, outcome: "oversized", direct: false },
  { name: "custom non-image response", official: false, outcome: "non-image", direct: false },
  { name: "official oversized image", official: true, outcome: "oversized", direct: false },
  { name: "official CORS failure", official: true, outcome: "network", direct: true },
  { name: "valid custom image", official: false, outcome: "success", direct: false },
] as const)("keeps icon loading restrictions for $name", async (scenario) => {
  const host = scenario.official ? "cdn.agentclientprotocol.com" : "icons.example";
  const icon = `https://${host}/${scenario.name.replaceAll(" ", "-")}.svg`;
  using _cache = stubGlobal("caches", {
    open: async () => ({ match: async () => undefined, put: async () => undefined }),
  });
  let resolveResponse!: (response: Response) => void;
  let rejectResponse!: (error: TypeError) => void;
  const response = new Promise<Response>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  using fetchIcon = vi.spyOn(globalThis, "fetch").mockReturnValue(response);
  const setAttribute = HTMLImageElement.prototype.setAttribute;
  using imageSource = vi
    .spyOn(HTMLImageElement.prototype, "setAttribute")
    .mockImplementation(function (this: HTMLImageElement, name, value) {
      // Observe direct fallback attempts without making real requests to fixture hosts.
      if (name === "src" && value === icon) return;
      return setAttribute.call(this, name, value);
    });
  await using _screen = await render(<AcpRegistryAgentIcon icon={icon} />);
  await vi.waitFor(() => expect(fetchIcon).toHaveBeenCalledOnce());

  await act(async () => {
    if (scenario.outcome === "network") {
      rejectResponse(new TypeError("Fetch was blocked"));
    } else {
      resolveResponse(
        new Response('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>', {
          headers: {
            "content-type": scenario.outcome === "non-image" ? "text/plain" : "image/svg+xml",
            ...(scenario.outcome === "oversized" ? { "content-length": String(513 * 1024) } : {}),
          },
        }),
      );
    }
  });

  if (scenario.direct) {
    expect(imageSource).toHaveBeenCalledWith("src", icon);
  } else {
    expect(imageSource).not.toHaveBeenCalledWith("src", icon);
  }
  if (scenario.outcome === "success") {
    await vi.waitFor(() =>
      expect(imageSource).toHaveBeenCalledWith("src", expect.stringMatching(/^blob:/)),
    );
  }
});
