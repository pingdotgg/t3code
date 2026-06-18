import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const MCP_SETTING = "mcp.enabled";
const MCP_RUN_COMMAND_ALLOWLIST_SETTING = "mcp.allowedRunCommands";
const MCP_ACTIVATE_EXTENSION_ALLOWLIST_SETTING = "mcp.allowedActivateExtensions";
const MCP_SERVER_NAME_PREFIX = "t3code-vscode";
const DEFAULT_MCP_SERVER_NAME = MCP_SERVER_NAME_PREFIX;
const MCP_PROTOCOL_VERSION = "2024-11-05";
const MAX_SERIALIZED_DEPTH = 5;
const MAX_SERIALIZED_ARRAY_ITEMS = 100;
const MAX_SERIALIZED_OBJECT_KEYS = 100;
const DEFAULT_DIAGNOSTICS_LIMIT = 50;
const MAX_DIAGNOSTICS_LIMIT = 1_000;
const DEFAULT_REFERENCES_LIMIT = 100;
const MAX_REFERENCES_LIMIT = 1_000;
const DEFAULT_WORKSPACE_SYMBOLS_LIMIT = 100;
const MAX_WORKSPACE_SYMBOLS_LIMIT = 500;
const MAX_MCP_RECEIVE_BUFFER_BYTES = 10 * 1024 * 1024;
const DEFAULT_ALLOWED_RUN_COMMAND_PATTERNS = [
  "t3code.*",
  "vscode.open",
  "vscode.diff",
  "revealLine",
] as const;
const DEFAULT_ALLOWED_ACTIVATE_EXTENSION_IDS: readonly string[] = [];

export interface VscodeMcpServerBootstrap {
  readonly name: string;
  readonly socketPath: string;
}

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  readonly jsonrpc?: "2.0";
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: unknown;
}

type JsonRpcResponse =
  | {
      readonly jsonrpc: "2.0";
      readonly id: JsonRpcId;
      readonly result: unknown;
    }
  | {
      readonly jsonrpc: "2.0";
      readonly id: JsonRpcId;
      readonly error: {
        readonly code: number;
        readonly message: string;
        readonly data?: unknown;
      };
    };

type TransportFraming = "headers" | "newline";

export class VsCodeMcpBridge implements vscode.Disposable {
  readonly #outputChannel: vscode.OutputChannel;
  readonly #serverName: string;
  #server: net.Server | null = null;
  #socketPath: string | null = null;
  #socketDir: string | null = null;
  #starting: Promise<VscodeMcpServerBootstrap | null> | null = null;
  readonly #sockets = new Set<net.Socket>();

  constructor(outputChannel: vscode.OutputChannel, serverName = createMcpServerName()) {
    this.#outputChannel = outputChannel;
    this.#serverName = serverName;
  }

