// @effect-diagnostics nodeBuiltinImport:off - CLI integration uses temporary Node paths and a local HTTP server.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NetService.layer);

/** Runs the CLI and returns everything it wrote with `console.log`. */
const runCli = (args: ReadonlyArray<string>) => {
  const lines: Array<string> = [];
  const testConsole = {
    ...globalThis.console,
    log: (...values: ReadonlyArray<unknown>) => {
      lines.push(values.map(String).join(" "));
    },
  } satisfies Console.Console;
  return Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provideService(Console.Console, testConsole),
    Effect.provide(layerCliRuntime),
    Effect.map(() => lines.join("\n")),
  );
};

interface ListedSession {
  readonly sessionId: string;
  readonly subject: string;
  readonly connected: boolean | null;
}

const issueSession = (baseDir: string, label: string) =>
  runCli(["auth", "session", "issue", "--label", label, "--json", "--base-dir", baseDir]).pipe(
    Effect.map((output) => JSON.parse(output) as { readonly sessionId: string }),
  );

const listSessions = (baseDir: string) =>
  runCli(["auth", "session", "list", "--json", "--base-dir", baseDir]).pipe(
    Effect.map((output) => JSON.parse(output) as ReadonlyArray<ListedSession>),
  );

/** Serves `/api/auth/clients` as a running server would, with the given sessions connected. */
const serveClients = (connectedSessionIds: ReadonlyArray<string>) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly origin: string;
      readonly requests: Array<string>;
      readonly server: NodeHttp.Server;
    }>((resume) => {
      const requests: Array<string> = [];
      const server = NodeHttp.createServer((request, response) => {
        requests.push(`${request.method} ${request.url} ${request.headers.authorization ?? ""}`);
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            connectedSessionIds.map((sessionId) => ({
              sessionId,
              subject: "cli-issued-session",
              scopes: ["orchestration:read"],
              method: "bearer-access-token",
              client: { deviceType: "bot" },
              issuedAt: "2026-10-18T12:00:00.000Z",
              expiresAt: "2099-01-01T00:00:00.000Z",
              lastConnectedAt: "2026-10-18T12:00:00.000Z",
              connected: true,
              current: false,
            })),
          ),
        );
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as { readonly port: number };
        resume(Effect.succeed({ origin: `http://127.0.0.1:${address.port}`, requests, server }));
      });
    }),
    (served) =>
      Effect.callback<void>((resume) => {
        served.server.close(() => resume(Effect.void));
      }),
  );

it.effect("reports connection state as unknown when no server is running", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-auth-cli-offline-"));
    const issued = yield* issueSession(baseDir, "phone");

    const listed = yield* listSessions(baseDir);
    const human = yield* runCli(["auth", "session", "list", "--base-dir", baseDir]);

    assert.deepEqual(
      listed.map(({ sessionId, connected }) => ({ sessionId, connected })),
      [{ sessionId: issued.sessionId, connected: null }],
    );
    assert.include(human, "Connection state unknown: no running server answered.");
  }),
);

it.effect("reads connection state from the running server", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-auth-cli-live-"));
    const live = yield* issueSession(baseDir, "live phone");
    const idle = yield* issueSession(baseDir, "idle laptop");
    const served = yield* serveClients([live.sessionId]);
    const { serverRuntimeStatePath } = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
    NodeFS.writeFileSync(
      serverRuntimeStatePath,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        port: Number(new URL(served.origin).port),
        origin: served.origin,
        startedAt: "2026-10-18T12:00:00.000Z",
      }),
    );

    const listed = yield* listSessions(baseDir);
    const human = yield* runCli(["auth", "session", "list", "--base-dir", baseDir]);
    const listedAfter = yield* listSessions(baseDir);

    const connectedById = new Map(listed.map((session) => [session.sessionId, session.connected]));
    assert.strictEqual(connectedById.get(live.sessionId), true);
    assert.strictEqual(connectedById.get(idle.sessionId), false);
    assert.include(human, `${live.sessionId} connected`);
    assert.notInclude(human, `${idle.sessionId} connected`);
    assert.notInclude(human, "Connection state unknown");
    assert.isTrue(
      served.requests.every((line) => line.startsWith("GET /api/auth/clients Bearer ")),
    );
    // The short-lived session used for the live read is revoked, so it never shows in a listing.
    assert.deepEqual(
      listedAfter.map((session) => session.sessionId).toSorted(),
      [live.sessionId, idle.sessionId].toSorted(),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
