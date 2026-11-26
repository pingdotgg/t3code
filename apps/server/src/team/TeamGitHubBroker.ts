// @effect-diagnostics nodeBuiltinImport:off -- Server-owned private Unix socket / loopback broker and helper scripts.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  EnvironmentId,
  IsoDateTime,
  TeamId,
  TeamMemberId,
  ThreadId,
  type ProviderSessionId,
  type TeamGitHubAuthMethod,
  type TeamGitHubIdentity,
  type TeamGitHubRemoteLeaseIssueResponse,
  type TeamGitHubRemoteLeaseResolveResponse,
  type TeamGitHubTurnAuthorKind,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as TeamGitHubRepository from "./TeamGitHubRepository.ts";
import * as TeamRepository from "./TeamRepository.ts";
import * as TeamService from "./TeamService.ts";

// Stay below macOS's 104-byte and Linux's 108-byte sockaddr_un limits, including NUL.
const UNIX_SOCKET_PATH_BYTES = 100;
const MAX_BROKER_REQUEST_BYTES = 16 * 1024;
const DEFAULT_TURN_LEASE_TTL_MS = 15 * 60 * 1000;

const TEAM_GH_BROKER_ENDPOINT_ENV = "T3_TEAM_GH_BROKER_ENDPOINT";
const TEAM_GH_BROKER_TOKEN_ENV = "T3_TEAM_GH_BROKER_TOKEN";

const encoder = new TextEncoder();

function sha256Hex(raw: string): string {
  return NodeCrypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) return false;
  return NodeCrypto.timingSafeEqual(aBytes, bBytes);
}

function normalizeSocketIp(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  const withoutBrackets =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const withoutZone = withoutBrackets.split("%")[0] ?? withoutBrackets;
  return withoutZone.startsWith("::ffff:") ? withoutZone.slice("::ffff:".length) : withoutZone;
}

function isLoopbackIp(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost" || ip.startsWith("127.");
}

export function isLocalBrokerHttpRequest(
  req: Pick<NodeHttp.IncomingMessage, "headers" | "socket">,
  isUnixSocket: boolean,
): boolean {
  if (
    req.headers["x-forwarded-for"] !== undefined ||
    req.headers.forwarded !== undefined ||
    req.headers["x-real-ip"] !== undefined
  ) {
    return false;
  }
  if (isUnixSocket) {
    return true;
  }
  const remote = normalizeSocketIp(req.socket?.remoteAddress);
  if (remote === null) return false;
  return isLoopbackIp(remote);
}

function extractBearerToken(headerValue: string | string[] | undefined): string | null {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof value !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}

function buildGitAskpassScript(nodeExecPath: string): string {
  return `#!${nodeExecPath}
"use strict";
const http = require("node:http");

const endpoint = process.env.${TEAM_GH_BROKER_ENDPOINT_ENV};
const token = process.env.${TEAM_GH_BROKER_TOKEN_ENV};
const prompt = process.argv[2] || "";

if (!endpoint || !token) {
  process.exit(1);
}

const body = JSON.stringify({ prompt });
const headers = {
  authorization: "Bearer " + token,
  "content-type": "application/json",
  "content-length": Buffer.byteLength(body),
};

const options = endpoint.startsWith("http://")
  ? (() => {
      const url = new URL(endpoint);
      return {
        hostname: url.hostname,
        port: Number(url.port),
        path: "/v1/git-askpass",
        method: "POST",
        headers,
      };
    })()
  : {
      socketPath: endpoint,
      path: "/v1/git-askpass",
      method: "POST",
      headers,
    };

const req = http.request(options, (res) => {
  const chunks = [];
  res.on("data", (chunk) => chunks.push(chunk));
  res.on("end", () => {
    if (res.statusCode !== 200) {
      process.exit(1);
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof parsed.value !== "string" || parsed.value.length === 0) {
        process.exit(1);
      }
      process.stdout.write(parsed.value + "\\n");
      process.exit(0);
    } catch {
      process.exit(1);
    }
  });
});

req.setTimeout(10000, () => {
  req.destroy();
  process.exit(1);
});
req.on("error", () => process.exit(1));
req.write(body);
req.end();
`;
}

