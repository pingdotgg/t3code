import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  initialLoginState,
  isTerminalLoginState,
  loginIdOf,
  loginStartParams,
  loginStateSignInEvent,
  nextLoginState,
  type CodexLoginState,
} from "./codexLoginState.ts";

const browserResponse = {
  type: "chatgpt",
  loginId: "login-1",
  authUrl: "https://auth.openai.com/oauth?state=abc",
} as const;

const deviceResponse = {
  type: "chatgptDeviceCode",
  loginId: "login-2",
  userCode: "ABCD-EFGHI",
  verificationUrl: "https://auth.openai.com/device",
} as const;

describe("loginStartParams", () => {
  it("maps each sign-in mode to its codex login type", () => {
    NodeAssert.deepStrictEqual(loginStartParams("browser"), { type: "chatgpt" });
    NodeAssert.deepStrictEqual(loginStartParams("deviceCode"), { type: "chatgptDeviceCode" });
  });
});

describe("nextLoginState", () => {
  it("moves to awaitingBrowser on a chatgpt start response", () => {
    const state = nextLoginState(initialLoginState, {
      _tag: "loginStartResponse",
      response: browserResponse,
    });

    NodeAssert.deepStrictEqual(state, {
      _tag: "awaitingBrowser",
      loginId: "login-1",
      authUrl: "https://auth.openai.com/oauth?state=abc",
    });
    NodeAssert.equal(loginIdOf(state), "login-1");
  });

  it("moves to awaitingDeviceCode on a device-code start response", () => {
    const state = nextLoginState(initialLoginState, {
      _tag: "loginStartResponse",
      response: deviceResponse,
    });

    NodeAssert.deepStrictEqual(state, {
      _tag: "awaitingDeviceCode",
      loginId: "login-2",
      userCode: "ABCD-EFGHI",
      verificationUrl: "https://auth.openai.com/device",
    });
  });

  it("fails closed on a login type we never request", () => {
    for (const type of ["apiKey", "chatgptAuthTokens", "amazonBedrock"] as const) {
      const state = nextLoginState(initialLoginState, {
        _tag: "loginStartResponse",
        response: { type },
      });

      NodeAssert.equal(state._tag, "failed");
      NodeAssert.match(
        state._tag === "failed" ? state.message : "",
        new RegExp(`unsupported sign-in type: ${type}`),
      );
    }
  });

  it("accepts a completed notification that races ahead of the start response", () => {
    const state = nextLoginState(initialLoginState, {
      _tag: "loginCompletedNotification",
      notification: { success: true },
    });

    NodeAssert.deepStrictEqual(state, { _tag: "completed" });
  });

  it("carries the notification error into the failed message", () => {
    const state = nextLoginState(
      { _tag: "awaitingDeviceCode", loginId: "login-2", userCode: "X", verificationUrl: "u" },
      {
        _tag: "loginCompletedNotification",
        notification: { success: false, error: "the code expired" },
      },
    );

    NodeAssert.deepStrictEqual(state, { _tag: "failed", message: "the code expired" });
  });

  it("falls back to a generic message when a failure carries no error", () => {
    const state = nextLoginState(initialLoginState, {
      _tag: "loginCompletedNotification",
      notification: { success: false, error: null },
    });

    NodeAssert.deepStrictEqual(state, { _tag: "failed", message: "Sign-in did not complete." });
  });

  it("ignores a notification for a different loginId", () => {
    const awaiting: CodexLoginState = {
      _tag: "awaitingBrowser",
      loginId: "login-1",
      authUrl: "https://auth.openai.com/oauth",
    };

    const state = nextLoginState(awaiting, {
      _tag: "loginCompletedNotification",
      notification: { success: true, loginId: "login-other" },
    });

    NodeAssert.deepStrictEqual(state, awaiting);
  });

  it("accepts a notification with no loginId while awaiting one", () => {
    const state = nextLoginState(
      { _tag: "awaitingBrowser", loginId: "login-1", authUrl: "https://auth.openai.com/oauth" },
      { _tag: "loginCompletedNotification", notification: { success: true } },
    );

    NodeAssert.deepStrictEqual(state, { _tag: "completed" });
  });

  it("turns an abort into a failure carrying the detail", () => {
    const state = nextLoginState(initialLoginState, {
      _tag: "aborted",
      detail: "codex app-server exited: ENOENT",
    });

    NodeAssert.deepStrictEqual(state, {
      _tag: "failed",
      message: "codex app-server exited: ENOENT",
    });
  });

  it("turns a timeout into a failure", () => {
    const state = nextLoginState(initialLoginState, { _tag: "timedOut" });

    NodeAssert.equal(state._tag, "failed");
    NodeAssert.match(state._tag === "failed" ? state.message : "", /Timed out/);
  });

  it("treats completed and failed as absorbing", () => {
    const completed: CodexLoginState = { _tag: "completed" };
    const failed: CodexLoginState = { _tag: "failed", message: "nope" };

    for (const terminal of [completed, failed]) {
      NodeAssert.equal(isTerminalLoginState(terminal), true);
      NodeAssert.deepStrictEqual(
        nextLoginState(terminal, { _tag: "aborted", detail: "process exited" }),
        terminal,
      );
      NodeAssert.deepStrictEqual(nextLoginState(terminal, { _tag: "timedOut" }), terminal);
      NodeAssert.deepStrictEqual(
        nextLoginState(terminal, {
          _tag: "loginCompletedNotification",
          notification: { success: false, error: "late" },
        }),
        terminal,
      );
    }
  });

  it("has no loginId to cancel before the start response lands", () => {
    NodeAssert.equal(loginIdOf(initialLoginState), undefined);
    NodeAssert.equal(loginIdOf({ _tag: "completed" }), undefined);
  });
});

describe("loginStateSignInEvent", () => {
  it("emits nothing for the starting state", () => {
    NodeAssert.equal(loginStateSignInEvent(initialLoginState), null);
  });

  it("maps each observable state onto its wire event", () => {
    NodeAssert.deepStrictEqual(
      loginStateSignInEvent({ _tag: "awaitingBrowser", loginId: "l", authUrl: "https://a" }),
      { _tag: "browserHandoff", authUrl: "https://a" },
    );
    NodeAssert.deepStrictEqual(
      loginStateSignInEvent({
        _tag: "awaitingDeviceCode",
        loginId: "l",
        userCode: "ABCD-EFGHI",
        verificationUrl: "https://v",
      }),
      { _tag: "deviceCode", userCode: "ABCD-EFGHI", verificationUrl: "https://v" },
    );
    NodeAssert.deepStrictEqual(loginStateSignInEvent({ _tag: "completed" }), {
      _tag: "completed",
    });
    NodeAssert.deepStrictEqual(loginStateSignInEvent({ _tag: "failed", message: "bad" }), {
      _tag: "failed",
      message: "bad",
    });
  });
});
