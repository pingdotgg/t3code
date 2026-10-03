// Filesystem validation runs only in the startup Effect.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { McpProviderSessionConfig } from "./McpProviderSession.ts";

/**
 * Operator setting for a local stdio process that sits in front of the
 * per-session t3-code MCP HTTP endpoint. The value is an absolute executable
 * path plus optional fixed arguments, separated by whitespace. Quotes group
 * an argument; nothing is expanded and nothing is passed to a shell.
 */
export const T3_MCP_STDIO_WRAPPER_ENV = "T3_MCP_STDIO_WRAPPER";

/** Endpoint URL given to the wrapper. Never placed on the command line. */
export const T3_MCP_URL_ENV = "T3_MCP_URL";

/** Authorization header value given to the wrapper. Never placed on the command line. */
export const T3_MCP_AUTHORIZATION_ENV = "T3_MCP_AUTHORIZATION";

export class McpStdioWrapperConfigError extends Schema.TaggedError<McpStdioWrapperConfigError>()(
  "McpStdioWrapperConfigError",
  {
    category: Schema.Literals([
      "relativePath",
      "notFound",
      "notExecutable",
      "unmatchedQuote",
      "emptyCommand",
      "externalServer",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.category === "externalServer")
      return "An external OpenCode server cannot launch T3_MCP_STDIO_WRAPPER. Connect to a local OpenCode server or unset T3_MCP_STDIO_WRAPPER.";
    return `${T3_MCP_STDIO_WRAPPER_ENV} cannot be used: ${this.category}`;
  }
}

const isMcpStdioWrapperConfigError = Schema.is(McpStdioWrapperConfigError);

export interface McpStdioWrapperCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface McpStdioWrapperLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export type ResolvedT3McpTransport =
  | {
      readonly kind: "http";
      readonly endpoint: string;
      readonly authorizationHeader: string;
    }
  | ({
      readonly kind: "stdio";
    } & McpStdioWrapperLaunch);

/** POSIX root, Windows drive root, or UNC path. */
export function isAbsoluteWrapperPath(value: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value);
}

/** Throws the categorized configuration error; the message never carries the raw value. */
function fail(category: McpStdioWrapperConfigError["category"]): never {
  throw new McpStdioWrapperConfigError({ category });
}

/**
 * Splits a wrapper command into argv. Unmatched quotes and an empty command
 * are configuration errors. Backslashes are literal characters.
 */
export function parseMcpStdioWrapperCommand(value: string): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
} {
  const tokens: Array<string> = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let sawToken = false;
  for (const character of value) {
    if (quote !== null) {
      if (character === quote) {
        quote = null;
        sawToken = true;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      sawToken = true;
      continue;
    }
    if (character === " " || character === "\t" || character === "\n" || character === "\r") {
      if (current.length > 0 || sawToken) {
        tokens.push(current);
        current = "";
        sawToken = false;
      }
      continue;
    }
    current += character;
    sawToken = true;
  }
  if (quote !== null) {
    fail("unmatchedQuote");
  }
  if (current.length > 0 || sawToken) {
    tokens.push(current);
  }
  const command = tokens[0];
  if (command === undefined || command.length === 0) {
    fail("emptyCommand");
  }
  return { command, args: tokens.slice(1) };
}

/** Validate once before any provider sessions or credentials can be created. */
export const loadMcpStdioWrapper = (environment: NodeJS.ProcessEnv = process.env) =>
  Effect.gen(function* () {
    const configured = yield* Config.String(T3_MCP_STDIO_WRAPPER_ENV)
      .pipe(Config.option, Config.map(Option.getOrUndefined))
      .parse(ConfigProvider.fromEnvRecord(environment, { preserveEmptyStrings: true }));
    if (configured === undefined) return undefined;
    return yield* Effect.try({
      try: () => {
        const parsed = parseMcpStdioWrapperCommand(configured);
        if (!isAbsoluteWrapperPath(parsed.command)) fail("relativePath");
        let stat: NodeFS.Stats;
        try {
          stat = NodeFS.statSync(parsed.command);
        } catch (cause) {
          throw new McpStdioWrapperConfigError({ category: "notFound", cause });
        }
        if (!stat.isFile()) fail("notExecutable");
        if (HostProcessPlatform.defaultValue() !== "win32") {
          try {
            NodeFS.accessSync(parsed.command, NodeFS.constants.X_OK);
          } catch (cause) {
            throw new McpStdioWrapperConfigError({ category: "notExecutable", cause });
          }
        }
        return parsed;
      },
      catch: (cause) =>
        isMcpStdioWrapperConfigError(cause)
          ? cause
          : new McpStdioWrapperConfigError({ category: "notExecutable", cause }),
    });
  });

/** Pure session configuration: never reads the environment or filesystem. */
export function resolveT3McpTransport(
  session: Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader" | "stdioWrapper">,
): ResolvedT3McpTransport {
  const parsed = session.stdioWrapper;
  if (parsed === undefined) {
    return {
      kind: "http",
      endpoint: session.endpoint,
      authorizationHeader: session.authorizationHeader,
    };
  }
  return {
    kind: "stdio",
    command: parsed.command,
    args: parsed.args,
    env: {
      [T3_MCP_URL_ENV]: session.endpoint,
      [T3_MCP_AUTHORIZATION_ENV]: session.authorizationHeader,
    },
  };
}

export type OpenCodeT3McpConfig =
  | {
      readonly type: "remote";
      readonly url: string;
      readonly headers: { readonly Authorization: string };
      readonly oauth: false;
    }
  | {
      readonly type: "local";
      readonly command: Array<string>;
      readonly environment: Record<string, string>;
    };

/** OpenCode 1.x and OpenCode 2 both accept this local-or-remote MCP config. */
export function openCodeT3McpConfig(
  session: Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader" | "stdioWrapper">,
): OpenCodeT3McpConfig {
  const transport = resolveT3McpTransport(session);
  if (transport.kind === "stdio") {
    return {
      type: "local",
      command: [transport.command, ...transport.args],
      environment: { ...transport.env },
    };
  }
  return {
    type: "remote",
    url: session.endpoint,
    headers: { Authorization: session.authorizationHeader },
    oauth: false,
  };
}