function buildGhWrapperScript(
  nodeExecPath: string,
  wrapperBinDir: string,
  emptyGhConfigDir: string,
): string {
  return `#!${nodeExecPath}
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const WRAPPER_BIN_DIR = ${JSON.stringify(wrapperBinDir)};
const EMPTY_GH_CONFIG_DIR = ${JSON.stringify(emptyGhConfigDir)};
const endpoint = process.env.${TEAM_GH_BROKER_ENDPOINT_ENV};
const brokerToken = process.env.${TEAM_GH_BROKER_TOKEN_ENV};
const args = process.argv.slice(2);

function requestBroker() {
  return new Promise((resolve, reject) => {
    if (!endpoint || !brokerToken) {
      reject(new Error("Missing broker configuration."));
      return;
    }
    const body = JSON.stringify({ args });
    const headers = {
      authorization: "Bearer " + brokerToken,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    };
    const options = endpoint.startsWith("http://")
      ? (() => {
          const url = new URL(endpoint);
          return {
            hostname: url.hostname,
            port: Number(url.port),
            path: "/v1/gh-token",
            method: "POST",
            headers,
          };
        })()
      : {
          socketPath: endpoint,
          path: "/v1/gh-token",
          method: "POST",
          headers,
        };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error("Broker rejected credential request (" + res.statusCode + ")."));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("Broker request timed out."));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function findRealGhBinary() {
  const rawPath = process.env.PATH || "";
  const resolvedWrapperDir = path.resolve(WRAPPER_BIN_DIR);
  const exeName = process.platform === "win32" ? "gh.exe" : "gh";
  for (const dir of rawPath.split(path.delimiter)) {
    if (!dir) continue;
    if (path.resolve(dir) === resolvedWrapperDir) continue;
    const candidate = path.join(dir, exeName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep searching
    }
  }
  return null;
}

function runDirectApi(lease, apiArgs) {
  return new Promise((resolve) => {
    let method = "GET";
    let methodExplicit = false;
    const extraHeaders = {};
    const fields = {};
    let hasFields = false;
    let endpointPath = "";
    for (let i = 0; i < apiArgs.length; i += 1) {
      const arg = apiArgs[i];
      if ((arg === "-X" || arg === "--method") && apiArgs[i + 1]) {
        method = apiArgs[++i].toUpperCase();
        methodExplicit = true;
      } else if ((arg === "-H" || arg === "--header") && apiArgs[i + 1]) {
        const hdr = apiArgs[++i];
        const idx = hdr.indexOf(":");
        if (idx > 0) {
          extraHeaders[hdr.slice(0, idx).trim().toLowerCase()] = hdr.slice(idx + 1).trim();
        }
      } else if ((arg === "-f" || arg === "--raw-field" || arg === "-F" || arg === "--field") && apiArgs[i + 1]) {
        const pair = apiArgs[++i];
        const idx = pair.indexOf("=");
        if (idx > 0) {
          fields[pair.slice(0, idx)] = pair.slice(idx + 1);
          hasFields = true;
        }
      } else if (!arg.startsWith("-") && !endpointPath) {
        endpointPath = arg;
      }
    }
    if (!endpointPath) {
      process.stderr.write("Missing API endpoint path.\\n");
      resolve(1);
      return;
    }
    if (hasFields && !methodExplicit) {
      method = "POST";
    }
    const base = lease.apiBaseUrl.replace(/\\/+$/, "");
    const target = endpointPath.startsWith("http://") || endpointPath.startsWith("https://")
      ? new URL(endpointPath)
      : new URL(base + "/" + endpointPath.replace(/^\\/+/, ""));
    const payload = hasFields ? JSON.stringify(fields) : undefined;
    const headers = {
      accept: "application/vnd.github+json",
      "user-agent": "t3code-teams-gh",
      ...extraHeaders,
      authorization: "Bearer " + lease.token,
      ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}),
    };
    const transport = target.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const out = Buffer.concat(chunks);
          if (out.length > 0) process.stdout.write(out);
          resolve(res.statusCode && res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
        });
      },
    );
    req.on("error", (err) => {
      process.stderr.write(String(err.message || err) + "\\n");
      resolve(1);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  let lease;
  try {
    lease = await requestBroker();
  } catch {
    process.stderr.write("GitHub credentials are not available for the active turn.\\n");
    process.exit(1);
  }
  if (!lease || typeof lease.token !== "string" || lease.token.length === 0) {
    process.stderr.write("GitHub credentials are not available for the active turn.\\n");
    process.exit(1);
  }
  if (args[0] === "auth" && args[1] === "token") {
    process.stdout.write(lease.token + "\\n");
    process.exit(0);
  }
  if (args[0] === "auth" && args[1] === "status" && lease.apiBaseUrl && lease.apiBaseUrl.startsWith("http://")) {
    process.stdout.write("Logged in as " + lease.githubLogin + " (" + lease.apiBaseUrl + ")\\n");
    process.exit(0);
  }
  if (args[0] === "api" && lease.apiBaseUrl && lease.apiBaseUrl.startsWith("http://")) {
    const code = await runDirectApi(lease, args.slice(1));
    process.exit(code);
  }
  const realGh = findRealGhBinary();
  if (!realGh) {
    if (args[0] === "api") {
      const code = await runDirectApi(lease, args.slice(1));
      process.exit(code);
    }
    process.stderr.write("gh CLI is not installed on this host.\\n");
    process.exit(127);
  }
  const childEnv = { ...process.env };
  delete childEnv.GITHUB_TOKEN;
  childEnv.GH_TOKEN = lease.token;
  childEnv.GH_CONFIG_DIR = EMPTY_GH_CONFIG_DIR;
  childEnv.GH_PROMPT_DISABLED = "1";
  try {
    const apiUrl = new URL(lease.apiBaseUrl || "https://api.github.com");
    if (apiUrl.hostname !== "api.github.com" && apiUrl.hostname !== "github.com") {
      childEnv.GH_HOST = apiUrl.host;
    }
  } catch {
    // ignore malformed URL
  }
  const result = spawnSync(realGh, args, { env: childEnv, stdio: "inherit" });
  process.exit(result.status === null ? 1 : result.status);
})();
`;
}

export interface TeamGitHubBrokerStartErrorCause {
  readonly cause: unknown;
}

export class TeamGitHubBrokerStartError extends Schema.TaggedError<TeamGitHubBrokerStartError>()(
  "TeamGitHubBrokerStartError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "Could not start the local turn-scoped GitHub credential broker.";
  }
}

interface SessionBrokerChannel {
  readonly token: string;
  readonly providerSessionId: ProviderSessionId;
  readonly threadId: ThreadId;
  readonly authorKind: TeamGitHubTurnAuthorKind;
  readonly authorMemberId: TeamMemberId | null;
  readonly credentialGeneration: number;
}

type LocalTurnLeaseSource =
  | {
      readonly kind: "local";
      readonly teamId: TeamId;
      readonly credentialUpdatedAt: string | null;
    }
  | {
      readonly kind: "remote";
      readonly teamServerUrl: string;
      readonly environmentId: EnvironmentId;
      readonly leaseId: string;
      readonly leaseToken: string;
    };

interface ActiveTurnLease {
  readonly threadId: ThreadId;
  readonly turnId: string;
  readonly providerSessionId: ProviderSessionId | null;
  readonly authorKind: TeamGitHubTurnAuthorKind;
  readonly authorMemberId: TeamMemberId | null;
  readonly expiresAtMs: number;
  readonly revoked: boolean;
  readonly source: LocalTurnLeaseSource;
}

interface IssuedRemoteTurnLease {
  readonly leaseId: string;
  readonly leaseTokenHash: string;
  readonly teamId: TeamId;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly turnId: string;
  readonly authorKind: TeamGitHubTurnAuthorKind;
  readonly authorMemberId: TeamMemberId | null;
  readonly credentialUpdatedAt: string;
  readonly expiresAt: IsoDateTime;
  readonly expiresAtMs: number;
  readonly revoked: boolean;
}

interface ResolvedBrokerCredential {
  readonly token: string;
  readonly authMethod: TeamGitHubAuthMethod;
  readonly githubLogin: string;
  readonly githubName: string | null;
  readonly githubEmail: string | null;
  readonly apiBaseUrl: string;
}

const RemoteLeaseResolveResponseSchema = Schema.fromJsonString(
  Schema.Struct({
    token: Schema.NonEmptyString,
    authMethod: Schema.Literals(["pat", "oauth", "github_app"]),
    githubLogin: Schema.NonEmptyString,
    githubName: Schema.NullOr(Schema.String),
    githubEmail: Schema.NullOr(Schema.String),
    apiBaseUrl: Schema.NonEmptyString,
    expiresAt: Schema.NonEmptyString,
  }),
);
const decodeRemoteResolveResponse = Schema.decodeUnknownOption(RemoteLeaseResolveResponseSchema);

const BrokerAskpassRequestSchema = Schema.fromJsonString(
  Schema.Struct({
    prompt: Schema.optionalKey(Schema.String),
  }),
);
const decodeAskpassRequest = Schema.decodeUnknownOption(BrokerAskpassRequestSchema);
const encodeJsonUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function readHttpBody(req: NodeHttp.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Array<Buffer> = [];
    let total = 0;
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_BROKER_REQUEST_BYTES) {
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => finish(null));
  });
}

