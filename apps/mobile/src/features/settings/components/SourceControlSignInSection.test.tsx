import type {
  SourceControlAppSignIn,
  SourceControlDefinition,
} from "@t3tools/client-runtime/source-control-clients";
import { DEFAULT_SERVER_SETTINGS, type SourceControlSignInPrompt } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import type { SettingsTarget } from "../settings-environment-filter";

type Outcome = { _tag: "Success"; value: unknown } | { _tag: "Failure"; cause: Cause.Cause<Error> };

const commands = vi.hoisted(() => new Map<string, (input: unknown) => Promise<unknown>>());

vi.mock("react-native", () => ({ Linking: { openURL: vi.fn(() => Promise.resolve()) } }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(() => Promise.resolve()) }));
vi.mock("../../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../../state/server", () => ({
  serverEnvironment: { updateSettings: "updateSettings" },
}));
vi.mock("../../../state/sourceControl", () => ({
  sourceControlEnvironment: { startSignIn: "start", waitForSignIn: "wait", cancelSignIn: "cancel" },
}));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (input: unknown) =>
    commands.get(command)?.(input) ?? Promise.resolve({ _tag: "Success", value: undefined }),
}));
vi.mock("./SettingsRow", () => ({
  SettingsRow: (props: { label: string; onPress?: () => void }): ReactNode => (
    <button type="button" onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));

import * as Dialog from "../../../components/ui/Dialog";
import { AppSignInRow } from "./SourceControlSignInSection";

const PROMPT: SourceControlSignInPrompt = {
  userCode: "ABCD-1234",
  verificationUri: "https://github.com/login/device",
  expiresAt: 15 * 60 * 1000,
};

function settle() {
  let resolve: (outcome: Outcome) => void = () => undefined;
  const promise = new Promise<Outcome>((done) => (resolve = done));
  return { promise, resolve };
}

function renderRow() {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <AppSignInRow
        environment={
          {
            environmentId: "env-1",
            serverConfig: { settings: DEFAULT_SERVER_SETTINGS },
          } as unknown as SettingsTarget
        }
        label="T3 Code for GitHub"
        definition={{ kind: "github" } as SourceControlDefinition}
        appSignIn={
          {
            appName: "T3 Code for GitHub",
            hosts: ["github.com"],
            installUrl: "https://github.com/apps/t3-code-for-github/installations/new",
            revokeUrl: "https://github.com/settings/apps/authorizations",
          } satisfies SourceControlAppSignIn
        }
        disabled={false}
      />,
    ),
  );
  return { container, root };
}

describe("AppSignInRow", () => {
  // A newer attempt from another client fails this one's wait on the server.
  it.each([
    ["before the sign-in starts", "start", []],
    ["while the code is shown", "wait", [PROMPT.userCode]],
    ["never", null, [PROMPT.userCode, "Sign-in did not finish"]],
  ] as const)(
    "alerts only on the open screen when it is left %s",
    async (_when, leaveAt, alerts) => {
      vi.mocked(Dialog.alert).mockClear();
      const start = settle();
      const wait = settle();
      commands.set("start", () => start.promise);
      commands.set("wait", () => wait.promise);
      const { container, root } = renderRow();
      using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };

      act(() => container.querySelector("button")?.click());
      if (leaveAt === "start") act(() => root.unmount());
      await act(async () => start.resolve({ _tag: "Success", value: PROMPT }));
      if (leaveAt === "wait") act(() => root.unmount());
      await act(async () =>
        wait.resolve({
          _tag: "Failure",
          cause: Cause.fail(new Error("A newer sign-in replaced this one.")),
        }),
      );

      expect(vi.mocked(Dialog.alert).mock.calls.map(([title]) => title)).toEqual(alerts);
    },
  );
});
