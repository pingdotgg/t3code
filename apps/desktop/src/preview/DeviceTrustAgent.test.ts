import { expect, it, vi } from "vite-plus/test";

const { fetchHelper } = vi.hoisted(() => ({ fetchHelper: vi.fn() }));
vi.mock("electron", () => ({
  session: { fromPartition: () => ({ setProxy: async () => undefined, fetch: fetchHelper }) },
}));

import { makeDeviceTrustAgent } from "./DeviceTrustAgent.ts";

it("consumes only a bridge URL issued for the exact authentication origin and method", async () => {
  fetchHelper.mockReset().mockResolvedValueOnce(new Response("agent response"));
  const auth = "https://auth.kolide.com";
  const url = "http://127.0.0.1:12519/v1/cmd?box=fixture";
  const route = makeDeviceTrustAgent(() => "fixture-token");
  const { redirectURL } = route.beforeRequest({
    initiatorOrigin: auth,
    method: "POST",
    resourceType: "xhr",
    url,
  } as Electron.OnBeforeRequestListenerDetails)!;
  const request = (target: string, initiatorOrigin: string, method = "POST") =>
    Object.assign(
      new Request(target, {
        method,
        ...(method === "POST" ? { body: "fixture" } : {}),
        headers: { Cookie: "preview-session", Authorization: "not-for-the-agent" },
      }),
      { initiatorOrigin },
    );

  expect((await route.handle(request(`${redirectURL}0`, auth))).type).toBe("error");
  expect((await route.handle(request(redirectURL!, "https://unrelated.test"))).type).toBe("error");
  expect((await route.handle(request(redirectURL!, auth, "GET"))).type).toBe("error");
  expect(fetchHelper).not.toHaveBeenCalled();

  expect(await (await route.handle(request(redirectURL!, auth))).text()).toBe("agent response");
  expect((await route.handle(request(redirectURL!, auth))).type).toBe("error");
  expect(fetchHelper).toHaveBeenCalledExactlyOnceWith(
    url,
    expect.objectContaining({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      headers: new Headers({ Origin: auth, "Content-Type": "text/plain;charset=UTF-8" }),
    }),
  );
});