  async ensureStarted(): Promise<VscodeMcpServerBootstrap | null> {
    if (!isMcpEnabled()) {
      this.dispose();
      return null;
    }
    if (this.#server && this.#socketPath) {
      return { name: this.#serverName, socketPath: this.#socketPath };
    }
    if (this.#starting) {
      return await this.#starting;
    }

    this.#starting = this.#start();
    try {
      return await this.#starting;
    } finally {
      this.#starting = null;
    }
  }

  dispose(): void {
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    this.#sockets.clear();
    this.#server?.close();
    this.#server = null;
    this.#socketPath = null;
    const socketDir = this.#socketDir;
    this.#socketDir = null;
    if (socketDir) {
      // VS Code disposables are synchronous; the endpoint path is unique per bridge, so cleanup can complete asynchronously.
      void this.#removeSocketDir(socketDir);
    }
  }

  async #removeSocketDir(socketDir: string): Promise<void> {
    try {
      await fs.rm(socketDir, { recursive: true, force: true });
    } catch (error) {
      this.#outputChannel.appendLine(
        `[mcp] Failed to remove MCP socket directory ${socketDir}: ${errorMessage(error)}`,
      );
    }
  }

  async #start(): Promise<VscodeMcpServerBootstrap> {
    const endpoint = await createMcpEndpoint();
    const server = net.createServer((socket) => this.#handleConnection(socket));

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(endpoint.socketPath);
    });

    this.#server = server;
    this.#socketPath = endpoint.socketPath;
    this.#socketDir = endpoint.socketDir;
    this.#outputChannel.appendLine(`[mcp] Started ${this.#serverName} bridge.`);
    return { name: this.#serverName, socketPath: endpoint.socketPath };
  }

  #handleConnection(socket: net.Socket): void {
    this.#sockets.add(socket);
    socket.once("close", () => {
      this.#sockets.delete(socket);
    });
    socket.on("error", (error) => {
      this.#outputChannel.appendLine(`[mcp] Socket error: ${error.message}`);
    });

    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let framing: TransportFraming | null = null;
    let writeChain: Promise<void> = Promise.resolve();
    const enqueueResponse = (response: JsonRpcResponse, responseFraming: TransportFraming) => {
      writeChain = writeChain
        .catch(() => undefined)
        .then(() => writeSocketMessage(socket, encodeMessage(response, responseFraming)));
      void writeChain.catch((error: unknown) => {
        this.#outputChannel.appendLine(
          `[mcp] Failed to write MCP response: ${errorMessage(error)}`,
        );
        socket.destroy();
      });
    };
    socket.on("data", (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_MCP_RECEIVE_BUFFER_BYTES) {
          throw new Error(
            `MCP receive buffer exceeded ${MAX_MCP_RECEIVE_BUFFER_BYTES} bytes without a complete message.`,
          );
        }
        while (true) {
          const parsed = readNextMessage(buffer, framing);
          if (!parsed) {
            break;
          }
          buffer = parsed.remaining;
          framing = parsed.framing;
          void this.#handleMessage(parsed.framing, parsed.message, enqueueResponse);
        }
      } catch (error) {
        this.#outputChannel.appendLine(`[mcp] Failed to parse MCP message: ${errorMessage(error)}`);
        socket.destroy();
      }
    });
  }

  async #handleMessage(
    framing: TransportFraming,
    request: JsonRpcRequest,
    enqueueResponse: (response: JsonRpcResponse, responseFraming: TransportFraming) => void,
  ): Promise<void> {
    const response = await handleMcpRequest(request, this.#outputChannel, {
      serverName: this.#serverName,
    }).catch((error: unknown) => jsonRpcError(request.id ?? null, -32603, errorMessage(error)));
    if (!response) {
      return;
    }
    enqueueResponse(response, framing);
  }
}

export async function handleMcpRequest(
  request: JsonRpcRequest,
  outputChannel?: Pick<vscode.OutputChannel, "appendLine">,
  context?: { readonly serverName?: string },
): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null;
  if (!request.method) {
    return jsonRpcError(id, -32600, "Invalid MCP request.");
  }

  if (request.method.startsWith("notifications/")) {
    return null;
  }

  switch (request.method) {
    case "initialize": {
      const params = isRecord(request.params) ? request.params : {};
      const protocolVersion =
        typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_VERSION;
      return jsonRpcResult(id, {
        protocolVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: context?.serverName ?? DEFAULT_MCP_SERVER_NAME,
          version: "0.0.0",
        },
      });
    }
    case "ping":
      return jsonRpcResult(id, {});
    case "tools/list":
      return jsonRpcResult(id, {
        tools: MCP_TOOLS,
      });
    case "tools/call": {
      const params = isRecord(request.params) ? request.params : {};
      const name = params.name;
      if (typeof name !== "string" || !MCP_TOOL_NAMES.has(name)) {
        return jsonRpcError(id, -32602, `Unknown MCP tool: ${String(name)}`);
      }
      try {
        const result = await executeMcpTool(name, params.arguments, outputChannel);
        return jsonRpcResult(id, result);
      } catch (error) {
        return jsonRpcResult(id, {
          isError: true,
          content: [
            {
              type: "text",
              text: errorMessage(error),
            },
          ],
        });
      }
    }
    default:
      return jsonRpcError(id, -32601, `Unknown MCP method: ${request.method}`);
  }
}

