/**
 * Reads Claude's OAuth access token and pulls account quota usage.
 *
 * This is the one place the server touches Claude's credentials. Everywhere
 * else we shell out to the `claude` CLI and let it own its auth, but the CLI
 * has no `usage` subcommand, so a usage reading means calling the endpoint
 * ourselves with the token the CLI already stored.
 *
 * The endpoint reports quota utilization *without* spending message quota,
 * which is what makes it safe to call on ambient triggers.
 *
 * Every failure mode here — no credentials file, a locked keychain, an
 * expired token, a network blip — resolves to `null`. Usage meters are
 * ambient: the correct response to "we could not read your usage" is to draw
 * nothing, never to surface an error the user cannot act on.
 *
 * @module claudeUsageFetch
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { spawnAndCollect } from "./providerSnapshot.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// The usage endpoint is gated behind this beta opt-in.
const OAUTH_USAGE_BETA = "oauth-2025-04-20";
const USAGE_REQUEST_TIMEOUT_MS = 10_000;
const KEYCHAIN_TIMEOUT_MS = 5_000;

// The keychain entry Claude Code writes on macOS.
const KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * Total by construction: a truncated or non-JSON credentials file is a "no
 * token available" answer, not a crash.
 *
 * An expired token is also "no token": we only ever read credentials, never
 * refresh them, so re-sending a known-dead bearer every minute would just
 * generate 401s until the CLI happens to renew it.
 */
export const readAccessToken = (raw: string, nowMillis: number): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const envelope = parsed as { readonly claudeAiOauth?: unknown };
  const credentials =
    typeof envelope.claudeAiOauth === "object" && envelope.claudeAiOauth !== null
      ? (envelope.claudeAiOauth as {
          readonly accessToken?: unknown;
          readonly expiresAt?: unknown;
        })
      : (parsed as { readonly accessToken?: unknown; readonly expiresAt?: unknown });
  const accessToken = credentials.accessToken;
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    return null;
  }
  // Absent or unparseable `expiresAt` means "assume usable" — the endpoint
  // is the real authority and a 401 already degrades to blank meters.
  //
  // The stamp arrives in either epoch flavour depending on which CLI version
  // wrote the file, and the 1e12 split is the same one `readIsoTimestamp`
  // uses. Reading seconds as milliseconds would date every token to 1970 and
  // permanently report "no token", which looks identical to being logged out.
  const expiresAt = credentials.expiresAt;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
    const expiresAtMillis = expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
    if (expiresAtMillis <= nowMillis) {
      return null;
    }
  }
  return accessToken;
};

/**
 * On macOS the credentials live in the login keychain rather than on disk.
 * `security` prompts interactively when the keychain is locked, so this call
 * is bounded — a hung prompt must not wedge a refresh.
 */
const readTokenFromKeychain = Effect.fn("readClaudeTokenFromKeychain")(function* (
  nowMillis: number,
) {
  const result = yield* spawnAndCollect(
    "security",
    ChildProcess.make("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]),
  );
  if (result.code !== 0) {
    return null;
  }
  return readAccessToken(result.stdout.trim(), nowMillis);
});

/**
 * Resolve the OAuth access token for one Claude config directory.
 *
 * `configDir` is the directory the CLI itself would use for this instance —
 * multi-instance setups point at different directories and must not read
 * each other's tokens.
 *
 * `allowKeychain` gates the macOS fallback. That keychain item is a single
 * global entry with no instance identity, so it may only stand in for an
 * instance that has no config-dir override of its own; using it for a
 * scoped instance would silently authenticate as a different account.
 */
export const readClaudeAccessToken = Effect.fn("readClaudeAccessToken")(function* (
  configDir: string,
  options: { readonly allowKeychain: boolean },
): Effect.fn.Return<
  string | null,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const nowMillis = yield* Effect.clockWith((clock) => clock.currentTimeMillis);

  const credentialsPath = path.join(configDir, ".credentials.json");
  const fromFile = yield* fileSystem.readFileString(credentialsPath).pipe(
    Effect.map((raw) => readAccessToken(raw, nowMillis)),
    Effect.orElseSucceed(() => null),
  );
  if (fromFile !== null) {
    return fromFile;
  }

  if (!options.allowKeychain) {
    return null;
  }
  const platform = yield* HostProcessPlatform;
  if (platform !== "darwin") {
    return null;
  }
  return yield* readTokenFromKeychain(nowMillis).pipe(
    Effect.timeoutOption(KEYCHAIN_TIMEOUT_MS),
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed(() => null),
  );
});

/**
 * Fetch the raw usage payload. Returns `null` on any non-2xx, timeout, or
 * transport failure; callers keep their last-known reading rather than
 * blanking the meters.
 */
export const fetchClaudeUsage = Effect.fn("fetchClaudeUsage")(function* (
  accessToken: string,
): Effect.fn.Return<unknown, never, HttpClient.HttpClient> {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(USAGE_URL).pipe(
    HttpClientRequest.bearerToken(accessToken),
    HttpClientRequest.setHeader("anthropic-beta", OAUTH_USAGE_BETA),
    HttpClientRequest.setHeader("accept", "application/json"),
  );
  // The timeout has to cover the body too. A server that sends 2xx headers
  // and then trickles the body would satisfy a timeout scoped to `execute`
  // alone and leave this fiber parked on `json` forever.
  const payload = yield* client.execute(request).pipe(
    Effect.flatMap((httpResponse) =>
      httpResponse.status < 200 || httpResponse.status >= 300
        ? Effect.succeed(null)
        : httpResponse.json,
    ),
    Effect.timeoutOption(USAGE_REQUEST_TIMEOUT_MS),
    Effect.orElseSucceed(() => Option.none<unknown>()),
  );
  return Option.getOrNull(payload);
});
