import type { DiscoveredLocalServer } from "@t3tools/contracts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  resolveDiscoveredServerOpenUrl,
  type ProbeDiscoveredServerTlsMutation,
} from "./resolveDiscoveredServerOpenUrl";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

const server = (url: string): DiscoveredLocalServer => ({
  host: "localhost",
  port: 3000,
  url,
  processName: "node",
  pid: 1234,
  terminal: null,
});

describe("resolveDiscoveredServerOpenUrl", () => {
  it("upgrades http:// to https:// when the listener speaks TLS", async () => {
    const probeTls = vi.fn<ProbeDiscoveredServerTlsMutation>(async () =>
      AsyncResult.success({ tls: true }),
    );
    expect(
      await resolveDiscoveredServerOpenUrl({
        threadRef,
        port: server("http://localhost:3000"),
        probeTls,
      }),
    ).toBe("https://localhost:3000/");
    expect(probeTls).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: { host: "localhost", port: 3000 },
    });
  });

  it("keeps the listener port when it is the HTTP default (80)", async () => {
    const probeTls = vi.fn<ProbeDiscoveredServerTlsMutation>(async () =>
      AsyncResult.success({ tls: true }),
    );
    expect(
      await resolveDiscoveredServerOpenUrl({
        threadRef,
        port: { ...server("http://localhost:80"), port: 80 },
        probeTls,
      }),
    ).toBe("https://localhost:80/");
    expect(probeTls).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: { host: "localhost", port: 80 },
    });
    // No explicit port in the URL still means port 80 for the probed listener.
    expect(
      await resolveDiscoveredServerOpenUrl({
        threadRef,
        port: { ...server("http://localhost"), port: 80 },
        probeTls,
      }),
    ).toBe("https://localhost:80/");
  });

  it("probes the URL's hostname and effective port, not the discovered host", async () => {
    // A configured URL can name a different loopback address than the discovered record
    // (127.0.0.1 vs localhost), and those can reach different listeners: a localhost
    // listener serving TLS must not upgrade the working IPv4 URL to HTTPS.
    const probeTls = vi.fn<ProbeDiscoveredServerTlsMutation>(async (args) =>
      AsyncResult.success({ tls: args.input.host === "localhost" }),
    );
    expect(
      await resolveDiscoveredServerOpenUrl({
        threadRef,
        port: { ...server("http://127.0.0.1:3000/app"), host: "localhost" },
        probeTls,
      }),
    ).toBe("http://127.0.0.1:3000/app");
    expect(probeTls).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: { host: "127.0.0.1", port: 3000 },
    });
    // A bare URL still probes the effective port 80.
    expect(
      await resolveDiscoveredServerOpenUrl({
        threadRef,
        port: { ...server("http://127.0.0.1"), host: "localhost", port: 80 },
        probeTls,
      }),
    ).toBe("http://127.0.0.1");
    expect(probeTls).toHaveBeenLastCalledWith({
      environmentId: threadRef.environmentId,
      input: { host: "127.0.0.1", port: 80 },
    });
  });

  it("keeps http:// when the probe fails or throws", async () => {
    const failing = vi.fn<ProbeDiscoveredServerTlsMutation>(async () =>
      AsyncResult.failure(Cause.fail(new Error("boom"))),
    );
    expect(
      await resolveDiscoveredServerOpenUrl({
        threadRef,
        port: server("http://localhost:3000"),
        probeTls: failing,
      }),
    ).toBe("http://localhost:3000");
    const throwing = vi.fn<ProbeDiscoveredServerTlsMutation>(async () => {
      throw new Error("boom");
    });
    expect(
      await resolveDiscoveredServerOpenUrl({
        threadRef,
        port: server("http://localhost:3000"),
        probeTls: throwing,
      }),
    ).toBe("http://localhost:3000");
  });

  it("does not probe https:// or non-loopback URLs", async () => {
    const probeTls = vi.fn<ProbeDiscoveredServerTlsMutation>(async () =>
      AsyncResult.success({ tls: true }),
    );
    expect(
      await resolveDiscoveredServerOpenUrl({
        threadRef,
        port: server("https://localhost:3000"),
        probeTls,
      }),
    ).toBe("https://localhost:3000");
    expect(
      await resolveDiscoveredServerOpenUrl({
        threadRef,
        port: { ...server("http://192.168.1.25:3000"), host: "192.168.1.25" },
        probeTls,
      }),
    ).toBe("http://192.168.1.25:3000");
    expect(probeTls).not.toHaveBeenCalled();
  });
});
