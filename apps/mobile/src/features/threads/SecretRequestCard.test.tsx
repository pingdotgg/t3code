import {
  EnvironmentId,
  ThreadId,
  TurnItemId,
  VAULT_TOKEN_SERVICES,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { Slot, answer } = vi.hoisted(() => ({
  Slot: ({ children }: { children?: ReactNode }) => children,
  answer: vi.fn(),
}));
vi.mock("react-native", () => ({ View: Slot }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Slot, AppTextInput: () => <input /> }));
vi.mock("../../components/ui/SecretTextInput", () => ({ SecretTextInput: () => <input /> }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/Chip", () => ({ Chip: () => null }));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: () => false }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => undefined }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => undefined, answerSecretRequest: {} },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => answer }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));

import { SecretRequestCard } from "./SecretRequestCard";

it.each([
  { name: "mail", gmail: { folder: "spam", limit: 5 }, needsGmailConnection: true },
  { name: "mail", gmail: { folder: "inbox", limit: 2 } },
  ...VAULT_TOKEN_SERVICES.map((service) => ({
    name: service,
    serviceRead: { service, limit: 3 },
  })),
] as const)(
  "can decline but never approve or disclose a private read on mobile ($name)",
  async (taggedVault) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    answer.mockReset().mockResolvedValue({ _tag: "Success" });
    const environmentId = EnvironmentId.make("host");
    const threadId = ThreadId.make("thread");
    const id = TurnItemId.make("request");
    const projectedItem: OrchestrationV2ProjectedTurnItem = {
      position: 0,
      visibility: "local",
      sourceThreadId: threadId,
      sourceItemId: id,
      item: {
        type: "secret_request",
        id,
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "pending",
        title: null,
        startedAt: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe(0),
        secretStatus: "pending",
        label: "Selected account",
        reason: "Requested read",
        taggedVault,
      },
    };
    const el = document.createElement("div");
    const root = createRoot(el);
    try {
      await act(() =>
        root.render(
          <SecretRequestCard
            environmentId={environmentId}
            projectedItem={projectedItem}
            iconColor="black"
          />,
        ),
      );
      expect(el.textContent).toMatch(/host desktop/);
      if ("serviceRead" in taggedVault && taggedVault.serviceRead) {
        expect(el.textContent).toContain(`(up to ${taggedVault.serviceRead.limit})`);
        expect(el.textContent).toContain("item count, not the contents");
      }
      expect(el.querySelector("input")).toBeNull();
      const buttons = [...el.querySelectorAll("button")];
      expect(buttons.map((button) => button.textContent)).toEqual(["Decline"]);
      await act(async () => buttons[0]!.click());
      expect(answer).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: { threadId, turnItemId: id, answer: { type: "decline" } },
      });
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);
