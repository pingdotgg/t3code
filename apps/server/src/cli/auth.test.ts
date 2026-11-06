import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Command } from "effect/cli";
import { HttpServerRequest } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { authCommand } from "./auth.ts";
import { resolveCliAuthConfig } from "./config.ts";

const cli = Command.make("t3").pipe(Command.withSubcommands([authCommand]));
const runCli = Command.runWith(cli, { version: "0.0.0" });
const bearerRequest = (token: string) =>
  HttpServerRequest.fromWeb(
    new Request("http://localhost/mcp", {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
const capture = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* runCli(args);
    return (yield* TestConsole.logLines).findLast(
      (line): line is string => typeof line === "string",
    )!;
  }).pipe(Effect.provide(TestConsole.layer));

const withAuth = <A, E>(
  baseDir: string,
  run: (auth: EnvironmentAuth.EnvironmentAuth["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const config = yield* resolveCliAuthConfig({ baseDir: Option.some(baseDir) }, Option.none());
    return yield* EnvironmentAuth.EnvironmentAuth.pipe(
      Effect.flatMap(run),
      Effect.provide(EnvironmentAuth.layerRuntime.pipe(Layer.provide(ServerConfig.layer(config)))),
    );
  });

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    Layer.succeed(NetService.NetService, {
      ...NetService.make(),
      findAvailablePort: () => Effect.succeed(13773),
    }),
  ),
)("auth session issue --mcp-access", (it) => {
  it.effect.each([
    { access: "read-only", scopes: ["orchestration:read"] },
    { access: "approval-required", scopes: ["orchestration:read", "orchestration:operate"] },
    { access: "auto-accept-edits", scopes: ["orchestration:read", "orchestration:operate"] },
    { access: "auto", scopes: ["orchestration:read", "orchestration:operate"] },
    {
      access: "full-access",
      scopes: [
        "orchestration:read",
        "orchestration:operate",
        "settings:write",
        "source-control:write",
      ],
    },
  ] as const)("issues a revocable MCP-only $access session", ({ access, scopes }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-mcp-" });
      const issuedAt = yield* Clock.currentTimeMillis;
      const output = yield* capture([
        "auth",
        "session",
        "issue",
        "--base-dir",
        baseDir,
        "--mcp-access",
        access,
        "--label",
        "External client",
        "--json",
      ]);
      const issued = JSON.parse(output) as EnvironmentAuth.IssuedBearerSession;
      assert.equal(issued.subject, "mcp-client");
      assert.deepEqual(issued.scopes, scopes);
      assert.equal(JSON.parse(output).mcpAccess, access);
      assert.equal(Date.parse(JSON.parse(output).expiresAt), issuedAt + 30 * 24 * 60 * 60 * 1000);

      yield* withAuth(baseDir, (auth) =>
        Effect.gen(function* () {
          const request = bearerRequest(issued.token);
          assert.deepEqual(yield* auth.authenticateMcpClient(request), {
            sessionId: issued.sessionId,
            label: "External client",
            access,
            peerLink: false,
          });
          assert.isTrue(
            (yield* Effect.result(auth.authenticateHttpRequest(request)))._tag === "Failure",
          );
          assert.isTrue(yield* auth.revokeSession(issued.sessionId));
          assert.isTrue(
            (yield* Effect.result(auth.authenticateMcpClient(request)))._tag === "Failure",
          );
        }),
      );
    }),
  );

  it.effect("honors a selected TTL without changing the OAuth session default", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-mcp-ttl-" });
      const output = yield* capture([
        "auth",
        "session",
        "issue",
        "--base-dir",
        baseDir,
        "--mcp-access",
        "read-only",
        "--ttl",
        "5m",
        "--token-only",
      ]);
      yield* withAuth(baseDir, (auth) =>
        Effect.gen(function* () {
          const request = bearerRequest(output.trim());
          yield* auth.authenticateMcpClient(request);
          yield* TestClock.adjust("5 minutes");
          assert.isTrue(
            (yield* Effect.result(auth.authenticateMcpClient(request)))._tag === "Failure",
          );
        }),
      );
    }),
  );

  it.effect.each([
    { label: "scope", args: ["--scope", "orchestration:read"] },
    { label: "subject", args: ["--subject", "mcp-client"] },
    { label: "TTL", args: ["--ttl", "0s"] },
  ])("rejects conflicting or invalid $label before opening auth state", ({ args }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-mcp-invalid-" });
      const baseDir = `${root}/unused`;
      const result = yield* Effect.result(
        runCli([
          "auth",
          "session",
          "issue",
          "--base-dir",
          baseDir,
          "--mcp-access",
          "read-only",
          ...args,
        ]),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.propertyVal(result.failure, "_tag", "UserError");
      assert.isFalse(yield* fs.exists(baseDir));
    }),
  );

  it.effect("preserves generic session defaults and explicit scope selection", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-session-" });
      for (const scopeArgs of [[], ["--scope", "orchestration:read"]]) {
        const issued = JSON.parse(
          yield* capture([
            "auth",
            "session",
            "issue",
            "--base-dir",
            baseDir,
            "--json",
            ...scopeArgs,
          ]),
        );
        assert.equal(issued.subject, "cli-issued-session");
        assert.deepEqual(
          issued.scopes,
          scopeArgs.length > 0 ? ["orchestration:read"] : AuthStandardClientScopes,
        );
        assert.notProperty(issued, "mcpAccess");
      }
    }),
  );

  it.effect("does not infer full access from a generic session's scopes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-mcp-generic-" });
      const output = yield* capture([
        "auth",
        "session",
        "issue",
        "--base-dir",
        baseDir,
        "--subject",
        "mcp-client",
        "--scope",
        "orchestration:read",
        "--scope",
        "orchestration:operate",
        "--scope",
        "settings:write",
        "--scope",
        "source-control:write",
        "--token-only",
      ]);
      yield* withAuth(baseDir, (auth) =>
        Effect.gen(function* () {
          const session = yield* auth.authenticateMcpClient(bearerRequest(output.trim()));
          assert.equal(session.access, "approval-required");
        }),
      );
    }),
  );
});
