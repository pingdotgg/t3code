import { beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const vscodeState = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
}));

type ConfigurationChangeListener = (event: {
  affectsConfiguration: (key: string) => boolean;
}) => void;

const executeCommand = vi.fn();
const getCommands = vi.fn();
const getExtension = vi.fn();
const getDiagnostics = vi.fn();
const configurationChangeListeners = new Set<ConfigurationChangeListener>();
const onDidChangeConfiguration = vi.fn((listener: ConfigurationChangeListener) => {
  configurationChangeListeners.add(listener);
  return {
    dispose: () => {
      configurationChangeListeners.delete(listener);
    },
  };
});
const uriFile = vi.fn((value: string) => ({
  scheme: "file",
  fsPath: value,
  authority: "",
  toString: () => `file://${value}`,
}));
const uriParse = vi.fn((value: string) => ({
  scheme: "file",
  fsPath: value.startsWith("file://") ? value.slice("file://".length) : "/tmp/parsed",
  authority: "",
  toString: () => value,
}));

class MockPosition {
  line: number;
  character: number;

  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }
}

class MockRange {
  start: MockPosition;
  end: MockPosition;

  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    this.start = new MockPosition(startLine, startCharacter);
    this.end = new MockPosition(endLine, endCharacter);
  }
}

vi.mock("vscode", () => ({
  commands: {
    executeCommand,
    getCommands,
  },
  extensions: {
    getExtension,
  },
  languages: {
    getDiagnostics,
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, defaultValue: unknown) =>
        Object.prototype.hasOwnProperty.call(vscodeState.settings, key)
          ? vscodeState.settings[key]
          : defaultValue,
    }),
    onDidChangeConfiguration,
    workspaceFolders: [
      {
        uri: {
          scheme: "file",
          authority: "",
          fsPath: "/workspace",
          toString: () => "file:///workspace",
        },
      },
    ],
  },
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
  },
  Uri: {
    file: uriFile,
    parse: uriParse,
  },
  Position: MockPosition,
  Range: MockRange,
  SymbolKind: {
    5: "Class",
    Class: 5,
  },
}));

function setT3CodeSetting(key: string, value: unknown): void {
  vscodeState.settings[key] = value;
  fireT3CodeConfigurationChanged(`t3code.${key}`);
}

function fireT3CodeConfigurationChanged(changedKey: string): void {
  const event = {
    affectsConfiguration: (key: string) => key === changedKey,
  };
  for (const listener of configurationChangeListeners) {
    listener(event);
  }
}

