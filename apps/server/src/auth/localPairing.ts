import * as NodeCrypto from "node:crypto";

import type { LocalServerPairingChallenge, LocalServerPairingResult } from "@t3tools/contracts";
import {
  isCanonicalLoopbackHostname,
  isContainedChallengePath,
  LOCAL_SERVER_CHALLENGE_MAX_BYTES,
  LOCAL_SERVER_CHALLENGE_NONCE_BYTES,
  resolveLocalServerChallengeDirectory,
} from "@t3tools/shared/localServerDiscovery";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { LocalServerDiscoveryState } from "../localServerDiscoveryState.ts";
import { buildPairingUrl } from "../startupAccess.ts";

/** Hex-encoded, so twice the byte count. */
const MINIMUM_NONCE_LENGTH = LOCAL_SERVER_CHALLENGE_NONCE_BYTES * 2;
const CHALLENGE_FILE_MODE = 0o600;

export type LocalPairingRejectionReason =
  | "discovery_inactive"
  | "remote_not_loopback"
  | "instance_mismatch"
  | "challenge_directory_unavailable"
  | "challenge_path_unresolvable"
  | "challenge_path_escapes_directory"
  | "challenge_not_regular_file"
  | "challenge_owner_mismatch"
  | "challenge_mode_mismatch"
  | "challenge_too_large"
  | "nonce_too_short"
  | "challenge_unreadable"
  | "nonce_mismatch";

function timingSafeEqualUtf8(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  // `timingSafeEqual` throws on unequal lengths, so the length comparison has
  // to happen first. It leaks only the nonce length, never its contents.
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return NodeCrypto.timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Build the `/api/auth/local-pair` validator.
 *
 * This is the one credential-issuing path that is not behind
 * `requireEnvironmentScope`, because it is how a same-user local client
 * bootstraps its very first credential. Authorization is instead proof that the
 * caller can create a file inside the server owner's 0700 `XDG_RUNTIME_DIR`,
 * which no other local user can do.
 *
 * Every check fails closed and the issuer returns `null` for all of them so the
 * HTTP response cannot be used to probe which one tripped.
 */
export const makeLocalServerPairingIssuer = Effect.gen(function* () {
  const discoveryState = yield* LocalServerDiscoveryState;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

  const reject = (reason: LocalPairingRejectionReason) =>
    Effect.logDebug("local pairing challenge rejected", { reason }).pipe(Effect.as(null));

  return Effect.fn("server.localPair.issue")(function* (input: {
    readonly challenge: LocalServerPairingChallenge;
    readonly remoteAddress: string | undefined;
  }) {
    // 1. Local discovery must actually be running in this process, and the
    //    request must have arrived over loopback.
    const discovery = yield* discoveryState.current;
    if (discovery === null) {
      return yield* reject("discovery_inactive");
    }
    const remoteAddress = input.remoteAddress?.trim();
    if (
      remoteAddress === undefined ||
      remoteAddress.length === 0 ||
      !isCanonicalLoopbackHostname(remoteAddress)
    ) {
      return yield* reject("remote_not_loopback");
    }

    // 2. The caller must be talking to the instance it discovered. `instanceId`
    //    is public-to-this-user metadata, so a plain comparison is fine.
    if (input.challenge.instanceId !== discovery.instanceId) {
      return yield* reject("instance_mismatch");
    }

    // 3. The challenge file must live directly inside our challenge directory.
    //    Both sides are canonicalized so a symlink cannot escape it.
    const challengeDirectory = resolveLocalServerChallengeDirectory({
      platform: discovery.platform,
      xdgRuntimeDirectory: discovery.xdgRuntimeDirectory,
      path,
    });
    if (challengeDirectory === null) {
      return yield* reject("challenge_directory_unavailable");
    }
    const canonicalChallengeDirectory = yield* fileSystem
      .realPath(challengeDirectory)
      .pipe(Effect.option);
    if (Option.isNone(canonicalChallengeDirectory)) {
      return yield* reject("challenge_directory_unavailable");
    }
    const canonicalChallengePath = yield* fileSystem
      .realPath(input.challenge.challengePath)
      .pipe(Effect.option);
    if (Option.isNone(canonicalChallengePath)) {
      return yield* reject("challenge_path_unresolvable");
    }
    if (
      !isContainedChallengePath({
        canonicalChallengePath: canonicalChallengePath.value,
        canonicalChallengeDirectory: canonicalChallengeDirectory.value,
        path,
      })
    ) {
      return yield* reject("challenge_path_escapes_directory");
    }

    // 4. It must be a regular file we own, private to us, and small.
    const info = yield* fileSystem.stat(canonicalChallengePath.value).pipe(Effect.option);
    if (Option.isNone(info)) {
      return yield* reject("challenge_path_unresolvable");
    }
    if (info.value.type !== "File") {
      return yield* reject("challenge_not_regular_file");
    }
    const processUid = process.getuid?.();
    const fileUid = Option.getOrUndefined(info.value.uid);
    if (processUid === undefined || fileUid === undefined || fileUid !== processUid) {
      return yield* reject("challenge_owner_mismatch");
    }
    if ((info.value.mode & 0o777) !== CHALLENGE_FILE_MODE) {
      return yield* reject("challenge_mode_mismatch");
    }
    if (info.value.size > BigInt(LOCAL_SERVER_CHALLENGE_MAX_BYTES)) {
      return yield* reject("challenge_too_large");
    }

    // 5. Its contents must equal the presented nonce, compared in constant time.
    const nonce = input.challenge.nonce.trim();
    if (nonce.length < MINIMUM_NONCE_LENGTH) {
      return yield* reject("nonce_too_short");
    }
    const contents = yield* fileSystem
      .readFileString(canonicalChallengePath.value)
      .pipe(Effect.option);
    if (Option.isNone(contents)) {
      return yield* reject("challenge_unreadable");
    }
    if (!timingSafeEqualUtf8(contents.value.trim(), nonce)) {
      return yield* reject("nonce_mismatch");
    }

    // 6. Proven. Issue a fresh pairing credential; nothing was ever on disk.
    //    The challenge file belongs to the client, so we leave it alone.
    const issued = yield* serverAuth.issueStartupPairingCredential();
    return {
      pairingUrl: buildPairingUrl(discovery.httpBaseUrl, issued.credential),
      pairingExpiresAt: DateTime.formatIso(issued.expiresAt),
    } satisfies LocalServerPairingResult;
  });
});