function writeJson(res: NodeHttp.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    pragma: "no-cache",
    "content-length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

export interface PrepareGitHubSessionEnvironmentInput {
  readonly providerSessionId: ProviderSessionId;
  readonly threadId: ThreadId;
  readonly authorKind: TeamGitHubTurnAuthorKind;
  readonly authorMemberId: TeamMemberId | null;
  readonly identityOverride?: Pick<
    TeamGitHubIdentity,
    "githubLogin" | "githubName" | "githubEmail"
  > | null;
}

export interface ActivateLocalTurnLeaseInput {
  readonly threadId: ThreadId;
  readonly turnId: string;
  readonly providerSessionId: ProviderSessionId | null;
  readonly authorKind: TeamGitHubTurnAuthorKind;
  readonly authorMemberId: TeamMemberId | null;
  readonly ttlMs?: number;
}

export interface ActivateRemoteTurnLeaseInput {
  readonly threadId: ThreadId;
  readonly turnId: string;
  readonly providerSessionId: ProviderSessionId | null;
  readonly environmentId: EnvironmentId;
  readonly teamServerUrl: string;
  readonly leaseId: string;
  readonly leaseToken: string;
  readonly expiresAt: IsoDateTime;
  readonly authorKind: TeamGitHubTurnAuthorKind;
  readonly authorMemberId: TeamMemberId | null;
}

export interface IssueRemoteTurnLeaseInput {
  readonly teamId: TeamId;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly turnId: string;
  readonly authorKind: TeamGitHubTurnAuthorKind;
  readonly authorMemberId: TeamMemberId | null;
  readonly ttlMs?: number;
}

export interface ResolveRemoteTurnLeaseInput {
  readonly leaseId: string;
  readonly leaseToken: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly turnId: string;
}

export class TeamGitHubBroker extends Context.Service<
  TeamGitHubBroker,
  {
    readonly getEndpoint: () => Effect.Effect<string | null>;
    readonly getCredentialGeneration: (input: {
      readonly authorKind: TeamGitHubTurnAuthorKind;
      readonly authorMemberId: TeamMemberId | null;
    }) => Effect.Effect<number>;
    readonly getSessionCredentialGeneration: (
      providerSessionId: ProviderSessionId,
    ) => Effect.Effect<number | null>;
    readonly prepareSessionEnvironment: (
      input: PrepareGitHubSessionEnvironmentInput,
    ) => Effect.Effect<Readonly<Record<string, string>> | null>;
    readonly revokeSessionChannel: (providerSessionId: ProviderSessionId) => Effect.Effect<void>;
    readonly activateLocalTurnLease: (input: ActivateLocalTurnLeaseInput) => Effect.Effect<void>;
    readonly activateRemoteTurnLease: (input: ActivateRemoteTurnLeaseInput) => Effect.Effect<void>;
    readonly revokeTurnLease: (input: {
      readonly threadId: ThreadId;
      readonly turnId?: string | null;
    }) => Effect.Effect<void>;
    readonly revokeMemberLeases: (memberId: TeamMemberId) => Effect.Effect<void>;
    readonly revokeAutomationLeases: (teamId: TeamId) => Effect.Effect<void>;
    readonly hasActiveTurnLease: (input: {
      readonly threadId: ThreadId;
      readonly turnId?: string | null;
    }) => Effect.Effect<boolean>;
    readonly issueRemoteTurnLease: (
      input: IssueRemoteTurnLeaseInput,
    ) => Effect.Effect<TeamGitHubRemoteLeaseIssueResponse>;
    readonly resolveRemoteTurnLease: (
      input: ResolveRemoteTurnLeaseInput,
    ) => Effect.Effect<TeamGitHubRemoteLeaseResolveResponse | null>;
    readonly revokeRemoteTurnLease: (input: {
      readonly leaseId?: string;
      readonly leaseToken?: string;
      readonly environmentId?: EnvironmentId;
      readonly threadId?: ThreadId;
      readonly turnId?: string;
      readonly authorizedMemberId?: TeamMemberId;
    }) => Effect.Effect<boolean>;
  }
>()("t3/team/TeamGitHubBroker") {}

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const uid = yield* HostProcess.UserId;
  const nodeExecPath = yield* HostProcess.ExecutablePath;
  const hostEnv = yield* HostProcess.Environment;
  const secretsOption = yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore);
  const teamRepoOption = yield* Effect.serviceOption(TeamRepository.TeamRepository);
  const githubRepoOption = yield* Effect.serviceOption(TeamGitHubRepository.TeamGitHubRepository);
  const teamServiceOption = yield* Effect.serviceOption(TeamService.TeamService);
  const httpClientOption = yield* Effect.serviceOption(HttpClient.HttpClient);

  const channelsRef = yield* Ref.make<ReadonlyMap<string, SessionBrokerChannel>>(new Map());
  const activeTurnLeasesRef = yield* Ref.make<ReadonlyMap<string, ActiveTurnLease>>(new Map());
  const remoteLeasesRef = yield* Ref.make<ReadonlyMap<string, IssuedRemoteTurnLease>>(new Map());
  const memberCredGenRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const automationCredGenRef = yield* Ref.make<number>(0);

  const turnLeaseKey = (threadId: ThreadId, turnId: string) => `${threadId}::${turnId}`;

  const resolveLocalCredential = Effect.fn("TeamGitHubBroker.resolveLocalCredential")(
    function* (input: {
      readonly teamId: TeamId;
      readonly authorKind: TeamGitHubTurnAuthorKind;
      readonly authorMemberId: TeamMemberId | null;
      readonly expectedUpdatedAt?: string | null;
    }): Effect.fn.Return<ResolvedBrokerCredential | null> {
      if (Option.isNone(secretsOption) || Option.isNone(githubRepoOption)) {
        return null;
      }
      if (input.authorKind === "team_automation") {
        const recordOpt = yield* githubRepoOption.value
          .getAutomationCredential(input.teamId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(recordOpt)) {
          // Unconfigured team-automation cleanly receives zero GitHub credentials (never borrows a member's PAT).
          return null;
        }
        if (
          input.expectedUpdatedAt !== undefined &&
          input.expectedUpdatedAt !== null &&
          recordOpt.value.updatedAt !== input.expectedUpdatedAt
        ) {
          return null;
        }
        const secret = yield* TeamGitHubRepository.readTeamGitHubSecret(
          secretsOption.value,
          recordOpt.value.secretKey,
        ).pipe(Effect.orElseSucceed(() => null));
        if (!secret || secret.accessToken.trim().length === 0) return null;
        return {
          token: secret.accessToken,
          authMethod: secret.authMethod,
          githubLogin: recordOpt.value.githubLogin,
          githubName: recordOpt.value.githubName,
          githubEmail: recordOpt.value.githubEmail,
          apiBaseUrl: recordOpt.value.apiBaseUrl,
        };
      }

      if (input.authorMemberId === null) {
        return null;
      }
      if (Option.isSome(teamRepoOption)) {
        const memberOpt = yield* teamRepoOption.value
          .getMemberById(input.authorMemberId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (
          Option.isNone(memberOpt) ||
          memberOpt.value.teamId !== input.teamId ||
          memberOpt.value.status !== "active"
        ) {
          return null;
        }
      }
      const recordOpt = yield* githubRepoOption.value
        .getMemberCredential(input.authorMemberId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(recordOpt) || recordOpt.value.teamId !== input.teamId) {
        return null;
      }
      if (
        input.expectedUpdatedAt !== undefined &&
        input.expectedUpdatedAt !== null &&
        recordOpt.value.updatedAt !== input.expectedUpdatedAt
      ) {
        return null;
      }
      const secret = yield* TeamGitHubRepository.readTeamGitHubSecret(
        secretsOption.value,
        recordOpt.value.secretKey,
      ).pipe(Effect.orElseSucceed(() => null));
      if (!secret || secret.accessToken.trim().length === 0) return null;
      return {
        token: secret.accessToken,
        authMethod: secret.authMethod,
        githubLogin: recordOpt.value.githubLogin,
        githubName: recordOpt.value.githubName,
        githubEmail: recordOpt.value.githubEmail,
        apiBaseUrl: recordOpt.value.apiBaseUrl,
      };
    },
  );

  const resolveRemoteLeaseFromServer = Effect.fn("TeamGitHubBroker.resolveRemoteLeaseFromServer")(
    function* (lease: ActiveTurnLease): Effect.fn.Return<ResolvedBrokerCredential | null> {
      if (lease.source.kind !== "remote") return null;
      const client = Option.isSome(httpClientOption)
        ? httpClientOption.value
        : yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
      const url = `${lease.source.teamServerUrl.replace(/\/+$/, "")}/api/team/github-lease/resolve`;
      const req = HttpClientRequest.post(url).pipe(
        HttpClientRequest.bodyText(
          encodeJsonUnknown({
            leaseId: lease.source.leaseId,
            leaseToken: lease.source.leaseToken,
            environmentId: lease.source.environmentId,
            threadId: lease.threadId,
            turnId: lease.turnId,
          }),
          "application/json",
        ),
      );
      const res = yield* client
        .execute(req)
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.timeout("10 seconds"),
          Effect.option,
        );
      if (Option.isNone(res)) return null;
      if (res.value.status === 401 || res.value.status === 403 || res.value.status === 404) {
        yield* Ref.update(activeTurnLeasesRef, (current) => {
          const key = turnLeaseKey(lease.threadId, lease.turnId);
          if (!current.has(key)) return current;
          const next = new Map(current);
          next.delete(key);
          return next;
        });
        return null;
      }
      if (res.value.status < 200 || res.value.status >= 300) return null;
      const text = yield* res.value.text.pipe(Effect.orElseSucceed(() => ""));
      const parsed = decodeRemoteResolveResponse(text);
      if (Option.isNone(parsed)) return null;
      return {
        token: parsed.value.token,
        authMethod: parsed.value.authMethod,
        githubLogin: parsed.value.githubLogin,
        githubName: parsed.value.githubName,
        githubEmail: parsed.value.githubEmail,
        apiBaseUrl: parsed.value.apiBaseUrl,
      };
    },
  );

  const resolveActiveCredentialForChannel = Effect.fn(
    "TeamGitHubBroker.resolveActiveCredentialForChannel",
  )(function* (channel: SessionBrokerChannel): Effect.fn.Return<ResolvedBrokerCredential | null> {
    const nowMs = yield* Clock.currentTimeMillis;
    const leases = yield* Ref.get(activeTurnLeasesRef);
    let matchedLease: ActiveTurnLease | null = null;
    for (const candidate of leases.values()) {
      if (candidate.threadId !== channel.threadId) continue;
      if (candidate.revoked || candidate.expiresAtMs <= nowMs) continue;
      if (
        candidate.authorKind !== channel.authorKind ||
        candidate.authorMemberId !== channel.authorMemberId
      ) {
        continue;
      }
      if (
        candidate.providerSessionId !== null &&
        candidate.providerSessionId !== channel.providerSessionId
      ) {
        continue;
      }
      matchedLease = candidate;
      break;
    }
    if (matchedLease === null) return null;
    if (matchedLease.source.kind === "remote") {
      return yield* resolveRemoteLeaseFromServer(matchedLease);
    }
    return yield* resolveLocalCredential({
      teamId: matchedLease.source.teamId,
      authorKind: matchedLease.authorKind,
      authorMemberId: matchedLease.authorMemberId,
      expectedUpdatedAt: matchedLease.source.credentialUpdatedAt,
    });
  });

  const findChannelByToken = Effect.fn("TeamGitHubBroker.findChannelByToken")(function* (
    presentedToken: string,
  ): Effect.fn.Return<SessionBrokerChannel | null> {
    const channels = yield* Ref.get(channelsRef);
    for (const channel of channels.values()) {
      if (timingSafeStringEqual(presentedToken, channel.token)) {
        return channel;
      }
    }
    return null;
  });

  const revokeRemoteLeaseBestEffort = (lease: ActiveTurnLease) => {
    if (lease.source.kind !== "remote") return Effect.void;
    const { teamServerUrl, leaseId, leaseToken, environmentId } = lease.source;
    return Effect.gen(function* () {
      const client = Option.isSome(httpClientOption)
        ? httpClientOption.value
        : yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
      const req = HttpClientRequest.post(
        `${teamServerUrl.replace(/\/+$/, "")}/api/team/github-lease/revoke`,
      ).pipe(
        HttpClientRequest.bodyText(
          encodeJsonUnknown({
            leaseId,
            leaseToken,
            environmentId,
            threadId: lease.threadId,
            turnId: lease.turnId,
          }),
          "application/json",
        ),
      );
      yield* client
        .execute(req)
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.timeout("5 seconds"),
          Effect.ignore,
        );
    }).pipe(Effect.ignore);
  };

  // Start the private local broker listener (Unix socket on POSIX, loopback TCP on Windows).
  const listenerScope = yield* Scope.fork(yield* Effect.scope);
  const acquireListener = Effect.gen(function* () {
    const isUnixSocket = platform !== "win32";
    const owned = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const acquireDir = async (candidate: string) => {
            const parent = await NodeFSP.realpath(candidate);
            const stat = await NodeFSP.lstat(parent);
            if (isUnixSocket && uid !== undefined) {
              if (
                !stat.isDirectory() ||
                stat.isSymbolicLink() ||
                !(
                  (stat.uid === uid && (stat.mode & 0o022) === 0) ||
                  (stat.uid === 0 && ((stat.mode & 0o022) === 0 || (stat.mode & 0o1000) !== 0))
                )
              ) {
                throw new Error("Untrusted IPC parent directory");
              }
            }
            const directory = await NodeFSP.mkdtemp(NodePath.join(parent, "t3-gh-"));
            try {
              if (isUnixSocket) {
                await NodeFSP.chmod(directory, 0o700);
              }
              const socketPath = NodePath.join(directory, "s");
              if (isUnixSocket && Buffer.byteLength(socketPath) > UNIX_SOCKET_PATH_BYTES) {
                throw new Error("Unix socket path exceeds platform limit");
              }
              const binDir = NodePath.join(directory, "bin");
              const ghConfigDir = NodePath.join(directory, "gh-config");
              const askpassPath = NodePath.join(directory, "t3-git-askpass");
              const ghWrapperPath = NodePath.join(binDir, platform === "win32" ? "gh.cmd" : "gh");
              await NodeFSP.mkdir(binDir, { mode: 0o700 });
              await NodeFSP.mkdir(ghConfigDir, { mode: 0o700 });
              await NodeFSP.writeFile(askpassPath, buildGitAskpassScript(nodeExecPath), {
                encoding: "utf8",
                mode: 0o700,
              });
              const ghScript = buildGhWrapperScript(nodeExecPath, binDir, ghConfigDir);
              if (platform === "win32") {
                const ghJsPath = NodePath.join(binDir, "gh-wrapper.cjs");
                await NodeFSP.writeFile(ghJsPath, ghScript, { encoding: "utf8" });
                await NodeFSP.writeFile(
                  ghWrapperPath,
                  `@echo off\r\n"${nodeExecPath}" "${ghJsPath}" %*\r\n`,
                  { encoding: "utf8" },
                );
              } else {
                await NodeFSP.writeFile(ghWrapperPath, ghScript, {
                  encoding: "utf8",
                  mode: 0o700,
                });
              }
              return {
                directory,
                socketPath,
                binDir,
                ghConfigDir,
                askpassPath,
                ghWrapperPath,
              };
            } catch (error) {
              await NodeFSP.rm(directory, { recursive: true, force: true }).catch(() => undefined);
              throw error;
            }
          };
          return acquireDir(NodeOS.tmpdir()).catch(() => acquireDir("/tmp"));
        },
        catch: (cause) => new TeamGitHubBrokerStartError({ cause }),
      }),
      (owned) =>
        Effect.promise(async () => {
          await NodeFSP.rm(owned.directory, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }),
    );

    const brokerContext = yield* Effect.context<never>();
    const runBrokerEffect = Effect.runPromiseWith(brokerContext);
    const activeSockets = new Set<NodeNet.Socket>();
    const server = NodeHttp.createServer((req, res) => {
      if (!isLocalBrokerHttpRequest(req, isUnixSocket)) {
        writeJson(res, 403, { error: "forbidden_non_local_request" });
        return;
      }
      if (req.method !== "POST") {
        writeJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      const presentedToken = extractBearerToken(req.headers.authorization);
      if (presentedToken === null) {
        writeJson(res, 401, { error: "missing_broker_token" });
        return;
      }
      const pathname = (req.url ?? "").split("?")[0] ?? "";
      if (pathname !== "/v1/git-askpass" && pathname !== "/v1/gh-token") {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      void (async () => {
        const rawBody = await readHttpBody(req);
        if (rawBody === null) {
          writeJson(res, 413, { error: "request_body_too_large" });
          return;
        }
        const channel = await runBrokerEffect(findChannelByToken(presentedToken));
        if (channel === null) {
          writeJson(res, 401, { error: "invalid_broker_token" });
          return;
        }
        const resolved = await runBrokerEffect(resolveActiveCredentialForChannel(channel));
        if (resolved === null) {
          writeJson(res, 403, { error: "no_active_turn_credential" });
          return;
        }
        if (pathname === "/v1/git-askpass") {
          const parsed = rawBody.trim().length > 0 ? decodeAskpassRequest(rawBody) : Option.none();
          const prompt = Option.isSome(parsed) ? (parsed.value.prompt ?? "") : "";
          const value = /username/i.test(prompt)
            ? resolved.githubLogin || "x-access-token"
            : resolved.token;
          writeJson(res, 200, { value });
          return;
        }
        writeJson(res, 200, {
          token: resolved.token,
          authMethod: resolved.authMethod,
          githubLogin: resolved.githubLogin,
          githubName: resolved.githubName,
          githubEmail: resolved.githubEmail,
          apiBaseUrl: resolved.apiBaseUrl,
        });
      })().catch(() => {
        if (!res.headersSent) {
          writeJson(res, 500, { error: "broker_internal_error" });
        }
      });
    });

    server.on("connection", (socket) => {
      activeSockets.add(socket);
      socket.once("close", () => activeSockets.delete(socket));
    });
    server.on("error", () => {});

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        for (const socket of activeSockets) socket.destroy();
        activeSockets.clear();
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }),
    );

    const endpoint = yield* Effect.callback<string, TeamGitHubBrokerStartError>((resume) => {
      const onError = (cause: Error) =>
        resume(Effect.fail(new TeamGitHubBrokerStartError({ cause })));
      server.once("error", onError);
      try {
        if (isUnixSocket) {
          server.listen(owned.socketPath, () => {
            server.off("error", onError);
            resume(Effect.succeed(owned.socketPath));
          });
        } else {
          server.listen(0, "127.0.0.1", () => {
            server.off("error", onError);
            const addr = server.address();
            const port = typeof addr === "object" && addr !== null ? addr.port : 0;
            resume(Effect.succeed(`http://127.0.0.1:${port}`));
          });
        }
      } catch (cause) {
        server.off("error", onError);
        resume(Effect.fail(new TeamGitHubBrokerStartError({ cause })));
      }
      return Effect.sync(() => server.off("error", onError));
    });

    if (isUnixSocket) {
      yield* Effect.tryPromise({
        try: () => NodeFSP.chmod(owned.socketPath, 0o600),
        catch: (cause) => new TeamGitHubBrokerStartError({ cause }),
      });
    }

    return {
      endpoint,
      askpassPath: owned.askpassPath,
      binDir: owned.binDir,
      ghConfigDir: owned.ghConfigDir,
    };
  });

  const listenerResult = yield* acquireListener.pipe(Scope.provide(listenerScope), Effect.result);
  const listener =
    listenerResult._tag === "Success"
      ? listenerResult.success
      : yield* Scope.close(listenerScope, Exit.fail(listenerResult.failure)).pipe(Effect.as(null));

  const revokeTurnLease = Effect.fn("TeamGitHubBroker.revokeTurnLease")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId?: string | null;
  }) {
    const removedLeases: Array<ActiveTurnLease> = [];
    yield* Ref.update(activeTurnLeasesRef, (current) => {
      let changed = false;
      const next = new Map(current);
      for (const [key, lease] of next) {
        if (lease.threadId !== input.threadId) continue;
        if (input.turnId != null && lease.turnId !== input.turnId) continue;
        next.delete(key);
        removedLeases.push(lease);
        changed = true;
      }
      return changed ? next : current;
    });
    yield* Ref.update(remoteLeasesRef, (current) => {
      let changed = false;
      const next = new Map(current);
      for (const [leaseId, lease] of next) {
        if (lease.threadId !== input.threadId) continue;
        if (input.turnId != null && lease.turnId !== input.turnId) continue;
        next.delete(leaseId);
        changed = true;
      }
      return changed ? next : current;
    });
    if (removedLeases.length > 0) {
      yield* Effect.forEach(removedLeases, revokeRemoteLeaseBestEffort, { discard: true });
    }
  });

  const revokeMemberLeases = Effect.fn("TeamGitHubBroker.revokeMemberLeases")(function* (
    memberId: TeamMemberId,
  ) {
    yield* Ref.update(memberCredGenRef, (current) => {
      const next = new Map(current);
      next.set(memberId, (next.get(memberId) ?? 0) + 1);
      return next;
    });
    const removedLeases: Array<ActiveTurnLease> = [];
    yield* Ref.update(activeTurnLeasesRef, (current) => {
      let changed = false;
      const next = new Map(current);
      for (const [key, lease] of next) {
        if (lease.authorKind === "member" && lease.authorMemberId === memberId) {
          next.delete(key);
          removedLeases.push(lease);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    yield* Ref.update(remoteLeasesRef, (current) => {
      let changed = false;
      const next = new Map(current);
      for (const [leaseId, lease] of next) {
        if (lease.authorKind === "member" && lease.authorMemberId === memberId) {
          next.delete(leaseId);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    if (removedLeases.length > 0) {
      yield* Effect.forEach(removedLeases, revokeRemoteLeaseBestEffort, { discard: true });
    }
  });

  const revokeAutomationLeases = Effect.fn("TeamGitHubBroker.revokeAutomationLeases")(function* (
    teamId: TeamId,
  ) {
    yield* Ref.update(automationCredGenRef, (gen) => gen + 1);
    const removedLeases: Array<ActiveTurnLease> = [];
    yield* Ref.update(activeTurnLeasesRef, (current) => {
      let changed = false;
      const next = new Map(current);
      for (const [key, lease] of next) {
        if (
          lease.authorKind === "team_automation" &&
          (lease.source.kind !== "local" || lease.source.teamId === teamId)
        ) {
          next.delete(key);
          removedLeases.push(lease);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    yield* Ref.update(remoteLeasesRef, (current) => {
      let changed = false;
      const next = new Map(current);
      for (const [leaseId, lease] of next) {
        if (lease.authorKind === "team_automation" && lease.teamId === teamId) {
          next.delete(leaseId);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    if (removedLeases.length > 0) {
      yield* Effect.forEach(removedLeases, revokeRemoteLeaseBestEffort, { discard: true });
    }
  });

  // Wire directly into Milestone 4's registerTurnInterruptHook for immediate revocation on
  // admin/owner Interrupt and on creator Send now steering a foreign-authored active turn.
  if (Option.isSome(teamServiceOption)) {
    const unregisterInterrupt = yield* teamServiceOption.value.registerTurnInterruptHook(
      (event) => {
        if (event.reason === "promote_to_steer") {
          // Preserve lease only when the creator steers their own active turn;
          // immediately revoke when steering a foreign-authored or automation turn.
          if (
            event.activeTurnAuthorMemberId !== null &&
            event.activeTurnAuthorMemberId === event.actorMemberId
          ) {
            return Effect.void;
          }
          return revokeTurnLease({ threadId: event.threadId, turnId: event.runId });
        }
        return revokeTurnLease({ threadId: event.threadId, turnId: event.runId });
      },
    );
    const unregisterCredentialChange =
      yield* teamServiceOption.value.registerGitHubCredentialChangeHook((event) =>
        event.kind === "member"
          ? revokeMemberLeases(event.memberId)
          : revokeAutomationLeases(event.teamId),
      );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unregisterInterrupt();
        unregisterCredentialChange();
      }),
    );
  }

  const getCredentialGeneration = Effect.fn("TeamGitHubBroker.getCredentialGeneration")(
    function* (input: {
      readonly authorKind: TeamGitHubTurnAuthorKind;
      readonly authorMemberId: TeamMemberId | null;
    }) {
      if (input.authorKind === "team_automation") {
        return yield* Ref.get(automationCredGenRef);
      }
      if (input.authorMemberId === null) return 0;
      return (yield* Ref.get(memberCredGenRef)).get(input.authorMemberId) ?? 0;
    },
  );

  return TeamGitHubBroker.of({
    getEndpoint: Effect.fn("TeamGitHubBroker.getEndpoint")(() =>
      Effect.succeed(listener?.endpoint ?? null),
    ),

    getCredentialGeneration,

    getSessionCredentialGeneration: Effect.fn("TeamGitHubBroker.getSessionCredentialGeneration")(
      function* (providerSessionId) {
        const channels = yield* Ref.get(channelsRef);
        for (const channel of channels.values()) {
          if (channel.providerSessionId === providerSessionId) {
            return channel.credentialGeneration;
          }
        }
        return null;
      },
    ),

    prepareSessionEnvironment: Effect.fn("TeamGitHubBroker.prepareSessionEnvironment")(
      function* (input) {
        if (listener === null) return null;

        let identity: Pick<
          TeamGitHubIdentity,
          "githubLogin" | "githubName" | "githubEmail"
        > | null = input.identityOverride ?? null;

        if (identity === null && Option.isSome(githubRepoOption) && Option.isSome(teamRepoOption)) {
          const workspaceOpt = yield* teamRepoOption.value
            .getWorkspace()
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isSome(workspaceOpt)) {
            if (input.authorKind === "team_automation") {
              const autoOpt = yield* githubRepoOption.value
                .getAutomationCredential(workspaceOpt.value.id)
                .pipe(Effect.orElseSucceed(() => Option.none()));
              if (Option.isSome(autoOpt)) {
                identity = autoOpt.value;
              }
            } else if (input.authorMemberId !== null) {
              const memberOpt = yield* teamRepoOption.value
                .getMemberById(input.authorMemberId)
                .pipe(Effect.orElseSucceed(() => Option.none()));
              if (Option.isSome(memberOpt) && memberOpt.value.status === "active") {
                const credOpt = yield* githubRepoOption.value
                  .getMemberCredential(input.authorMemberId)
                  .pipe(Effect.orElseSucceed(() => Option.none()));
                if (Option.isSome(credOpt) && credOpt.value.teamId === workspaceOpt.value.id) {
                  identity = credOpt.value;
                }
              }
            }
          }
        }

        const credentialGeneration = yield* getCredentialGeneration({
          authorKind: input.authorKind,
          authorMemberId: input.authorMemberId,
        });
        const brokerToken = `t3ghs_${NodeCrypto.randomBytes(32).toString("base64url")}`;
        yield* Ref.update(channelsRef, (current) => {
          const next = new Map(current);
          for (const [existingToken, existingChannel] of next) {
            if (existingChannel.providerSessionId === input.providerSessionId) {
              next.delete(existingToken);
            }
          }
          next.set(brokerToken, {
            token: brokerToken,
            providerSessionId: input.providerSessionId,
            threadId: input.threadId,
            authorKind: input.authorKind,
            authorMemberId: input.authorMemberId,
            credentialGeneration,
          });
          return next;
        });

        const currentPath = hostEnv.PATH ?? "";
        const pathEntries = currentPath
          .split(NodePath.delimiter)
          .filter(
            (entry) =>
              entry.length > 0 && NodePath.resolve(entry) !== NodePath.resolve(listener.binDir),
          );
        const mergedPath = [listener.binDir, ...pathEntries].join(NodePath.delimiter);

        const env: Record<string, string> = {
          [TEAM_GH_BROKER_ENDPOINT_ENV]: listener.endpoint,
          [TEAM_GH_BROKER_TOKEN_ENV]: brokerToken,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: listener.askpassPath,
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "credential.helper",
          GIT_CONFIG_VALUE_0: "",
          GIT_CONFIG_KEY_1: "core.askPass",
          GIT_CONFIG_VALUE_1: listener.askpassPath,
          GH_CONFIG_DIR: listener.ghConfigDir,
          GH_PROMPT_DISABLED: "1",
          PATH: mergedPath,
        };

        if (identity !== null) {
          const authorName = identity.githubName?.trim() || identity.githubLogin;
          const authorEmail =
            identity.githubEmail?.trim() || `${identity.githubLogin}@users.noreply.github.com`;
          env.GIT_AUTHOR_NAME = authorName;
          env.GIT_AUTHOR_EMAIL = authorEmail;
          env.GIT_COMMITTER_NAME = authorName;
          env.GIT_COMMITTER_EMAIL = authorEmail;
        }

        return env;
      },
    ),

    revokeSessionChannel: Effect.fn("TeamGitHubBroker.revokeSessionChannel")(
      function* (providerSessionId) {
        yield* Ref.update(channelsRef, (current) => {
          let changed = false;
          const next = new Map(current);
          for (const [token, channel] of next) {
            if (channel.providerSessionId === providerSessionId) {
              next.delete(token);
              changed = true;
            }
          }
          return changed ? next : current;
        });
        const removedLeases: Array<ActiveTurnLease> = [];
        yield* Ref.update(activeTurnLeasesRef, (current) => {
          let changed = false;
          const next = new Map(current);
          for (const [key, lease] of next) {
            if (lease.providerSessionId === providerSessionId) {
              next.delete(key);
              removedLeases.push(lease);
              changed = true;
            }
          }
          return changed ? next : current;
        });
        if (removedLeases.length > 0) {
          yield* Effect.forEach(removedLeases, revokeRemoteLeaseBestEffort, { discard: true });
        }
      },
    ),

    activateLocalTurnLease: Effect.fn("TeamGitHubBroker.activateLocalTurnLease")(function* (input) {
      if (Option.isNone(teamRepoOption)) return;
      const workspaceOpt = yield* teamRepoOption.value
        .getWorkspace()
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(workspaceOpt)) return;
      const teamId = workspaceOpt.value.id;

      let credentialUpdatedAt: string | null = null;
      if (Option.isSome(githubRepoOption)) {
        if (input.authorKind === "team_automation") {
          const autoOpt = yield* githubRepoOption.value
            .getAutomationCredential(teamId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          credentialUpdatedAt = Option.isSome(autoOpt) ? autoOpt.value.updatedAt : null;
        } else if (input.authorMemberId !== null) {
          const memberCredOpt = yield* githubRepoOption.value
            .getMemberCredential(input.authorMemberId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          credentialUpdatedAt =
            Option.isSome(memberCredOpt) && memberCredOpt.value.teamId === teamId
              ? memberCredOpt.value.updatedAt
              : null;
        }
      }

      const nowMs = yield* Clock.currentTimeMillis;
      const ttlMs = Math.max(1_000, input.ttlMs ?? DEFAULT_TURN_LEASE_TTL_MS);
      const lease: ActiveTurnLease = {
        threadId: input.threadId,
        turnId: input.turnId,
        providerSessionId: input.providerSessionId,
        authorKind: input.authorKind,
        authorMemberId: input.authorMemberId,
        expiresAtMs: nowMs + ttlMs,
        revoked: false,
        source: {
          kind: "local",
          teamId,
          credentialUpdatedAt,
        },
      };

      yield* Ref.update(activeTurnLeasesRef, (current) => {
        const next = new Map(current);
        for (const [key, existing] of next) {
          if (existing.threadId === input.threadId) {
            next.delete(key);
          }
        }
        next.set(turnLeaseKey(input.threadId, input.turnId), lease);
        return next;
      });
    }),

    activateRemoteTurnLease: Effect.fn("TeamGitHubBroker.activateRemoteTurnLease")(
      function* (input) {
        const expiresAtMs = Date.parse(input.expiresAt);
        const nowMs = yield* Clock.currentTimeMillis;
        const lease: ActiveTurnLease = {
          threadId: input.threadId,
          turnId: input.turnId,
          providerSessionId: input.providerSessionId,
          authorKind: input.authorKind,
          authorMemberId: input.authorMemberId,
          expiresAtMs: Number.isFinite(expiresAtMs)
            ? expiresAtMs
            : nowMs + DEFAULT_TURN_LEASE_TTL_MS,
          revoked: false,
          source: {
            kind: "remote",
            teamServerUrl: input.teamServerUrl,
            environmentId: input.environmentId,
            leaseId: input.leaseId,
            leaseToken: input.leaseToken,
          },
        };
        yield* Ref.update(activeTurnLeasesRef, (current) => {
          const next = new Map(current);
          for (const [key, existing] of next) {
            if (existing.threadId === input.threadId) {
              next.delete(key);
            }
          }
          next.set(turnLeaseKey(input.threadId, input.turnId), lease);
          return next;
        });
      },
    ),

    revokeTurnLease,
    revokeMemberLeases,
    revokeAutomationLeases,

    hasActiveTurnLease: Effect.fn("TeamGitHubBroker.hasActiveTurnLease")(function* (input) {
      const nowMs = yield* Clock.currentTimeMillis;
      const leases = yield* Ref.get(activeTurnLeasesRef);
      for (const lease of leases.values()) {
        if (lease.threadId !== input.threadId) continue;
        if (input.turnId != null && lease.turnId !== input.turnId) continue;
        if (!lease.revoked && lease.expiresAtMs > nowMs) return true;
      }
      const remoteLeases = yield* Ref.get(remoteLeasesRef);
      for (const lease of remoteLeases.values()) {
        if (lease.threadId !== input.threadId) continue;
        if (input.turnId != null && lease.turnId !== input.turnId) continue;
        if (!lease.revoked && lease.expiresAtMs > nowMs) return true;
      }
      return false;
    }),

    issueRemoteTurnLease: Effect.fn("TeamGitHubBroker.issueRemoteTurnLease")(function* (input) {
      if (Option.isNone(githubRepoOption) || Option.isNone(secretsOption)) {
        return {
          hasCredential: false,
          leaseId: null,
          leaseToken: null,
          expiresAt: null,
          identity: null,
        } satisfies TeamGitHubRemoteLeaseIssueResponse;
      }

      let identity: TeamGitHubIdentity | null = null;
      let credentialUpdatedAt: string | null = null;
      if (input.authorKind === "team_automation") {
        const autoOpt = yield* githubRepoOption.value
          .getAutomationCredential(input.teamId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isSome(autoOpt)) {
          identity = TeamGitHubRepository.stripAutomationGitHubSecretKey(autoOpt.value);
          credentialUpdatedAt = autoOpt.value.updatedAt;
        }
      } else if (input.authorMemberId !== null) {
        if (Option.isSome(teamRepoOption)) {
          const memberOpt = yield* teamRepoOption.value
            .getMemberById(input.authorMemberId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (
            Option.isNone(memberOpt) ||
            memberOpt.value.teamId !== input.teamId ||
            memberOpt.value.status !== "active"
          ) {
            return {
              hasCredential: false,
              leaseId: null,
              leaseToken: null,
              expiresAt: null,
              identity: null,
            } satisfies TeamGitHubRemoteLeaseIssueResponse;
          }
        }
        const memberCredOpt = yield* githubRepoOption.value
          .getMemberCredential(input.authorMemberId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isSome(memberCredOpt) && memberCredOpt.value.teamId === input.teamId) {
          identity = TeamGitHubRepository.stripMemberGitHubSecretKey(memberCredOpt.value);
          credentialUpdatedAt = memberCredOpt.value.updatedAt;
        }
      }

      if (identity === null || credentialUpdatedAt === null) {
        return {
          hasCredential: false,
          leaseId: null,
          leaseToken: null,
          expiresAt: null,
          identity: null,
        } satisfies TeamGitHubRemoteLeaseIssueResponse;
      }

      const nowMs = yield* Clock.currentTimeMillis;
      const ttlMs = Math.max(
        1_000,
        Math.min(input.ttlMs ?? DEFAULT_TURN_LEASE_TTL_MS, 60 * 60 * 1000),
      );
      const expiresAtMs = nowMs + ttlMs;
      const expiresAt = IsoDateTime.make(DateTime.formatIso(DateTime.makeUnsafe(expiresAtMs)));
      const leaseId = `ghlease_${NodeCrypto.randomUUID()}`;
      const leaseToken = `t3ghl_${NodeCrypto.randomBytes(32).toString("base64url")}`;

      const record: IssuedRemoteTurnLease = {
        leaseId,
        leaseTokenHash: sha256Hex(leaseToken),
        teamId: input.teamId,
        environmentId: input.environmentId,
        threadId: input.threadId,
        turnId: input.turnId,
        authorKind: input.authorKind,
        authorMemberId: input.authorMemberId,
        credentialUpdatedAt,
        expiresAt,
        expiresAtMs,
        revoked: false,
      };

      yield* Ref.update(remoteLeasesRef, (current) => {
        const next = new Map(current);
        for (const [existingId, existing] of next) {
          if (
            existing.expiresAtMs <= nowMs ||
            (existing.environmentId === input.environmentId &&
              existing.threadId === input.threadId &&
              existing.turnId === input.turnId)
          ) {
            next.delete(existingId);
          }
        }
        next.set(leaseId, record);
        return next;
      });

      return {
        hasCredential: true,
        leaseId,
        leaseToken,
        expiresAt,
        identity,
      } satisfies TeamGitHubRemoteLeaseIssueResponse;
    }),

    resolveRemoteTurnLease: Effect.fn("TeamGitHubBroker.resolveRemoteTurnLease")(function* (input) {
      const nowMs = yield* Clock.currentTimeMillis;
      const leases = yield* Ref.get(remoteLeasesRef);
      const lease = leases.get(input.leaseId);
      if (lease === undefined || lease.revoked || lease.expiresAtMs <= nowMs) {
        return null;
      }
      if (
        lease.environmentId !== input.environmentId ||
        lease.threadId !== input.threadId ||
        lease.turnId !== input.turnId
      ) {
        return null;
      }
      if (!timingSafeStringEqual(sha256Hex(input.leaseToken), lease.leaseTokenHash)) {
        return null;
      }
      const resolved = yield* resolveLocalCredential({
        teamId: lease.teamId,
        authorKind: lease.authorKind,
        authorMemberId: lease.authorMemberId,
        expectedUpdatedAt: lease.credentialUpdatedAt,
      });
      if (resolved === null) {
        return null;
      }
      return {
        token: resolved.token,
        authMethod: resolved.authMethod,
        githubLogin: resolved.githubLogin,
        githubName: resolved.githubName,
        githubEmail: resolved.githubEmail,
        apiBaseUrl: resolved.apiBaseUrl,
        expiresAt: lease.expiresAt,
      } satisfies TeamGitHubRemoteLeaseResolveResponse;
    }),

    revokeRemoteTurnLease: Effect.fn("TeamGitHubBroker.revokeRemoteTurnLease")(function* (input) {
      if (
        input.leaseId === undefined &&
        input.environmentId === undefined &&
        input.threadId === undefined &&
        input.turnId === undefined
      ) {
        return false;
      }
      const presentedTokenHash =
        input.leaseToken !== undefined ? sha256Hex(input.leaseToken) : null;
      let revokedAny = false;
      yield* Ref.update(remoteLeasesRef, (current) => {
        const next = new Map(current);
        for (const [leaseId, lease] of next) {
          if (input.leaseId !== undefined && lease.leaseId !== input.leaseId) continue;
          if (input.environmentId !== undefined && lease.environmentId !== input.environmentId)
            continue;
          if (input.threadId !== undefined && lease.threadId !== input.threadId) continue;
          if (input.turnId !== undefined && lease.turnId !== input.turnId) continue;
          if (
            presentedTokenHash !== null &&
            !timingSafeStringEqual(presentedTokenHash, lease.leaseTokenHash)
          ) {
            continue;
          }
          if (
            input.authorizedMemberId !== undefined &&
            (lease.authorKind !== "member" || lease.authorMemberId !== input.authorizedMemberId)
          ) {
            continue;
          }
          next.delete(leaseId);
          revokedAny = true;
        }
        return revokedAny ? next : current;
      });
      return revokedAny;
    }),
  });
});

export const layer = Layer.effect(TeamGitHubBroker, make);