describe("executeVsCodeRunCommand", () => {
  beforeEach(() => {
    executeCommand.mockReset();
    getCommands.mockReset();
    getExtension.mockReset();
    getDiagnostics.mockReset();
    uriFile.mockClear();
    uriParse.mockClear();
    vscodeState.settings = {};
    fireT3CodeConfigurationChanged("t3code.mcp.allowedRunCommands");
  });

  it("runs a registered VS Code command and returns structured MCP content", async () => {
    const { executeVsCodeRunCommand } = await import("./mcpBridge.ts");
    getCommands.mockResolvedValue(["t3code.example.echo"]);
    executeCommand.mockResolvedValue({ value: "echo:hello" });

    const result = await executeVsCodeRunCommand({
      command: "t3code.example.echo",
      args: ["hello"],
    });

    expect(executeCommand).toHaveBeenCalledWith("t3code.example.echo", "hello");
    expect(result.structuredContent).toEqual({
      command: "t3code.example.echo",
      result: { value: "echo:hello" },
    });
    expect(result.content[0]?.text).toContain("echo:hello");
  });

  it("hydrates VS Code Uri arguments before executing the command", async () => {
    const { executeVsCodeRunCommand } = await import("./mcpBridge.ts");
    getCommands.mockResolvedValue(["vscode.open"]);
    executeCommand.mockResolvedValue(undefined);

    await executeVsCodeRunCommand({
      command: "vscode.open",
      args: [{ $vscode: "Uri", path: "/tmp/example.txt" }],
    });

    expect(uriFile).toHaveBeenCalledWith("/tmp/example.txt");
    expect(executeCommand).toHaveBeenCalledWith(
      "vscode.open",
      expect.objectContaining({ fsPath: "/tmp/example.txt" }),
    );
  });

  it("rejects internal VS Code commands", async () => {
    const { executeVsCodeRunCommand } = await import("./mcpBridge.ts");

    await expect(
      executeVsCodeRunCommand({
        command: "_workbench.internal.example",
        args: ["value"],
      }),
    ).rejects.toThrow("Internal VS Code commands are not supported by this tool.");
    expect(getCommands).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("rejects registered commands outside the MCP command allowlist", async () => {
    const { executeVsCodeRunCommand } = await import("./mcpBridge.ts");

    await expect(
      executeVsCodeRunCommand({
        command: "workbench.action.openSettingsJson",
      }),
    ).rejects.toThrow(
      "VS Code command is not allowed through MCP: workbench.action.openSettingsJson",
    );
    expect(getCommands).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("allows custom command ids from the VS Code setting", async () => {
    const { executeVsCodeRunCommand } = await import("./mcpBridge.ts");
    setT3CodeSetting("mcp.allowedRunCommands", ["workbench.action.files.save"]);
    getCommands.mockResolvedValue(["workbench.action.files.save"]);
    executeCommand.mockResolvedValue(undefined);

    const result = await executeVsCodeRunCommand({
      command: "workbench.action.files.save",
    });

    expect(executeCommand).toHaveBeenCalledWith("workbench.action.files.save");
    expect(result.structuredContent).toEqual({
      command: "workbench.action.files.save",
      result: null,
    });
  });

  it("allows custom command prefixes from the VS Code setting", async () => {
    const { executeVsCodeRunCommand } = await import("./mcpBridge.ts");
    setT3CodeSetting("mcp.allowedRunCommands", ["workbench.action.quickOpen*"]);
    getCommands.mockResolvedValue(["workbench.action.quickOpenNavigateNext"]);
    executeCommand.mockResolvedValue(undefined);

    await executeVsCodeRunCommand({
      command: "workbench.action.quickOpenNavigateNext",
    });

    expect(executeCommand).toHaveBeenCalledWith("workbench.action.quickOpenNavigateNext");
  });

  it("uses the custom command setting instead of adding it to the defaults", async () => {
    const { executeVsCodeRunCommand } = await import("./mcpBridge.ts");
    setT3CodeSetting("mcp.allowedRunCommands", ["workbench.action.files.save"]);

    await expect(
      executeVsCodeRunCommand({
        command: "vscode.open",
      }),
    ).rejects.toThrow("VS Code command is not allowed through MCP: vscode.open");
    expect(getCommands).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("does not treat a wildcard-only setting entry as allow all", async () => {
    const { executeVsCodeRunCommand } = await import("./mcpBridge.ts");
    setT3CodeSetting("mcp.allowedRunCommands", ["*"]);

    await expect(
      executeVsCodeRunCommand({
        command: "workbench.action.files.save",
      }),
    ).rejects.toThrow("VS Code command is not allowed through MCP: workbench.action.files.save");
    expect(getCommands).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("fails closed when the command allowlist setting has a malformed type", async () => {
    const { executeVsCodeRunCommand } = await import("./mcpBridge.ts");
    setT3CodeSetting("mcp.allowedRunCommands", "workbench.action.files.save");

    await expect(
      executeVsCodeRunCommand({
        command: "vscode.open",
      }),
    ).rejects.toThrow("VS Code command is not allowed through MCP: vscode.open");
    expect(getCommands).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("ignores invalid command allowlist entries and deduplicates valid patterns", async () => {
    const { executeVsCodeRunCommand } = await import("./mcpBridge.ts");
    setT3CodeSetting("mcp.allowedRunCommands", [
      "",
      "   ",
      "*",
      "workbench.*.invalid",
      "workbench.action.files.save",
      "workbench.action.files.save",
    ]);
    getCommands.mockResolvedValue(["workbench.action.files.save"]);
    executeCommand.mockResolvedValue(undefined);

    await executeVsCodeRunCommand({
      command: "workbench.action.files.save",
    });

    expect(executeCommand).toHaveBeenCalledWith("workbench.action.files.save");
  });

  it("refreshes cached command allowlist patterns after VS Code configuration changes", async () => {
    const { executeVsCodeRunCommand } = await import("./mcpBridge.ts");
    setT3CodeSetting("mcp.allowedRunCommands", ["workbench.action.files.save"]);
    getCommands.mockResolvedValue(["workbench.action.files.save", "workbench.action.files.saveAs"]);
    executeCommand.mockResolvedValue(undefined);

    await executeVsCodeRunCommand({
      command: "workbench.action.files.save",
    });

    setT3CodeSetting("mcp.allowedRunCommands", ["workbench.action.files.saveAs"]);

    await expect(
      executeVsCodeRunCommand({
        command: "workbench.action.files.save",
      }),
    ).rejects.toThrow("VS Code command is not allowed through MCP: workbench.action.files.save");
    await executeVsCodeRunCommand({
      command: "workbench.action.files.saveAs",
    });

    expect(executeCommand).toHaveBeenCalledWith("workbench.action.files.save");
    expect(executeCommand).toHaveBeenCalledWith("workbench.action.files.saveAs");
  });

  it("activates a requested extension that contributes the command before checking registered commands", async () => {
    const { executeVsCodeRunCommand } = await import("./mcpBridge.ts");
    const calls: string[] = [];
    const activate = vi.fn(async () => {
      calls.push("activate");
    });
    setT3CodeSetting("mcp.allowedActivateExtensions", ["publisher.example-extension"]);
    getExtension.mockReturnValue({
      activate,
      packageJSON: {},
    });
    getCommands.mockImplementation(async () => {
      calls.push("getCommands");
      return ["t3code.example.fromExtension"];
    });
    executeCommand.mockResolvedValue("done");

    await executeVsCodeRunCommand({
      command: "t3code.example.fromExtension",
      activateExtension: "publisher.example-extension",
    });

    expect(getExtension).toHaveBeenCalledWith("publisher.example-extension");
    expect(activate).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["activate", "getCommands"]);
    expect(executeCommand).toHaveBeenCalledWith("t3code.example.fromExtension");
  });

  it("rejects requested extensions outside the activation allowlist before lookup", async () => {
    const { executeVsCodeRunCommand } = await import("./mcpBridge.ts");

    await expect(
      executeVsCodeRunCommand({
        command: "t3code.example.fromExtension",
        activateExtension: "publisher.example-extension",
      }),
    ).rejects.toThrow(
      "VS Code extension activation is not allowed through MCP: publisher.example-extension",
    );
    expect(getExtension).not.toHaveBeenCalled();
    expect(getCommands).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("rejects missing requested extensions before checking registered commands", async () => {
    const { executeVsCodeRunCommand } = await import("./mcpBridge.ts");
    setT3CodeSetting("mcp.allowedActivateExtensions", ["publisher.missing-extension"]);
    getExtension.mockReturnValue(undefined);

    await expect(
      executeVsCodeRunCommand({
        command: "t3code.example.fromExtension",
        activateExtension: "publisher.missing-extension",
      }),
    ).rejects.toThrow("VS Code extension is not installed: publisher.missing-extension");
    expect(getCommands).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("rejects malformed requested extensions before checking registered commands", async () => {
    const { executeVsCodeRunCommand } = await import("./mcpBridge.ts");
    setT3CodeSetting("mcp.allowedActivateExtensions", ["publisher.example-extension"]);
    getExtension.mockReturnValue({
      packageJSON: {},
    });

    await expect(
      executeVsCodeRunCommand({
        command: "t3code.example.fromExtension",
        activateExtension: "publisher.example-extension",
      }),
    ).rejects.toThrow(
      "VS Code extension cannot be activated through MCP: publisher.example-extension",
    );
    expect(getCommands).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("reports requested extension activation failures before checking registered commands", async () => {
    const { executeVsCodeRunCommand } = await import("./mcpBridge.ts");
    const activate = vi.fn(async () => {
      throw new Error("activation failed");
    });
    setT3CodeSetting("mcp.allowedActivateExtensions", ["publisher.example-extension"]);
    getExtension.mockReturnValue({
      activate,
      packageJSON: {},
    });

    await expect(
      executeVsCodeRunCommand({
        command: "t3code.example.fromExtension",
        activateExtension: "publisher.example-extension",
      }),
    ).rejects.toThrow(
      "Failed to activate VS Code extension publisher.example-extension: activation failed",
    );
    expect(activate).toHaveBeenCalledTimes(1);
    expect(getCommands).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("does not activate extensions for disallowed commands", async () => {
    const { executeVsCodeRunCommand } = await import("./mcpBridge.ts");

    await expect(
      executeVsCodeRunCommand({
        command: "workbench.action.openSettingsJson",
        activateExtension: "publisher.example-extension",
      }),
    ).rejects.toThrow(
      "VS Code command is not allowed through MCP: workbench.action.openSettingsJson",
    );
    expect(getExtension).not.toHaveBeenCalled();
    expect(getCommands).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("rejects malformed activateExtension values", async () => {
    const { executeVsCodeRunCommand } = await import("./mcpBridge.ts");

    await expect(
      executeVsCodeRunCommand({
        command: "t3code.example.echo",
        activateExtension: " ",
      }),
    ).rejects.toThrow(
      "vscodeRunCommand.activateExtension must be a non-empty string when provided.",
    );
    expect(getExtension).not.toHaveBeenCalled();
    expect(getCommands).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });
});

describe("VS Code language-service MCP tools", () => {
  beforeEach(() => {
    executeCommand.mockReset();
    getCommands.mockReset();
    getExtension.mockReset();
    getDiagnostics.mockReset();
    uriFile.mockClear();
    uriParse.mockClear();
    vscodeState.settings = {};
    fireT3CodeConfigurationChanged("t3code.mcp.allowedRunCommands");
  });

  it("returns filtered diagnostics from VS Code", async () => {
    const { executeVsCodeDiagnostics } = await import("./mcpBridge.ts");
    const workspaceUri = {
      scheme: "file",
      authority: "",
      fsPath: "/workspace/src/app.ts",
      toString: () => "file:///workspace/src/app.ts",
    };
    const externalUri = {
      scheme: "file",
      authority: "",
      fsPath: "/tmp/outside.ts",
      toString: () => "file:///tmp/outside.ts",
    };
    getDiagnostics.mockReturnValue([
      [
        workspaceUri,
        [
          {
            range: new MockRange(1, 2, 1, 5),
            severity: 0,
            message: "Unexpected token",
            source: "ts",
            code: 1005,
          },
          {
            range: new MockRange(2, 0, 2, 4),
            severity: 3,
            message: "Style hint",
            source: "ts",
          },
        ],
      ],
      [
        externalUri,
        [
          {
            range: new MockRange(1, 0, 1, 1),
            severity: 0,
            message: "Outside workspace",
            source: "ts",
          },
        ],
      ],
    ]);

    const result = await executeVsCodeDiagnostics({
      minSeverity: "information",
      source: "ts",
      maxDiagnostics: 10,
    });

    expect(result.structuredContent).toMatchObject({
      returnedDiagnostics: 1,
      totalDiagnosticsAfterFiltering: 1,
      truncated: false,
      diagnostics: [
        {
          file: {
            path: "/workspace/src/app.ts",
          },
          severity: "error",
          message: "Unexpected token",
          source: "ts",
          code: 1005,
        },
      ],
    });
  });

  it("finds references through the VS Code reference provider", async () => {
    const { executeVsCodeReferences } = await import("./mcpBridge.ts");
    const referenceUri = {
      scheme: "file",
      authority: "",
      fsPath: "/workspace/src/usage.ts",
      toString: () => "file:///workspace/src/usage.ts",
    };
    executeCommand.mockResolvedValue([
      {
        uri: referenceUri,
        range: new MockRange(3, 4, 3, 10),
      },
    ]);

    const result = await executeVsCodeReferences({
      file: "src/app.ts",
      position: { line: 7, character: 12 },
      includeDeclaration: false,
    });

    expect(uriFile).toHaveBeenCalledWith("/workspace/src/app.ts");
    expect(executeCommand).toHaveBeenCalledWith(
      "vscode.executeReferenceProvider",
      expect.objectContaining({ fsPath: "/workspace/src/app.ts" }),
      expect.objectContaining({ line: 7, character: 12 }),
      { includeDeclaration: false },
    );
    expect(result.structuredContent).toMatchObject({
      returnedReferences: 1,
      totalReferences: 1,
      references: [
        {
          uri: { path: "/workspace/src/usage.ts" },
          range: {
            start: { line: 3, character: 4 },
            end: { line: 3, character: 10 },
          },
        },
      ],
    });
  });

  it("treats Windows absolute file paths as files instead of URI schemes", async () => {
    const { executeVsCodeReferences } = await import("./mcpBridge.ts");
    executeCommand.mockResolvedValue([]);

    await executeVsCodeReferences({
      file: "C:\\Users\\Luis\\project\\src\\app.ts",
      position: { line: 0, character: 0 },
    });

    expect(uriFile).toHaveBeenCalledWith("C:\\Users\\Luis\\project\\src\\app.ts");
    expect(uriParse).not.toHaveBeenCalledWith("C:\\Users\\Luis\\project\\src\\app.ts");
  });

  it("searches workspace symbols through VS Code", async () => {
    const { executeVsCodeWorkspaceSymbols } = await import("./mcpBridge.ts");
    const symbolUri = {
      scheme: "file",
      authority: "",
      fsPath: "/workspace/src/Foo.ts",
      toString: () => "file:///workspace/src/Foo.ts",
    };
    executeCommand.mockResolvedValue([
      {
        name: "Foo",
        kind: 5,
        containerName: "src",
        location: {
          uri: symbolUri,
          range: new MockRange(0, 13, 0, 16),
        },
      },
    ]);

    const result = await executeVsCodeWorkspaceSymbols({
      query: "Foo",
      maxSymbols: 5,
    });

    expect(executeCommand).toHaveBeenCalledWith("vscode.executeWorkspaceSymbolProvider", "Foo");
    expect(result.structuredContent).toMatchObject({
      returnedSymbols: 1,
      totalSymbols: 1,
      symbols: [
        {
          name: "Foo",
          kind: 5,
          kindName: "Class",
          containerName: "src",
        },
      ],
    });
  });

  it("does not serialize plain records with a scheme key as VS Code URIs", async () => {
    const { executeVsCodeRunCommand } = await import("./mcpBridge.ts");
    getCommands.mockResolvedValue(["t3code.example.echo"]);
    executeCommand.mockResolvedValue({
      scheme: "not-a-uri",
      value: "kept",
    });

    const result = await executeVsCodeRunCommand({
      command: "t3code.example.echo",
    });

    expect(result.structuredContent.result).toEqual({
      scheme: "not-a-uri",
      value: "kept",
    });
  });
});

describe("VsCodeMcpBridge", () => {
  it("uses a unique MCP server name per bridge instance", async () => {
    const { VsCodeMcpBridge } = await import("./mcpBridge.ts");
    const bridgeA = new VsCodeMcpBridge({ appendLine: vi.fn() } as never);
    const bridgeB = new VsCodeMcpBridge({ appendLine: vi.fn() } as never);
    try {
      const [serverA, serverB] = await Promise.all([
        bridgeA.ensureStarted(),
        bridgeB.ensureStarted(),
      ]);

      expect(serverA?.name).toMatch(/^t3code-vscode-\d+-[0-9a-f]+$/u);
      expect(serverB?.name).toMatch(/^t3code-vscode-\d+-[0-9a-f]+$/u);
      expect(serverA?.name).not.toBe(serverB?.name);
      expect(serverA?.socketPath).not.toBe(serverB?.socketPath);
    } finally {
      bridgeA.dispose();
      bridgeB.dispose();
    }
  });
});

describe("handleMcpRequest", () => {
  it("reports the MCP server name from the bridge context", async () => {
    const { handleMcpRequest } = await import("./mcpBridge.ts");

    await expect(
      handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
        },
        undefined,
        { serverName: "t3code-vscode-window-a" },
      ),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        serverInfo: {
          name: "t3code-vscode-window-a",
        },
      },
    });
  });

  it("lists the VS Code MCP tools", async () => {
    const { handleMcpRequest } = await import("./mcpBridge.ts");

    await expect(
      handleMcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          {
            name: "vscodeDiagnostics",
          },
          {
            name: "vscodeReferences",
          },
          {
            name: "vscodeWorkspaceSymbols",
          },
          {
            name: "vscodeRunCommand",
            inputSchema: {
              properties: {
                command: expect.objectContaining({
                  pattern: "\\S",
                }),
                activateExtension: expect.objectContaining({
                  pattern: "\\S",
                }),
              },
            },
          },
        ],
      },
    });
  });
});
