// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as Effect from "effect/Effect";

import { assert, describe, it } from "@effect/vitest";

import {
  isAbsoluteWrapperPath,
  McpStdioWrapperConfigError,
  loadMcpStdioWrapper,
  parseMcpStdioWrapperCommand,
  resolveT3McpTransport,
  T3_MCP_AUTHORIZATION_ENV,
  T3_MCP_STDIO_WRAPPER_ENV,
  T3_MCP_URL_ENV,
} from "./McpStdioWrapper.ts";

const session = {
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer fixture-session-token",
};

describe("resolveT3McpTransport", () => {
  const executable = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mcp-wrapper-"));
  const binary = NodePath.join(executable, "wrapper");
  NodeFS.writeFileSync(binary, "", { mode: 0o700 });

  it("leaves the HTTP transport unchanged when the setting is unset", () => {
    assert.deepEqual(resolveT3McpTransport(session), {
      kind: "http",
      endpoint: session.endpoint,
      authorizationHeader: session.authorizationHeader,
    });
  });

  it("launches a stdio wrapper with the credential only in the environment", () => {
    const transport = resolveT3McpTransport({
      ...session,
      stdioWrapper: { command: binary, args: ["--listen", "stdio"] },
    });
    assert.deepEqual(transport, {
      kind: "stdio",
      command: binary,
      args: ["--listen", "stdio"],
      env: {
        [T3_MCP_URL_ENV]: session.endpoint,
        [T3_MCP_AUTHORIZATION_ENV]: session.authorizationHeader,
      },
    });
    assert.notInclude(
      JSON.stringify([
        transport.kind === "stdio" ? transport.command : "",
        ...(transport.kind === "stdio" ? transport.args : []),
      ]),
      "fixture-session-token",
    );
    assert.notInclude(
      JSON.stringify(transport.kind === "stdio" ? transport.args : []),
      session.endpoint,
    );
  });

  const load = (value: string | undefined) =>
    loadMcpStdioWrapper(value === undefined ? {} : { [T3_MCP_STDIO_WRAPPER_ENV]: value });

  it.effect("loads the startup snapshot and ignores later environment or file changes", () =>
    Effect.gen(function* () {
      assert.isUndefined(yield* load(undefined));
      const stdioWrapper = yield* load(`${binary} --fixed`);
      assert.deepEqual(stdioWrapper, { command: binary, args: ["--fixed"] });
      const previous = process.env[T3_MCP_STDIO_WRAPPER_ENV];
      process.env[T3_MCP_STDIO_WRAPPER_ENV] = "invalid-relative-path";
      try {
        assert.doesNotThrow(() => resolveT3McpTransport(session));
        assert.doesNotThrow(() => resolveT3McpTransport({ ...session, stdioWrapper }));
        assert.doesNotThrow(() =>
          resolveT3McpTransport({
            ...session,
            stdioWrapper: { command: "/removed-after-startup", args: [] },
          }),
        );
      } finally {
        if (previous === undefined) delete process.env[T3_MCP_STDIO_WRAPPER_ENV];
        else process.env[T3_MCP_STDIO_WRAPPER_ENV] = previous;
      }
    }),
  );

  it.effect.each([
    ["relativePath", "private-operator/wrapper"],
    ["relativePath", "./private-operator/wrapper"],
    ["notFound", NodePath.join(executable, "private-missing")],
    ["unmatchedQuote", `${binary} "unterminated`],
    ["emptyCommand", "   "],
    ["emptyCommand", "''"],
    ["notExecutable", executable],
  ] as const)("startup rejects %s: %s", ([category, value]) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(load(value));
      assert.isTrue(result._tag === "Failure");
      if (result._tag !== "Failure") return;
      assert.instanceOf(result.failure, McpStdioWrapperConfigError);
      const error = result.failure as McpStdioWrapperConfigError;
      assert.equal(error.category, category);
      assert.include(error.message, T3_MCP_STDIO_WRAPPER_ENV);
      assert.notInclude(error.message, value.trim() || "private-operator");
      assert.notInclude(error.message, binary);
      if (category === "notFound") assert.isDefined(error.cause);
    }),
  );

  it.effect("startup rejects non-executable files without exposing the path", () =>
    Effect.gen(function* () {
      if (HostProcessPlatform.defaultValue() === "win32") return;
      const path = NodePath.join(executable, "private-not-executable");
      NodeFS.writeFileSync(path, "#!/bin/sh\n", { mode: 0o600 });
      const result = yield* Effect.result(load(path));
      assert.isTrue(result._tag === "Failure");
      if (result._tag !== "Failure") return;
      const error = result.failure as McpStdioWrapperConfigError;
      assert.equal(error.category, "notExecutable");
      assert.notInclude(error.message, path);
      assert.isDefined(error.cause);
    }),
  );
});

describe("parseMcpStdioWrapperCommand", () => {
  it("preserves empty quoted fixed arguments", () => {
    assert.deepEqual(parseMcpStdioWrapperCommand(`/opt/wrap "" --flag ''`), {
      command: "/opt/wrap",
      args: ["", "--flag", ""],
    });
  });
  it("keeps quoted arguments together and does not expand them", () => {
    assert.deepEqual(parseMcpStdioWrapperCommand(`/opt/wrap --flag "two words" 'a$b'`), {
      command: "/opt/wrap",
      args: ["--flag", "two words", "a$b"],
    });
  });
});

describe("isAbsoluteWrapperPath", () => {
  it.each([
    ["/opt/wrap", true],
    ["C:\\tools\\wrap.exe", true],
    ["c:/tools/wrap", true],
    ["\\\\host\\share\\wrap", true],
    ["wrap", false],
    ["./wrap", false],
    ["C:wrap", false],
    ["", false],
  ] as const)("classifies %j as absolute=%s", (value, absolute) => {
    assert.equal(isAbsoluteWrapperPath(value), absolute);
  });
});
