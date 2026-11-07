import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { webhookAddress } from "./webhookAddress.ts";

describe("webhookAddress", () => {
  it("keeps a LAN gateway peer prefix when joining the webhook path", () => {
    const peer = EnvironmentId.make("env_peer");
    const resolved = webhookAddress(
      {
        path: "/api/webhooks/task_1",
        url: null,
        hasSecret: false,
      },
      `https://gateway.example/__t3_gateway/${peer}/`,
    );
    expect(resolved).toEqual({
      address: `https://gateway.example/__t3_gateway/${peer}/api/webhooks/task_1`,
      copyable: true,
      note: "Works wherever this environment's address is reachable, for example over Tailscale or your own proxy. Link T3 Connect for a public URL.",
    });
  });
});
