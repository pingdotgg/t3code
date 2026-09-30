import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { execFileSync } from "node:child_process";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { WS_METHODS } from "@t3tools/contracts";
import { WsTransport } from "@t3tools/client-runtime";
import { expect, it, vi } from "vitest";

import { createDesktopAccountDriver } from "../src/desktopAccount.ts";
import { createConnectAccountTransport } from "../../desktop/src/connectAccountTransport.ts";
import { startDesktopConnectFixture } from "./desktopConnectFixture.ts";

async function step<A>(name: string, action: Promise<A>): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it("discovers two real hosts through account OAuth and routes authorized HTTP, sockets, folders and commands", async () => {
  const fixture = await startDesktopConnectFixture();
  const transports: WsTransport[] = [];
  const appOrigin = "http://127.0.0.1:7106";
  const native = createConnectAccountTransport({
    driver: createDesktopAccountDriver({
      baseDir: Path.join(fixture.root, "desktop-account"),
      openBrowser: fixture.authorize,
    }),
    trustedOrigin: () => appOrigin,
    onInvalidated: () => undefined,
  });
  try {
    for (const [key, value] of Object.entries(fixture.environment)) vi.stubEnv(key, value);
    vi.stubGlobal("fetch", fixture.fixtureFetch);
    vi.stubGlobal(
      "WebSocket",
      class extends NodeSocket.NodeWS.WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols, { origin: appOrigin });
        }
      },
    );
    expect(await native.discover()).toBeNull();
    const account = await step("OAuth sign-in", native.login());
    expect(account?.environments.map((environment) => environment.label).sort()).toEqual([
      "Fixture Alpha",
      "Fixture Beta",
    ]);
    if (!account) throw new Error("Production account login did not finish.");
    const connections = await step(
      "account connections",
      Promise.all(
        account.environments.map((environment) =>
          native.connect(account.accountId, environment.environmentId),
        ),
      ),
    );
    const first = connections[0];
    const second = connections[1];
    const alpha = fixture.hosts[0];
    const beta = fixture.hosts[1];
    if (!first || !second || !alpha || !beta) throw new Error("Fixture hosts missing.");
    const request = (base: string, path: string, init?: RequestInit) =>
      native.handle(
        new Request(`${base}${path}`, {
          ...init,
          headers: { origin: appOrigin, ...init?.headers },
        }),
      );
    expect(
      (
        await native.handle(
          new Request(`${first.httpBaseUrl}/api/auth/session`, {
            headers: { origin: "https://untrusted.example" },
          }),
        )
      ).status,
    ).toBe(403);
    for (const [index, connection] of connections.entries()) {
      const host = fixture.hosts[index];
      if (!host) throw new Error("Host missing.");
      const auth = await step(
        "authenticated HTTP",
        request(connection.httpBaseUrl, "/api/auth/session"),
      );
      expect(auth.status).toBe(200);
      expect(await auth.json()).toMatchObject({
        authenticated: true,
        sessionMethod: "dpop-access-token",
      });
      const rpc = new WsTransport(() =>
        native.socketUrl(account.accountId, connection.environmentId),
      );
      transports.push(rpc);
      const browse = await step(
        "native socket filesystem browse",
        rpc.request((client) =>
          client[WS_METHODS.filesystemBrowse]({ partialPath: `${host.workspace}/` }),
        ),
      );
      expect(browse.entries.map((entry) => entry.name)).toContain(
        index === 0 ? "alpha-only" : "beta-only",
      );
    }
    const created = await request(first.httpBaseUrl, "/api/orchestration/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "project.create",
        commandId: "account-project-create",
        projectId: "account-project",
        title: "Account project",
        workspaceRoot: alpha.workspace,
        defaultModelSelection: { instanceId: "codex", model: "gpt-5-codex" },
        createdAt: new Date().toISOString(),
      }),
    });
    expect(created.status, await created.text()).toBe(200);
    const betaRpc = transports[1];
    if (!betaRpc) throw new Error("Beta socket missing.");
    await betaRpc.request((client) =>
      client[WS_METHODS.terminalOpen]({
        threadId: "account-fixture-terminal",
        terminalId: "main",
        cwd: beta.workspace,
      }),
    );
    await betaRpc.request((client) =>
      client[WS_METHODS.terminalWrite]({
        threadId: "account-fixture-terminal",
        terminalId: "main",
        data: "printf 'executed-on-beta' > account-command.txt\r",
      }),
    );
    await expect
      .poll(() =>
        FS.readFile(Path.join(beta.workspace, "account-command.txt"), "utf8").catch(() => ""),
      )
      .toBe("executed-on-beta");
    await expect(FS.access(Path.join(alpha.workspace, "account-command.txt"))).rejects.toThrow();

    const revoked = await fixture.nativeFetch(`${alpha.origin}/api/auth/clients/revoke-others`, {
      method: "POST",
      headers: { authorization: `Bearer ${alpha.ownerToken}` },
    });
    expect(revoked.status).toBe(200);
    const renewed = await request(first.httpBaseUrl, "/api/auth/session");
    expect(renewed.status).toBe(200);
    expect(await renewed.json()).toMatchObject({
      authenticated: true,
      sessionMethod: "dpop-access-token",
    });

    await native.logout();
    expect((await request(first.httpBaseUrl, "/api/auth/session")).status).toBe(401);
    await expect(native.socketUrl(account.accountId, first.environmentId)).rejects.toThrow();
    expect(await native.discover()).toBeNull();
    const hostLink = await fixture.nativeFetch(`${alpha.origin}/api/connect/link-state`, {
      headers: { authorization: `Bearer ${alpha.ownerToken}` },
    });
    expect(await hostLink.json()).toMatchObject({ linked: true, cloudUserId: account.accountId });
    const output = Path.join(
      Path.resolve(import.meta.dirname, "../../.."),
      ".t3",
      "desktop-connect-proof.json",
    );
    await FS.writeFile(
      output,
      JSON.stringify(
        {
          revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          worktreeChanges: true,
          command:
            "cd apps/server && pnpm exec vp test run integration/desktopConnect.integration.test.ts",
          observedAt: new Date().toISOString(),
          assertions: [
            "Real OAuth PKCE callback, token exchange, relay discovery, cloud mint and DPoP exchange",
            "Two actual fork servers appear; each socket browses its own project folders",
            "Authenticated HTTP project creation reaches Alpha; shell command writes only Beta",
            "Untrusted scheme origin rejected; revoked access token transparently renewed",
            "Desktop logout revokes native capabilities without unlinking hosts",
          ],
          result: "passed",
          limitation:
            "Native transport integration; Electron renderer interaction is validated separately.",
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.all(transports.map((transport) => transport.dispose()));
    native.dispose();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fixture.close();
    await FS.rm(fixture.root, { recursive: true, force: true });
  }
}, 180_000);