const MCP_TOOLS = [
  {
    name: "vscodeDiagnostics",
    title: "VS Code Diagnostics",
    description: "Return diagnostics currently known to VS Code.",
    inputSchema: {
      type: "object",
      properties: {
        maxDiagnostics: {
          type: "number",
          minimum: 1,
          maximum: MAX_DIAGNOSTICS_LIMIT,
        },
        file: {
          type: "string",
        },
        source: {
          type: "string",
        },
        code: {},
        includeNonWorkspaceDiagnostics: {
          type: "boolean",
        },
        minSeverity: {
          type: "string",
          enum: ["error", "warning", "information", "hint"],
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vscodeReferences",
    title: "VS Code References",
    description: "Find references for a symbol through VS Code language providers.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          minLength: 1,
        },
        position: {
          type: "object",
          properties: {
            line: {
              type: "number",
              minimum: 0,
            },
            character: {
              type: "number",
              minimum: 0,
            },
          },
          required: ["line", "character"],
          additionalProperties: false,
        },
        includeDeclaration: {
          type: "boolean",
        },
        maxReferences: {
          type: "number",
          minimum: 1,
          maximum: MAX_REFERENCES_LIMIT,
        },
      },
      required: ["file", "position"],
      additionalProperties: false,
    },
  },
  {
    name: "vscodeWorkspaceSymbols",
    title: "VS Code Workspace Symbols",
    description: "Search workspace symbols through VS Code language providers.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
        },
        maxSymbols: {
          type: "number",
          minimum: 1,
          maximum: MAX_WORKSPACE_SYMBOLS_LIMIT,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "vscodeRunCommand",
    title: "VS Code Run Command",
    description: "Execute an allowed registered VS Code command and return its result.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          minLength: 1,
          pattern: "\\S",
        },
        args: {
          type: "array",
          items: {},
        },
        activateExtension: {
          type: "string",
          minLength: 1,
          pattern: "\\S",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
] as const;

const MCP_TOOL_NAMES = new Set<string>(MCP_TOOLS.map((tool) => tool.name));

function executeMcpTool(
  name: string,
  input: unknown,
  outputChannel?: Pick<vscode.OutputChannel, "appendLine">,
) {
  switch (name) {
    case "vscodeDiagnostics":
      return executeVsCodeDiagnostics(input);
    case "vscodeReferences":
      return executeVsCodeReferences(input);
    case "vscodeWorkspaceSymbols":
      return executeVsCodeWorkspaceSymbols(input);
    case "vscodeRunCommand":
      return executeVsCodeRunCommand(input, outputChannel);
    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}

export async function executeVsCodeRunCommand(
  input: unknown,
  outputChannel?: Pick<vscode.OutputChannel, "appendLine">,
): Promise<{
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent: { readonly command: string; readonly result: unknown };
}> {
  const args = parseRunCommandInput(input);
  if (args.command.startsWith("_")) {
    throw new Error("Internal VS Code commands are not supported by this tool.");
  }
  if (!isAllowedRunCommand(args.command)) {
    throw new Error(`VS Code command is not allowed through MCP: ${args.command}`);
  }

  if (args.activateExtension) {
    await activateVsCodeExtension(args.activateExtension, outputChannel);
  }

  const registeredCommands = await vscode.commands.getCommands(true);
  if (!registeredCommands.includes(args.command)) {
    throw new Error(`VS Code command is not registered: ${args.command}`);
  }

  const hydratedArgs = args.args.map(hydrateVsCodeArgument);
  outputChannel?.appendLine(
    `[mcp] vscodeRunCommand ${args.command} ${JSON.stringify(serializeForJson(args.args))}`,
  );
  const result = await vscode.commands.executeCommand(args.command, ...hydratedArgs);
  const serializedResult = serializeForJson(result);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            command: args.command,
            result: serializedResult,
          },
          null,
          2,
        ),
      },
    ],
    structuredContent: {
      command: args.command,
      result: serializedResult,
    },
  };
}

