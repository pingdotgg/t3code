import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  type AuthEnvironmentScope,
  type AuthSessionState,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
const state = vi.hoisted(() => ({
  registry: null as AtomRegistry.AtomRegistry | null,
  sessions: new Map<EnvironmentId, Atom.Writable<SessionResult>>(),
  run: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: undefined }));
vi.mock("@t3tools/client-runtime/state/session", () => ({
  createEnvironmentSessionAtoms: () => ({
    sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id)!,
  }),
}));
vi.mock("../rpc/atomRegistry", () => ({
  get appAtomRegistry() {
    return state.registry;
  },
}));
vi.mock("../state/shell", () => ({ shellEnvironment: { openInEditor: "openInEditor" } }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.run }));
vi.mock("../hooks/useLocalStorage", () => ({
  getLocalStorageItem: () => "vscode",
  setLocalStorageItem: vi.fn(),
  useLocalStorage: vi.fn(),
}));
vi.mock("./ui/button", () => ({ Button: "button" }));
vi.mock("./ui/toast", () => ({
  toastManager: { add: state.toast },
  stackedThreadToast: (value: unknown) => value,
}));

import { KeybindingsConfigWarning } from "./KeybindingsConfigWarning";

const environmentId = EnvironmentId.make("warning-environment");
let renderer: ReactTestRenderer | undefined;
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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.registry = AtomRegistry.make();
  state.sessions.set(
    environmentId,
    Atom.make<SessionResult>(AsyncResult.success(session([AuthOrchestrationOperateScope]))).pipe(
      Atom.keepAlive,
    ),
  );
  state.run.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.toast.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.registry?.dispose();
  state.sessions.clear();
  vi.unstubAllGlobals();
});

it("updates a visible warning on revocation and blocks its retained action until regrant", async () => {
  await act(async () => {
    renderer = create(
      <RegistryContext.Provider value={state.registry!}>
        <KeybindingsConfigWarning
          environmentId={environmentId}
          configPath="/t3/keybindings.json"
          availableEditors={["vscode"]}
          message="Invalid shortcut"
        />
      </RegistryContext.Provider>,
    );
  });
  const open = renderer!.root.findByType("button").props.onClick;
  expect(renderer!.root.findByType("button").props.disabled).toBe(false);
  await act(async () => {
    state.registry!.set(state.sessions.get(environmentId)!, AsyncResult.success(session([])));
    await open();
  });
  expect(renderer!.root.findByType("button").props.disabled).toBe(true);
  expect(state.run).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Unable to open keybindings file",
    }),
  );

  await act(async () => {
    state.registry!.set(
      state.sessions.get(environmentId)!,
      AsyncResult.success(session([AuthOrchestrationOperateScope])),
    );
  });
  expect(renderer!.root.findByType("button").props.disabled).toBe(false);
  await act(async () => open());
  expect(state.run).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { cwd: "/t3/keybindings.json", editor: "vscode" },
  });
});
