import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { Slot } = vi.hoisted(() => ({
  Slot: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  ScrollView: Slot,
  View: Slot,
  Share: {},
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: () => {} }),
  usePreventRemove: () => {},
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { value: unknown }, select?: (value: unknown) => unknown) =>
    select ? select(atom.value) : atom.value,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { createGuestShare: { permissionAtom: () => ({ value: true }) } },
  environmentServerConfigsAtom: {},
}));
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: {
    threadAtom: () => ({ value: {} }),
    statusAtom: () => ({ value: "ready" }),
    errorAtom: () => ({ value: null }),
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => () => {} }));
vi.mock("./ThreadGuestShareBar", () => ({
  useThreadGuestShare: () => ({ guestName: null, expiresAt: "1970-01-01T00:00:01.000Z" }),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Slot }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label }: { label: string }) => <button>{label}</button>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AndroidScreenHeader", () => ({ AndroidSheetHeader: () => null }));
vi.mock("../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../components/ui/ScreenContent", () => ({ ScreenContent: Slot }));
vi.mock("../../components/ui/Dialog", () => ({}));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: () => true }));

import { ThreadGuestShareSheet } from "./ThreadGuestShareSheet";

it("stops treating a retained guest link as active when it expires", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <ThreadGuestShareSheet
          route={{
            params: {
              environmentId: EnvironmentId.make("test"),
              threadId: ThreadId.make("thread"),
            },
          }}
        />,
      ),
    );
    expect(container.textContent).toContain("A guest link is active.");
    expect(container.querySelector("button")?.textContent).toBe("Create new link");

    await act(() => vi.advanceTimersByTimeAsync(1000));

    expect(container.textContent).not.toContain("A guest link is active.");
    expect(container.querySelector("button")?.textContent).toBe("Create link");
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