export async function executeVsCodeDiagnostics(input: unknown): Promise<{
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent: {
    readonly diagnostics: readonly SerializedDiagnostic[];
    readonly returnedDiagnostics: number;
    readonly totalDiagnosticsAfterFiltering: number;
    readonly limit: number;
    readonly truncated: boolean;
    readonly summary: string;
  };
}> {
  const args = parseDiagnosticsInput(input);
  const diagnosticsByUri = vscode.languages.getDiagnostics();
  const targetUri = args.file ? resolveVsCodeUri(args.file) : null;
  const workspaceFolderUris = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri);
  const filtered = diagnosticsByUri.flatMap(([uri, diagnostics]) => {
    if (targetUri && !sameUri(uri, targetUri)) {
      return [];
    }
    if (!args.includeNonWorkspaceDiagnostics && !isUriInWorkspace(uri, workspaceFolderUris)) {
      return [];
    }
    return diagnostics
      .filter((diagnostic) => diagnostic.severity <= args.minSeverity)
      .filter((diagnostic) => args.source === undefined || diagnostic.source === args.source)
      .filter(
        (diagnostic) => args.code === undefined || diagnosticCodeEquals(diagnostic.code, args.code),
      )
      .map((diagnostic) => serializeDiagnostic(uri, diagnostic));
  });
  const diagnostics = filtered.slice(0, args.maxDiagnostics);
  return mcpStructuredJsonResult({
    diagnostics,
    returnedDiagnostics: diagnostics.length,
    totalDiagnosticsAfterFiltering: filtered.length,
    limit: args.maxDiagnostics,
    truncated: filtered.length > diagnostics.length,
    summary: `Returned ${diagnostics.length} of ${filtered.length} diagnostic(s).`,
  });
}

export async function executeVsCodeReferences(input: unknown): Promise<{
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent: {
    readonly references: readonly SerializedLocation[];
    readonly returnedReferences: number;
    readonly totalReferences: number;
    readonly limit: number;
    readonly truncated: boolean;
    readonly summary: string;
  };
}> {
  const args = parseReferencesInput(input);
  const uri = resolveVsCodeUri(args.file);
  const position = new vscode.Position(args.position.line, args.position.character);
  const rawReferences = await vscode.commands.executeCommand<
    readonly vscode.Location[] | undefined
  >("vscode.executeReferenceProvider", uri, position, {
    includeDeclaration: args.includeDeclaration,
  });
  const allReferences = (rawReferences ?? []).map(serializeLocation);
  const references = allReferences.slice(0, args.maxReferences);
  return mcpStructuredJsonResult({
    references,
    returnedReferences: references.length,
    totalReferences: allReferences.length,
    limit: args.maxReferences,
    truncated: allReferences.length > references.length,
    summary: `Returned ${references.length} of ${allReferences.length} reference(s).`,
  });
}

export async function executeVsCodeWorkspaceSymbols(input: unknown): Promise<{
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent: {
    readonly symbols: readonly SerializedSymbol[];
    readonly returnedSymbols: number;
    readonly totalSymbols: number;
    readonly limit: number;
    readonly truncated: boolean;
    readonly summary: string;
  };
}> {
  const args = parseWorkspaceSymbolsInput(input);
  const rawSymbols = await vscode.commands.executeCommand<
    readonly vscode.SymbolInformation[] | undefined
  >("vscode.executeWorkspaceSymbolProvider", args.query);
  const allSymbols = (rawSymbols ?? []).map(serializeSymbol);
  const symbols = allSymbols.slice(0, args.maxSymbols);
  return mcpStructuredJsonResult({
    symbols,
    returnedSymbols: symbols.length,
    totalSymbols: allSymbols.length,
    limit: args.maxSymbols,
    truncated: allSymbols.length > symbols.length,
    summary: `Returned ${symbols.length} of ${allSymbols.length} workspace symbol(s).`,
  });
}

function isMcpEnabled(): boolean {
  return vscode.workspace.getConfiguration("t3code").get<boolean>(MCP_SETTING, true);
}

function createMcpServerName(): string {
  return `${MCP_SERVER_NAME_PREFIX}-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
}

function isWindowsHost(): boolean {
  return process.env.OS === "Windows_NT";
}

async function createMcpEndpoint(): Promise<{
  readonly socketDir: string;
  readonly socketPath: string;
}> {
  if (isWindowsHost()) {
    const name = `t3code-vscode-mcp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
    return {
      socketDir: "",
      socketPath: path.join("\\\\.\\pipe", name),
    };
  }
  const socketDir = await fs.mkdtemp(path.join(os.tmpdir(), "t3code-vscode-mcp-"));
  return {
    socketDir,
    socketPath: path.join(socketDir, "mcp.sock"),
  };
}

