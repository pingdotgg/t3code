import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs/promises";
import * as Http from "node:http";
import * as Https from "node:https";
import * as Path from "node:path";
import { pathToFileURL } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Option, Schema } from "effect";
import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import { signRelayJwt, RELAY_MINT_REQUEST_TYP } from "@t3tools/shared/relayJwt";
import { connectLoopbackRedirectUri } from "@t3tools/shared/connectAuth";

import { ServerConfig } from "../src/config.ts";
import { resolveCliAuthConfig } from "../src/cli/config.ts";
import * as ServerSecretStore from "../src/auth/ServerSecretStore.ts";
import { persistCloudRelayConfig } from "../src/cloud/http.ts";

const repository = Path.resolve(import.meta.dirname, "../../..");
const accountId = "desktop-fixture-account";
const jwt = (claims: object) =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
const oauthToken = jwt({ sub: accountId });
const decodeMint = Schema.decodeUnknownSync(
  Schema.Struct({
    credential: Schema.String,
    expiresAt: Schema.String,
  }),
);
const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const decodeBootstrap = Schema.decodeUnknownSync(Schema.Struct({ sessionToken: Schema.String }));
const decodeCallback = Schema.decodeUnknownSync(Schema.Struct({ callback: Schema.String }));

async function listen(server: Http.Server | Https.Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener.");
  return address.port;
}

