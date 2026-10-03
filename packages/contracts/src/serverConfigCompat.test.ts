import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ServerConfigStreamEvent } from "./server.ts";
import { ServerSettings } from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerConfigEvent = Schema.decodeUnknownSync(ServerConfigStreamEvent);

/**
 * Cross-version forward compatibility for the connection-establishing snapshot.
 *
 * Failure modes this guards (observed in production, Oct 2026):
 * 1. A newer client adds a REQUIRED settings/config key without a decoding
 *    default. Older servers omit the key, so every snapshot decode defects on
 *    the client before the first value arrives. The client's session
 *    establishment maps "config subscription ended" to a *transient* error,
 *    and the connection supervisor redials forever on its backoff ceiling
 *    (~16s): hundreds of single-stream connections, each carrying exactly one
 *    `subscribeServerConfig` stream that ends `interrupt` while the socket
 *    closes `success`. Concrete instance: a `backgroundActivity` key required
 *    by newer clients but never sent by 0.0.23-line servers.
 * 2. A newer client rejects previously-unknown enum variants or excess keys
 *    in snapshot data, with the same looping outcome.
 *
 * Rule for future changes: every field added to ServerSettings/ServerConfig
 * must be optional or carry a decoding default, and every union that can grow
 * must tolerate unknown variants (see ForwardCompatible* helpers). The tests
 * below fail iff that rule is broken.
 */
describe("server config snapshot forward compatibility", () => {
  it("decodes an empty settings payload with defaults", () => {
    const decoded = decodeServerSettings({});

    expect(decoded).toBeDefined();
    expect(typeof decoded).toBe("object");
  });

  it("decodes settings that carry unknown future keys", () => {
    const decoded = decodeServerSettings({
      backgroundActivity: { schemaVersion: 1, profile: "balanced", overrides: {} },
      someFutureFlag: true,
    });

    expect(decoded).toBeDefined();
  });

  it("decodes a legacy snapshot that omits every newer optional field", () => {
    const legacySnapshot = {
      version: 1,
      type: "snapshot",
      config: {
        environment: {
          environmentId: "f32553bf-13d1-4b33-8543-4b071d8357d9",
          label: "legacy environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.23",
          capabilities: {},
        },
        auth: {
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3-session",
        },
        cwd: "/tmp/legacy",
        keybindingsConfigPath: "/tmp/legacy/keybindings.json",
        keybindings: [],
        issues: [],
        providers: [],
        availableEditors: [],
        observability: {
          logsDirectoryPath: "/tmp/legacy/logs",
          localTracingEnabled: true,
          otlpTracesEnabled: false,
          otlpMetricsEnabled: false,
        },
        settings: {},
      },
    };

    const decoded = decodeServerConfigEvent(legacySnapshot);

    expect(decoded.type).toBe("snapshot");
    if (decoded.type === "snapshot") {
      expect(decoded.config.environment.environmentId).toBe("f32553bf-13d1-4b33-8543-4b071d8357d9");
    }
  });
});
