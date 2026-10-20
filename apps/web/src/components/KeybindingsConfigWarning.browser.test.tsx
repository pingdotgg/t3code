import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  type AuthEnvironmentScope,
  type AuthSessionState,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
const state = vi.hoisted(() => ({
  sessions: new Map<EnvironmentId, Atom.Writable<SessionResult>>(),
  run: vi.fn(),
  toast: vi.fn(),
}));

vi.mock(import("@t3tools/client-runtime/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createEnvironmentSessionAtoms: ((runtime: never) => ({
      ...actual.createEnvironmentSessionAtoms(runtime),
      sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id)!,
    })) as never,
  };
});
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.run) as never,
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } as never };
});

import { appAtomRegistry } from "../rpc/atomRegistry";
import { KeybindingsConfigWarning } from "./KeybindingsConfigWarning";

const environmentId = EnvironmentId.make("warning-environment");
const session = (scopes: readonly AuthEnvironmentScope[]): AuthSessionState => ({
  authenticated: true,
  scopes,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
  },
});
const setScopes = (scopes: readonly AuthEnvironmentScope[]) =>
  appAtomRegistry.set(state.sessions.get(environmentId)!, AsyncResult.success(session(scopes)));

function setup(): Disposable {
  localStorage.setItem("t3code:last-editor", JSON.stringify("vscode"));
  state.sessions.set(
    environmentId,
    Atom.make<SessionResult>(AsyncResult.success(session([AuthOrchestrationOperateScope]))).pipe(
      Atom.keepAlive,
    ),
  );
  state.run.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.toast.mockReset();
  return {
    [Symbol.dispose]() {
      localStorage.clear();
      state.sessions.clear();
    },
  };
}

it("updates a visible warning on revocation and blocks a click that raced it until regrant", async () => {
  using _state = setup();
  await using screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <KeybindingsConfigWarning
        environmentId={environmentId}
        configPath="/t3/keybindings.json"
        availableEditors={["vscode"]}
        message="Invalid shortcut"
      />
    </RegistryContext.Provider>,
  );
  const button = () => screen.container.querySelector("button")!;
  expect(screen.container.textContent).toContain("Invalid shortcut");
  expect(button().disabled).toBe(false);

  // The click lands before React re-renders the revoked grant.
  await act(async () => {
    setScopes([]);
    button().click();
  });
  expect(button().disabled).toBe(true);
  expect(state.run).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Unable to open keybindings file" }),
  );

  await act(async () => setScopes([AuthOrchestrationOperateScope]));
  expect(button().disabled).toBe(false);
  await act(async () => button().click());
  expect(state.run).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { cwd: "/t3/keybindings.json", editor: "vscode" },
  });
});