async function body(request: Http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString();
  if (request.headers["content-type"]?.includes("application/json")) {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") throw new Error("Invalid fixture input.");
    return new Map(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }
  return new Map(new URLSearchParams(text));
}

export async function startDesktopConnectFixture() {
  const nativeFetch = globalThis.fetch;
  const root = Path.join(repository, ".t3", `connect-fixture-${Crypto.randomUUID()}`);
  await FS.mkdir(root, { recursive: true, mode: 0o700 });
  const cert = Path.join(root, "fixture-ca.pem");
  const key = Path.join(root, "fixture-key.pem");
  ChildProcess.execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      "/CN=T3 local acceptance fixture",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    { stdio: "ignore" },
  );
  await FS.chmod(key, 0o600);
  const signing = Crypto.generateKeyPairSync("ed25519");
  const privateKey = signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = signing.publicKey.export({ type: "spki", format: "pem" }).toString();
  const codes = new Map<string, string>();
  const relayTokens = new Map<string, string>();
  const hosts: {
    environmentId: string;
    label: string;
    origin: string;
    workspace: string;
    baseDir: string;
    ownerToken: string;
  }[] = [];
  const children: ChildProcess.ChildProcess[] = [];
  let relayOrigin = "";

  const handler: Http.RequestListener = (request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    void (async () => {
      const url = new URL(request.url ?? "/", relayOrigin);
      if (url.pathname === "/connect") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<!doctype html><html><body><h1>Local T3 Connect acceptance fixture</h1>
<p>This signs in only to the disposable test account.</p><button id="login">Sign in as Fixture User</button>
<script>document.getElementById("login").onclick=async()=>{const p=new URLSearchParams(location.hash.slice(1));
const r=await fetch("/authorize",{method:"POST",headers:{"content-type":"application/json"},
body:JSON.stringify(Object.fromEntries(p))});const v=await r.json();location.href=v.callback;};</script></body></html>`);
        return;
      }
      if (url.pathname === "/authorize") {
        const values = await body(request);
        const challenge = values.get("challenge");
        const state = values.get("state");
        const port = Number(values.get("port"));
        if (!challenge || !state || port !== 34338)
          return send(400, { error: "Invalid authorization." });
        const code = Crypto.randomUUID();
        codes.set(code, challenge);
        const callback = new URL(connectLoopbackRedirectUri(port));
        callback.searchParams.set("state", state);
        callback.searchParams.set("code", code);
        return send(200, { callback: callback.toString() });
      }
      if (url.pathname === "/oauth/token") {
        const values = await body(request);
        if (values.get("grant_type") === "authorization_code") {
          const code = values.get("code") ?? "";
          const challenge = codes.get(code);
          codes.delete(code);
          if (
            !challenge ||
            Crypto.createHash("sha256")
              .update(values.get("code_verifier") ?? "")
              .digest("base64url") !== challenge
          )
            return send(401, { error: "Invalid PKCE exchange." });
        } else if (values.get("refresh_token") !== "fixture-refresh") {
          return send(401, { error: "Invalid refresh token." });
        }
        return send(200, {
          access_token: oauthToken,
          refresh_token: "fixture-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          id_token: jwt({ sub: accountId, email: "fixture@example.test" }),
        });
      }
      if (
        url.pathname === "/v1/environments" &&
        request.headers.authorization === `Bearer ${oauthToken}`
      ) {
        return send(200, {
          environments: hosts.map((host) => ({
            environmentId: host.environmentId,
            label: host.label,
            endpoint: {
              httpBaseUrl: host.origin,
              wsBaseUrl: `${host.origin.replace(/^http/, "ws")}/ws`,
              providerKind: "manual",
            },
            linkedAt: "2026-01-01T00:00:00.000Z",
          })),
        });
      }
      const dpop = request.headers.dpop;
      if (typeof dpop !== "string") return send(401, { error: "DPoP required." });
      if (url.pathname === "/v1/client/dpop-token") {
        const values = await body(request);
        if (values.get("subject_token") !== oauthToken)
          return send(401, { error: "Wrong account." });
        const proof = verifyDpopProof({
          proof: dpop,
          method: "POST",
          url: `${relayOrigin}${url.pathname}`,
          nowEpochSeconds: Math.floor(Date.now() / 1000),
        });
        if (!proof.ok) return send(401, { error: "Invalid DPoP." });
        const token = Crypto.randomUUID();
        relayTokens.set(token, proof.thumbprint);
        return send(200, {
          access_token: token,
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "DPoP",
          expires_in: 3600,
          scope: values.get("scope"),
        });
      }
      const match = /^\/v1\/environments\/([^/]+)\/connect$/.exec(url.pathname);
      const host = hosts.find((candidate) => candidate.environmentId === match?.[1]);
      const accessToken = request.headers.authorization?.replace(/^DPoP /, "") ?? "";
      const thumbprint = relayTokens.get(accessToken);
      if (!host || !thumbprint)
        return send(401, { error: "Unknown environment or authorization." });
      const verification = verifyDpopProof({
        proof: dpop,
        method: "POST",
        url: `${relayOrigin}${url.pathname}`,
        expectedThumbprint: thumbprint,
        expectedAccessToken: accessToken,
        nowEpochSeconds: Math.floor(Date.now() / 1000),
      });
      if (!verification.ok) return send(401, { error: "Invalid bound proof." });
      const now = Math.floor(Date.now() / 1000);
      const proof = await Effect.runPromise(
        signRelayJwt({
          privateKey,
          typ: RELAY_MINT_REQUEST_TYP,
          payload: {
            iss: relayOrigin,
            aud: `t3-env:${host.environmentId}`,
            sub: accountId,
            jti: Crypto.randomUUID(),
            iat: now,
            exp: now + 60,
            environmentId: host.environmentId,
            clientProofKeyThumbprint: thumbprint,
            cnf: { jkt: thumbprint },
            nonce: Crypto.randomUUID(),
            scope: ["environment:connect"],
          },
        }),
      );
      const minted = await fetch(`${host.origin}/api/connect/mint-credential`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proof }),
      });
      if (!minted.ok)
        return send(502, { error: `Real host rejected mint: ${await minted.text()}` });
      const result = decodeMint(await minted.json());
      return send(200, {
        environmentId: host.environmentId,
        endpoint: {
          httpBaseUrl: host.origin,
          wsBaseUrl: `${host.origin.replace(/^http/, "ws")}/ws`,
          providerKind: "manual",
        },
        credential: result.credential,
        expiresAt: result.expiresAt,
      });
    })().catch(() => send(500, { error: "Fixture request failed." }));
  };
  const http = Http.createServer(handler);
  const https = Https.createServer(
    { key: await FS.readFile(key), cert: await FS.readFile(cert) },
    handler,
  );
  const close = async () => {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null) return;
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
          child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
          child.kill("SIGTERM");
        });
      }),
    );
    http.closeAllConnections();
    https.closeAllConnections();
    await Promise.all(
      [http, https].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  };
  try {
    const httpPort = await listen(http);
    relayOrigin = `https://127.0.0.1:${await listen(https)}`;
    const hostedAppUrl = `http://127.0.0.1:${httpPort}`;
    for (const label of ["Fixture Alpha", "Fixture Beta"]) {
      const baseDir = Path.join(root, label.replaceAll(" ", "-").toLowerCase());
      const workspace = Path.join(baseDir, "projects");
      await FS.mkdir(Path.join(workspace, label === "Fixture Alpha" ? "alpha-only" : "beta-only"), {
        recursive: true,
      });
      await FS.mkdir(Path.join(baseDir, "userdata"), { recursive: true });
      await FS.writeFile(Path.join(baseDir, "userdata", "environment-label"), label);
      const credential = Crypto.randomBytes(32).toString("base64url");
      const reservation = Http.createServer();
      const hostPort = await listen(reservation);
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      const child = ChildProcess.spawn(
        process.execPath,
        [Path.join(repository, "apps/server/dist/bin.mjs"), "--bootstrap-fd", "3"],
        {
          cwd: workspace,
          env: {
            ...process.env,
            T3CODE_RELAY_URL: relayOrigin,
            T3CODE_ANALYTICS_DISABLED: "1",
            T3CODE_PORT: String(hostPort),
            T3CODE_HOME: baseDir,
            T3CODE_HOST: "127.0.0.1",
            VITE_DEV_SERVER_URL: undefined,
          },
          stdio: ["ignore", "ignore", "pipe", "pipe"],
        },
      );
      children.push(child);
      let failures = "";
      child.stderr?.on("data", (chunk) => {
        failures = `${failures}${chunk.toString()}`.slice(-4000);
      });
      const pipe = child.stdio[3];
      if (!pipe || !("write" in pipe)) throw new Error("Missing fixture bootstrap pipe.");
      pipe.end(
        `${JSON.stringify({
          mode: "desktop",
          noBrowser: true,
          port: hostPort,
          t3Home: baseDir,
          host: "127.0.0.1",
          desktopBootstrapToken: credential,
          autoBootstrapProjectFromCwd: false,
        })}\n`,
      );
      let origin: string | undefined;
      for (let attempt = 0; attempt < 240; attempt++) {
        if (child.exitCode !== null) throw new Error(`Fixture host exited: ${failures}`);
        try {
          origin = JSON.parse(
            await FS.readFile(Path.join(baseDir, "userdata", "server-runtime.json"), "utf8"),
          ).origin;
          if (origin && (await fetch(`${origin}/.well-known/t3/environment`)).ok) break;
        } catch {
          /* Wait for the real listener. */
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!origin) throw new Error(`Fixture host did not start: ${failures}`);
      const descriptor = decodeDescriptor(
        await (await fetch(`${origin}/.well-known/t3/environment`)).json(),
      );
      const bootstrap = decodeBootstrap(
        await (
          await fetch(`${origin}/api/auth/bootstrap/bearer`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ credential }),
          })
        ).json(),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const config = yield* resolveCliAuthConfig(
            { baseDir: Option.some(baseDir) },
            Option.none(),
          );
          yield* Effect.gen(function* () {
            const secrets = yield* ServerSecretStore.ServerSecretStore;
            yield* persistCloudRelayConfig(secrets, {
              relayUrl: relayOrigin,
              relayIssuer: relayOrigin,
              cloudUserId: accountId,
              environmentCredential: "fixture-host-credential",
              cloudMintPublicKey: publicKey,
              endpointRuntimeJson: null,
            });
          }).pipe(
            Effect.provide(
              ServerSecretStore.layer.pipe(Layer.provide(Layer.succeed(ServerConfig, config))),
            ),
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      );
      hosts.push({
        environmentId: descriptor.environmentId,
        label,
        origin,
        workspace,
        baseDir,
        ownerToken: bootstrap.sessionToken,
      });
    }
    const environment = {
      T3CODE_RELAY_URL: relayOrigin,
      T3CODE_CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from(`${new URL(relayOrigin).host}$`).toString("base64")}`,
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "desktop-fixture",
      T3CODE_HOSTED_APP_URL: hostedAppUrl,
      NODE_EXTRA_CA_CERTS: cert,
    };
    await FS.writeFile(
      Path.join(root, "launch.json"),
      JSON.stringify(
        {
          environment,
          hosts: hosts.map(({ ownerToken: _secret, ...host }) => host),
        },
        null,
        2,
      ),
    );
    return {
      root,
      environment,
      hosts,
      close,
      async authorize(url: string) {
        const parsed = new URL(url);
        const result = await fetch(`${hostedAppUrl}/authorize`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(Object.fromEntries(new URLSearchParams(parsed.hash.slice(1)))),
        });
        if (!result.ok) throw new Error("Fixture consent failed.");
        const value = decodeCallback(await result.json());
        const callback = await fetch(value.callback);
        if (!callback.ok) throw new Error("Production OAuth callback rejected fixture consent.");
      },
      nativeFetch,
      fixtureFetch: (url: string | URL | Request, init?: RequestInit) => {
        const requested = new URL(url instanceof Request ? url.url : String(url));
        if (requested.origin !== relayOrigin) return nativeFetch(url, init);
        const rewritten = `${hostedAppUrl}${requested.pathname}${requested.search}`;
        return nativeFetch(url instanceof Request ? new Request(rewritten, url) : rewritten, init);
      },
    };
  } catch (error) {
    await close();
    await FS.rm(root, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(Path.resolve(process.argv[1])).href) {
  const fixture = await startDesktopConnectFixture();
  console.log(
    `Disposable Connect fixture ready. Native launch configuration: ${Path.join(fixture.root, "launch.json")}`,
  );
  const shutdown = () => {
    void fixture.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