function parseRunCommandInput(input: unknown): {
  readonly command: string;
  readonly args: readonly unknown[];
  readonly activateExtension?: string;
} {
  if (!isRecord(input)) {
    throw new Error("vscodeRunCommand expects an object input.");
  }
  const command = input.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error("vscodeRunCommand.command must be a non-empty string.");
  }
  const rawArgs = input.args;
  if (rawArgs !== undefined && !Array.isArray(rawArgs)) {
    throw new Error("vscodeRunCommand.args must be an array when provided.");
  }
  const activateExtension = input.activateExtension;
  if (
    activateExtension !== undefined &&
    (typeof activateExtension !== "string" || activateExtension.trim().length === 0)
  ) {
    throw new Error("vscodeRunCommand.activateExtension must be a non-empty string when provided.");
  }
  return {
    command: command.trim(),
    args: rawArgs ?? [],
    ...(typeof activateExtension === "string"
      ? { activateExtension: activateExtension.trim() }
      : {}),
  };
}

async function activateVsCodeExtension(
  extensionId: string,
  outputChannel?: Pick<vscode.OutputChannel, "appendLine">,
): Promise<void> {
  if (!isAllowedActivateExtension(extensionId)) {
    throw new Error(`VS Code extension activation is not allowed through MCP: ${extensionId}`);
  }
  const extension = vscode.extensions.getExtension(extensionId);
  if (!extension) {
    throw new Error(`VS Code extension is not installed: ${extensionId}`);
  }
  if (typeof extension.activate !== "function") {
    throw new Error(`VS Code extension cannot be activated through MCP: ${extensionId}`);
  }
  outputChannel?.appendLine(`[mcp] Activating VS Code extension ${extensionId}`);
  try {
    await extension.activate();
  } catch (error) {
    throw new Error(`Failed to activate VS Code extension ${extensionId}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function parseDiagnosticsInput(input: unknown): {
  readonly maxDiagnostics: number;
  readonly file?: string;
  readonly source?: string;
  readonly code?: unknown;
  readonly includeNonWorkspaceDiagnostics: boolean;
  readonly minSeverity: vscode.DiagnosticSeverity;
} {
  const record = input === undefined ? {} : expectRecord(input, "vscodeDiagnostics");
  return {
    maxDiagnostics: boundedInteger(
      record.maxDiagnostics,
      DEFAULT_DIAGNOSTICS_LIMIT,
      1,
      MAX_DIAGNOSTICS_LIMIT,
    ),
    ...(typeof record.file === "string" && record.file.trim().length > 0
      ? { file: record.file.trim() }
      : {}),
    ...(typeof record.source === "string" && record.source.trim().length > 0
      ? { source: record.source.trim() }
      : {}),
    ...(record.code === undefined ? {} : { code: record.code }),
    includeNonWorkspaceDiagnostics:
      typeof record.includeNonWorkspaceDiagnostics === "boolean"
        ? record.includeNonWorkspaceDiagnostics
        : false,
    minSeverity: diagnosticSeverityFromInput(record.minSeverity),
  };
}

function parseReferencesInput(input: unknown): {
  readonly file: string;
  readonly position: { readonly line: number; readonly character: number };
  readonly includeDeclaration: boolean;
  readonly maxReferences: number;
} {
  const record = expectRecord(input, "vscodeReferences");
  const file = record.file;
  if (typeof file !== "string" || file.trim().length === 0) {
    throw new Error("vscodeReferences.file must be a non-empty string.");
  }
  const position = expectRecord(record.position, "vscodeReferences.position");
  return {
    file: file.trim(),
    position: {
      line: nonNegativeInteger(position.line, "vscodeReferences.position.line"),
      character: nonNegativeInteger(position.character, "vscodeReferences.position.character"),
    },
    includeDeclaration:
      typeof record.includeDeclaration === "boolean" ? record.includeDeclaration : true,
    maxReferences: boundedInteger(
      record.maxReferences,
      DEFAULT_REFERENCES_LIMIT,
      1,
      MAX_REFERENCES_LIMIT,
    ),
  };
}

function parseWorkspaceSymbolsInput(input: unknown): {
  readonly query: string;
  readonly maxSymbols: number;
} {
  const record = expectRecord(input, "vscodeWorkspaceSymbols");
  const query = record.query;
  if (typeof query !== "string") {
    throw new Error("vscodeWorkspaceSymbols.query must be a string.");
  }
  return {
    query,
    maxSymbols: boundedInteger(
      record.maxSymbols,
      DEFAULT_WORKSPACE_SYMBOLS_LIMIT,
      1,
      MAX_WORKSPACE_SYMBOLS_LIMIT,
    ),
  };
}

function hydrateVsCodeArgument(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(hydrateVsCodeArgument);
  }
  if (!isRecord(value)) {
    return value;
  }

  switch (value.$vscode) {
    case "Uri":
      if (typeof value.path === "string") {
        return vscode.Uri.file(value.path);
      }
      if (typeof value.value === "string") {
        return vscode.Uri.parse(value.value);
      }
      throw new Error("Invalid VS Code Uri argument.");
    case "Position":
      return new vscode.Position(
        requiredNumber(value.line, "line"),
        requiredNumber(value.character, "character"),
      );
    case "Range":
      return new vscode.Range(
        requiredNumber(value.startLine, "startLine"),
        requiredNumber(value.startCharacter, "startCharacter"),
        requiredNumber(value.endLine, "endLine"),
        requiredNumber(value.endCharacter, "endCharacter"),
      );
    default:
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [key, hydrateVsCodeArgument(nested)]),
      );
  }
}

interface SerializedDiagnostic {
  readonly file: SerializedUri;
  readonly range: SerializedRange;
  readonly severity: string;
  readonly severityCode: number;
  readonly message: string;
  readonly source?: string;
  readonly code?: unknown;
}

interface SerializedUri {
  readonly value: string;
  readonly path?: string;
}

interface SerializedPosition {
  readonly line: number;
  readonly character: number;
}

interface SerializedRange {
  readonly start: SerializedPosition;
  readonly end: SerializedPosition;
}

interface SerializedLocation {
  readonly uri: SerializedUri;
  readonly range: SerializedRange;
}

interface SerializedSymbol {
  readonly name: string;
  readonly kind: number;
  readonly kindName?: string;
  readonly containerName?: string;
  readonly location: SerializedLocation;
}

function serializeDiagnostic(uri: vscode.Uri, diagnostic: vscode.Diagnostic): SerializedDiagnostic {
  return {
    file: serializeUri(uri),
    range: serializeRange(diagnostic.range),
    severity: diagnosticSeverityName(diagnostic.severity),
    severityCode: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.source ? { source: diagnostic.source } : {}),
    ...(diagnostic.code === undefined ? {} : { code: serializeForJson(diagnostic.code) }),
  };
}

function serializeSymbol(symbol: vscode.SymbolInformation): SerializedSymbol {
  return {
    name: symbol.name,
    kind: symbol.kind,
    ...(typeof vscode.SymbolKind[symbol.kind] === "string"
      ? { kindName: vscode.SymbolKind[symbol.kind] }
      : {}),
    ...(symbol.containerName ? { containerName: symbol.containerName } : {}),
    location: serializeLocation(symbol.location),
  };
}

function serializeLocation(location: vscode.Location): SerializedLocation {
  return {
    uri: serializeUri(location.uri),
    range: serializeRange(location.range),
  };
}

function serializeUri(uri: vscode.Uri): SerializedUri {
  return {
    value: uri.toString(),
    ...(uri.fsPath ? { path: uri.fsPath } : {}),
  };
}

function serializeRange(range: vscode.Range): SerializedRange {
  return {
    start: serializePosition(range.start),
    end: serializePosition(range.end),
  };
}

function serializePosition(position: vscode.Position): SerializedPosition {
  return {
    line: position.line,
    character: position.character,
  };
}

function mcpStructuredJsonResult<T extends object>(
  structuredContent: T,
): {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent: T;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  };
}

function serializeForJson(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === undefined) {
    return null;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  if (depth >= MAX_SERIALIZED_DEPTH) {
    return String(value);
  }
  seen.add(value);

  if (isUriLike(value)) {
    return {
      $vscode: "Uri",
      value: typeof value.toString === "function" ? value.toString() : undefined,
      path: typeof value.fsPath === "string" ? value.fsPath : undefined,
    };
  }
  if (isPositionLike(value)) {
    return {
      $vscode: "Position",
      line: value.line,
      character: value.character,
    };
  }
  if (isRangeLike(value)) {
    return {
      $vscode: "Range",
      start: serializeForJson(value.start, depth + 1, seen),
      end: serializeForJson(value.end, depth + 1, seen),
    };
  }
  if (isLocationLike(value)) {
    return {
      $vscode: "Location",
      uri: serializeForJson(value.uri, depth + 1, seen),
      range: serializeForJson(value.range, depth + 1, seen),
    };
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_SERIALIZED_ARRAY_ITEMS)
      .map((item) => serializeForJson(item, depth + 1, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value).slice(0, MAX_SERIALIZED_OBJECT_KEYS)) {
    result[key] = serializeForJson(nested, depth + 1, seen);
  }
  return result;
}

function resolveVsCodeUri(input: string): vscode.Uri {
  const trimmed = input.trim();
  if (path.win32.isAbsolute(trimmed) || path.isAbsolute(trimmed)) {
    return vscode.Uri.file(trimmed);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(trimmed)) {
    return vscode.Uri.parse(trimmed);
  }
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error(`Relative path requires an open VS Code workspace: ${input}`);
  }
  return vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, trimmed));
}

function isUriInWorkspace(uri: vscode.Uri, workspaceFolderUris: readonly vscode.Uri[]): boolean {
  if (workspaceFolderUris.length === 0) {
    return true;
  }
  if (uri.scheme !== "file" && uri.scheme !== "vscode-remote") {
    return false;
  }
  return workspaceFolderUris.some((workspaceUri) => {
    if (workspaceUri.scheme !== uri.scheme || workspaceUri.authority !== uri.authority) {
      return false;
    }
    const workspacePath = normalizeFsPath(workspaceUri.fsPath);
    const uriPath = normalizeFsPath(uri.fsPath);
    return uriPath === workspacePath || uriPath.startsWith(`${workspacePath}${path.sep}`);
  });
}

function sameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  return (
    left.toString() === right.toString() ||
    normalizeFsPath(left.fsPath) === normalizeFsPath(right.fsPath)
  );
}

function normalizeFsPath(value: string): string {
  return path.resolve(value);
}

function diagnosticSeverityFromInput(input: unknown): vscode.DiagnosticSeverity {
  switch (input) {
    case undefined:
    case "information":
      return vscode.DiagnosticSeverity.Information;
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    case "hint":
      return vscode.DiagnosticSeverity.Hint;
    default:
      throw new Error(
        "vscodeDiagnostics.minSeverity must be one of error, warning, information, or hint.",
      );
  }
}

function diagnosticSeverityName(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "information";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
    default:
      return String(severity);
  }
}

function diagnosticCodeEquals(left: vscode.Diagnostic["code"], right: unknown): boolean {
  return JSON.stringify(serializeForJson(left)) === JSON.stringify(serializeForJson(right));
}

function expectRecord(input: unknown, label: string): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new Error(`${label} expects an object input.`);
  }
  return input;
}

function boundedInteger(input: unknown, defaultValue: number, min: number, max: number): number {
  if (input === undefined) {
    return defaultValue;
  }
  if (typeof input !== "number" || !Number.isInteger(input)) {
    throw new Error(`Expected an integer between ${min} and ${max}.`);
  }
  return Math.min(max, Math.max(min, input));
}

function nonNegativeInteger(input: unknown, label: string): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return input;
}

function readNextMessage(
  buffer: Buffer<ArrayBufferLike>,
  currentFraming: TransportFraming | null,
): {
  readonly message: JsonRpcRequest;
  readonly remaining: Buffer<ArrayBufferLike>;
  readonly framing: TransportFraming;
} | null {
  const framing = currentFraming ?? detectFraming(buffer);
  if (!framing) {
    return null;
  }

  if (framing === "headers") {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return null;
    }
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const contentLengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)/iu.exec(header);
    if (!contentLengthMatch?.[1]) {
      throw new Error("MCP message is missing Content-Length.");
    }
    const contentLength = Number(contentLengthMatch[1]);
    if (contentLength > MAX_MCP_RECEIVE_BUFFER_BYTES) {
      throw new Error(`MCP Content-Length exceeds ${MAX_MCP_RECEIVE_BUFFER_BYTES} bytes.`);
    }
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (buffer.length < bodyEnd) {
      return null;
    }
    return {
      message: JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8")) as JsonRpcRequest,
      remaining: buffer.subarray(bodyEnd),
      framing,
    };
  }

  const newlineIndex = buffer.indexOf("\n");
  if (newlineIndex < 0) {
    return null;
  }
  const line = buffer.subarray(0, newlineIndex).toString("utf8").trim();
  if (!line) {
    return {
      message: { method: "notifications/empty" },
      remaining: buffer.subarray(newlineIndex + 1),
      framing,
    };
  }
  return {
    message: JSON.parse(line) as JsonRpcRequest,
    remaining: buffer.subarray(newlineIndex + 1),
    framing,
  };
}

function detectFraming(buffer: Buffer): TransportFraming | null {
  if (buffer.length === 0) {
    return null;
  }
  const prefix = buffer.subarray(0, Math.min(buffer.length, 32)).toString("utf8");
  if (/^Content-Length:/iu.test(prefix)) {
    return "headers";
  }
  return "newline";
}

function encodeMessage(message: JsonRpcResponse, framing: TransportFraming): Buffer | string {
  const json = JSON.stringify(message);
  if (framing === "headers") {
    return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
  }
  return `${json}\n`;
}

function writeSocketMessage(socket: net.Socket, message: Buffer | string): Promise<void> {
  if (socket.destroyed) {
    return Promise.resolve();
  }
  if (socket.write(message)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("drain", onDrain);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    socket.once("drain", onDrain);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function isAllowedRunCommand(command: string): boolean {
  return getAllowedRunCommandPatterns().some((pattern) =>
    matchesAllowedRunCommandPattern(command, pattern),
  );
}

function isAllowedActivateExtension(extensionId: string): boolean {
  return getAllowedActivateExtensionIds().includes(extensionId);
}

function getAllowedRunCommandPatterns(): readonly string[] {
  const configured = vscode.workspace
    .getConfiguration("t3code")
    .get<unknown>(MCP_RUN_COMMAND_ALLOWLIST_SETTING);
  if (configured === undefined) {
    return DEFAULT_ALLOWED_RUN_COMMAND_PATTERNS;
  }
  if (!Array.isArray(configured)) {
    return [];
  }
  const patterns = new Set<string>();
  for (const entry of configured) {
    if (typeof entry !== "string") {
      continue;
    }
    const pattern = entry.trim();
    if (isValidAllowedRunCommandPattern(pattern)) {
      patterns.add(pattern);
    }
  }
  return [...patterns];
}

function getAllowedActivateExtensionIds(): readonly string[] {
  const configured = vscode.workspace
    .getConfiguration("t3code")
    .get<unknown>(MCP_ACTIVATE_EXTENSION_ALLOWLIST_SETTING);
  if (configured === undefined) {
    return DEFAULT_ALLOWED_ACTIVATE_EXTENSION_IDS;
  }
  if (!Array.isArray(configured)) {
    return [];
  }
  const extensionIds = new Set<string>();
  for (const entry of configured) {
    if (typeof entry !== "string") {
      continue;
    }
    const extensionId = entry.trim();
    if (extensionId.length > 0) {
      extensionIds.add(extensionId);
    }
  }
  return [...extensionIds];
}

function isValidAllowedRunCommandPattern(pattern: string): boolean {
  if (!pattern) {
    return false;
  }
  const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
  return prefix.length > 0 && !prefix.includes("*");
}

function matchesAllowedRunCommandPattern(command: string, pattern: string): boolean {
  if (!pattern) {
    return false;
  }
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return prefix.length > 0 && command.startsWith(prefix);
  }
  return command === pattern;
}

function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid VS Code ${name} argument.`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUriLike(value: object): value is { readonly fsPath?: string; toString: () => string } {
  return (
    "scheme" in value &&
    typeof (value as { readonly scheme?: unknown }).scheme === "string" &&
    "fsPath" in value &&
    typeof (value as { readonly toString?: unknown }).toString === "function"
  );
}

function isPositionLike(
  value: object,
): value is { readonly line: number; readonly character: number } {
  return "line" in value && "character" in value;
}

function isRangeLike(value: object): value is { readonly start: unknown; readonly end: unknown } {
  return "start" in value && "end" in value;
}

function isLocationLike(
  value: object,
): value is { readonly uri: unknown; readonly range: unknown } {
  return "uri" in value && "range" in value;
}
