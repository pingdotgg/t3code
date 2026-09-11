import { assert, describe, it } from "@effect/vitest";

import { readMcpGatewayBridgeToken } from "./mcpGatewayCredential.ts";

const secureFile = {
  isFile: () => true,
  mode: 0o100600,
  uid: 1000,
};

describe("readMcpGatewayBridgeToken", () => {
  it("uses the exact process environment credential without reading arbitrary variables", () => {
    let read = false;
    const token = readMcpGatewayBridgeToken({
      env: {
        T3_MCP_BRIDGE_TOKEN: "environment-token-123456",
        OTHER_TOKEN: "must-not-be-used",
      },
      homeDirectory: "/home/tester",
      userId: 1000,
      statFile: () => secureFile,
      readFileString: () => {
        read = true;
        return "T3_MCP_BRIDGE_TOKEN=file-token-123456\n";
      },
    });

    assert.strictEqual(token, "environment-token-123456");
    assert.isFalse(read);
  });

  it("reads the credential from the protected desktop gateway environment file", () => {
    let path = "";
    const token = readMcpGatewayBridgeToken({
      env: {},
      homeDirectory: "/home/tester",
      userId: 1000,
      statFile: (candidate) => {
        path = candidate;
        return secureFile;
      },
      readFileString: () =>
        ["IGNORED=value", "T3_MCP_BRIDGE_TOKEN='file-token-123456'", ""].join("\n"),
    });

    assert.strictEqual(path, "/home/tester/.config/t3code/mcp-gateway.env");
    assert.strictEqual(token, "file-token-123456");
  });

  it("refuses credentials from files accessible to another user", () => {
    for (const file of [
      { ...secureFile, mode: 0o100640 },
      { ...secureFile, uid: 1001 },
      { ...secureFile, isFile: () => false },
    ]) {
      assert.isNull(
        readMcpGatewayBridgeToken({
          env: {},
          homeDirectory: "/home/tester",
          userId: 1000,
          statFile: () => file,
          readFileString: () => "T3_MCP_BRIDGE_TOKEN=file-token-123456\n",
        }),
      );
    }
  });

  it("fails closed for missing, malformed, or short credentials", () => {
    for (const contents of [
      "OTHER=value\n",
      "T3_MCP_BRIDGE_TOKEN=short\n",
      "T3_MCP_BRIDGE_TOKEN=contains whitespace\n",
      "T3_MCP_BRIDGE_TOKEN='unterminated\n",
    ]) {
      assert.isNull(
        readMcpGatewayBridgeToken({
          env: {},
          homeDirectory: "/home/tester",
          userId: 1000,
          statFile: () => secureFile,
          readFileString: () => contents,
        }),
      );
    }
  });
});

it("accepts Windows synthetic modes without weakening POSIX checks", () => {
  assert.strictEqual(
    readMcpGatewayBridgeToken({
      env: {},
      homeDirectory: "C:/Users/tester",
      userId: null,
      statFile: () => ({ ...secureFile, mode: 0o100666 }),
      readFileString: () => "T3_MCP_BRIDGE_TOKEN=windows-token-123456\n",
    }),
    "windows-token-123456",
  );
});
