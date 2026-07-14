import { describe, expect, it } from "vite-plus/test";

import { deriveAuthClientMetadata } from "./utils.ts";

describe("deriveAuthClientMetadata", () => {
  it("derives native macOS transport metadata", () => {
    const metadata = deriveAuthClientMetadata({
      request: {
        headers: {
          "user-agent": "SergeCode/1 CFNetwork/1498.700.2 Darwin/23.6.0",
        },
        source: {
          remoteAddress: "::ffff:127.0.0.1",
        },
      } as never,
    });

    expect(metadata).toMatchObject({
      deviceType: "desktop",
      ipAddress: "127.0.0.1",
      os: "macOS",
    });
  });

  it("applies client-presented display identity without replacing transport metadata", () => {
    const metadata = deriveAuthClientMetadata({
      request: {
        headers: {
          "user-agent": "SergeCode/1 CFNetwork/1498.700.2 Darwin/23.6.0",
        },
        source: {
          remoteAddress: "::ffff:192.168.213.72",
        },
      } as never,
      presented: {
        label: "SergeCode Mobile",
        deviceType: "mobile",
        os: "iOS",
      },
    });

    expect(metadata).toMatchObject({
      label: "SergeCode Mobile",
      deviceType: "mobile",
      ipAddress: "192.168.213.72",
      os: "iOS",
    });
    expect(metadata.userAgent).toContain("SergeCode/1");
  });
});
