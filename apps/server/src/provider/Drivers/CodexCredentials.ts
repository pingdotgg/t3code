import type { CodexSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveCodexHomeLayout, withCodexEnvironmentHome } from "./CodexHomeLayout.ts";

const CodexAuthJsonSchema = Schema.Struct({
  tokens: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        account_id: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  OPENAI_API_KEY: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const decodeCodexAuthJson = Schema.decodeUnknownOption(Schema.fromJsonString(CodexAuthJsonSchema));

const sha256Hex = Effect.fn("CodexCredentials.sha256Hex")(function* (text: string) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
});

export const resolveEffectiveCodexAuthJsonPath = Effect.fn("resolveEffectiveCodexAuthJsonPath")(
  function* (config: CodexSettings, processEnv?: NodeJS.ProcessEnv) {
    const path = yield* Path.Path;
    const environment = processEnv ?? (yield* HostProcess.Environment);
    const layout = yield* resolveCodexHomeLayout(
      withCodexEnvironmentHome(config, environment.CODEX_HOME),
    );
    const effectiveDir = layout.effectiveHomePath ?? layout.sharedHomePath;
    return path.join(effectiveDir, "auth.json");
  },
);

export const resolveCodexCredentialFingerprint = Effect.fn("resolveCodexCredentialFingerprint")(
  function* (config: CodexSettings, processEnv?: NodeJS.ProcessEnv) {
    const authJsonPath = yield* resolveEffectiveCodexAuthJsonPath(config, processEnv);
    const fileSystem = yield* FileSystem.FileSystem;
    const content = yield* fileSystem.readFileString(authJsonPath).pipe(Effect.option);
    if (Option.isNone(content)) {
      // null: the file credential is missing — `codex logout` and keyring saves both
      // unlink auth.json, so a string → null transition is a real swap signal; under
      // keyring|auto a missing file may also mean keyring-held credentials this probe
      // cannot see. undefined: any other read failure carries no signal — callers keep.
      const exists = yield* fileSystem.exists(authJsonPath).pipe(Effect.orElseSucceed(() => true));
      return exists ? undefined : null;
    }
    const decoded = Option.flatMap(content, decodeCodexAuthJson);
    const authJson = Option.getOrUndefined(decoded);
    if (authJson === undefined) {
      return undefined;
    }
    const accountId = authJson.tokens?.account_id;
    if (accountId !== undefined && accountId.length > 0) {
      return yield* sha256Hex(`codex:chatgpt\0${accountId}`);
    }
    const apiKey = authJson.OPENAI_API_KEY;
    if (apiKey !== null && apiKey !== undefined && apiKey.trim().length > 0) {
      return yield* sha256Hex(`codex:api_key\0${apiKey.trim()}`);
    }
    return null;
  },
  // Only for the final catch-all: defects on the read path surface as unobservable (undefined),
  // which the caller treats as "no signal" rather than logged-out.
  // @effect-diagnostics-next-line effectSucceedWithVoid:off - undefined is distinct here from the wider void Effect.void carries.
  Effect.catchCause(() => Effect.succeed<string | null | undefined>(undefined)),
);
