import type { ComponentPropsWithoutRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  type EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

const testState = vi.hoisted(() => ({
  addToast: vi.fn(),
  closeToast: vi.fn(),
  dismissNotificationKey: vi.fn(),
  navigate: vi.fn(),
  providers: [] as ServerProvider[],
  updateProvider: vi.fn(),
  updateToast: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: <T,>(callback: T): T => callback,
    useEffect: (effect: () => void | (() => void)) => {
      effect();
    },
    useMemo: <T,>(factory: () => T): T => factory(),
    useRef: <T,>(initialValue: T) => ({ current: initialValue }),
  };
});

vi.mock("react/compiler-runtime", () => ({
  c: (size: number) => Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel")),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => testState.navigate,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => testState.providers,
}));

vi.mock("../state/server", () => ({
  primaryServerProvidersAtom: Symbol("primaryServerProvidersAtom"),
  serverEnvironment: { updateProvider: Symbol("updateProvider") },
}));

vi.mock("../state/environments", () => ({
  usePrimaryEnvironment: () => ({
    environmentId: "env-primary" as EnvironmentId,
  }),
}));

vi.mock("../providerUpdateDismissal", () => ({
  useDismissedProviderUpdateNotificationKeys: () => ({
    dismissedNotificationKeys: new Set<string>(),
    dismissNotificationKey: testState.dismissNotificationKey,
  }),
}));

vi.mock("./ui/toast", () => ({
  stackedThreadToast: <T,>(options: T): T => options,
  toastManager: {
    add: testState.addToast,
    close: testState.closeToast,
    update: testState.updateToast,
  },
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => testState.updateProvider,
}));

import { ProviderUpdatePrimaryNotification } from "./ProviderUpdatePrimaryNotification";

function updateCandidate(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-27T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "npm install -g @openai/codex@latest",
      canUpdate: true,
      checkedAt: "2026-07-27T12:00:00.000Z",
      message: "Update available.",
    },
  };
}

describe("ProviderUpdatePrimaryNotification", () => {
  beforeEach(() => {
    testState.addToast.mockReset().mockReturnValue("provider-update-toast");
    testState.closeToast.mockReset();
    testState.dismissNotificationKey.mockReset();
    testState.navigate.mockReset();
    testState.providers = [updateCandidate()];
    testState.updateProvider.mockReset().mockReturnValue(new Promise(() => {}));
    testState.updateToast.mockReset();
  });

  it("removes the prompt action while the provider update is running", () => {
    ProviderUpdatePrimaryNotification();

    const prompt = testState.addToast.mock.calls[0]?.[0] as {
      readonly actionProps?: ComponentPropsWithoutRef<"button">;
    };
    expect(prompt.actionProps?.children).toBe("Update");

    prompt.actionProps?.onClick?.({} as never);

    expect(testState.updateProvider).toHaveBeenCalledOnce();
    expect(testState.updateToast).toHaveBeenCalledWith(
      "provider-update-toast",
      expect.objectContaining({
        type: "loading",
        title: "Updating provider",
        actionProps: undefined,
      }),
    );
  });
});
