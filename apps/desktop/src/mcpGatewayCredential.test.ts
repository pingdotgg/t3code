import { assert, describe, it } from "@effect/vitest";

import { ensureMcpGatewayBridgeToken, readMcpGatewayBridgeToken } from "./mcpGatewayCredential.ts";

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

describe("ensureMcpGatewayBridgeToken", () => {
  const store = (files: Map<string, { contents: string; mode: number }>) => ({
    env: {},
    homeDirectory: "/home/tester",
    userId: 1000,
    statFile: (path: string) => {
      const file = files.get(path);
      if (file === undefined) throw new Error("ENOENT");
      return { ...secureFile, mode: file.mode };
    },
    readFileString: (path: string) => files.get(path)!.contents,
    makeDirectory: () => undefined,
    createFileExclusive: (path: string, contents: string) => {
      if (files.has(path)) throw new Error("EEXIST");
      files.set(path, { contents, mode: 0o100600 });
    },
    newToken: () => "generated-token-0123456789abcdef",
  });

  it("creates the protected env file once, so the token survives a restart", () => {
    const files = new Map<string, { contents: string; mode: number }>();
    assert.strictEqual(
      ensureMcpGatewayBridgeToken(store(files)),
      "generated-token-0123456789abcdef",
    );
    assert.deepStrictEqual([...files.keys()], ["/home/tester/.config/t3code/mcp-gateway.env"]);
    // A new app session reads the same token without generating another.
    assert.strictEqual(readMcpGatewayBridgeToken(store(files)), "generated-token-0123456789abcdef");
  });

  it("leaves an existing but unusable env file for its owner to fix", () => {
    const path = "/home/tester/.config/t3code/mcp-gateway.env";
    const files = new Map([
      [path, { contents: "T3_MCP_BRIDGE_TOKEN=shared-token-123456\n", mode: 0o100644 }],
    ]);
    assert.isNull(ensureMcpGatewayBridgeToken(store(files)));
    assert.strictEqual(files.get(path)?.contents, "T3_MCP_BRIDGE_TOKEN=shared-token-123456\n");
  });
});
