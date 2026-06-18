import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { DesktopBootstrapMcpServer } from "./desktopBootstrap.ts";

const decodeDesktopBootstrapMcpServer = Schema.decodeUnknownSync(DesktopBootstrapMcpServer);

describe("DesktopBootstrapMcpServer", () => {
  it("accepts finite integer MCP tool timeouts at or above the documented minimum", () => {
    expect(
      decodeDesktopBootstrapMcpServer({
        name: "t3code-vscode",
        socketPath: "/tmp/t3code-vscode.sock",
        toolTimeoutSec: 5,
      }),
    ).toMatchObject({ toolTimeoutSec: 5 });
  });

  it.each([0, -1, 4, 5.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid MCP tool timeout %s",
    (toolTimeoutSec: number) => {
      expect(() =>
        decodeDesktopBootstrapMcpServer({
          name: "t3code-vscode",
          socketPath: "/tmp/t3code-vscode.sock",
          toolTimeoutSec,
        }),
      ).toThrow();
    },
  );
});
