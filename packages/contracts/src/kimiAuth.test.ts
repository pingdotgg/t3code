import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  KimiAuthDeniedError,
  KimiAuthError,
  KimiAuthExpiredError,
  KimiAuthInstanceInvalidError,
  KimiAuthRequestError,
  KimiCredentialRemoveError,
  KimiCredentialWriteError,
} from "./kimiAuth.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const isKimiAuthError = Schema.is(KimiAuthError);

it("preserves request causes separately from bounded context", () => {
  const cause = new Error("sensitive transport detail");
  const error = new KimiAuthRequestError({
    operation: "token-poll",
    status: 503,
    oauthErrorCode: "temporarily_unavailable",
    cause,
  });

  expect(error.status).toBe(503);
  expect(error.oauthErrorCode).toBe("temporarily_unavailable");
  expect(error.cause).toBe(cause);
  expect(error.message).toBe("Failed to poll Kimi device authorization.");
  expect(isKimiAuthError(error)).toBe(true);
});

it("uses distinct tagged errors for distinct authentication failures", () => {
  const instanceId = ProviderInstanceId.make("kimi_work");
  const errors = [
    new KimiAuthDeniedError(),
    new KimiAuthExpiredError(),
    new KimiCredentialWriteError({
      credentialsPath: "/tmp/kimi-code.json",
      cause: new Error("write failed"),
    }),
    new KimiCredentialRemoveError({
      credentialsPath: "/tmp/kimi-code.json",
      cause: new Error("remove failed"),
    }),
    new KimiAuthInstanceInvalidError({ instanceId, issue: "not-found" }),
  ];

  expect(errors.map((error) => error._tag)).toEqual([
    "KimiAuthDeniedError",
    "KimiAuthExpiredError",
    "KimiCredentialWriteError",
    "KimiCredentialRemoveError",
    "KimiAuthInstanceInvalidError",
  ]);
  expect(errors.every(isKimiAuthError)).toBe(true);
});
