// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  providers: [] as ServerProvider[],
  update: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "providers"
      ? mocks.providers
      : new Map([
          [
            "remote-test",
            {
              connection: { phase: "connected" },
              entry: { target: { label: "Remote computer" } },
              serverConfig: { providers: mocks.providers },
            },
          ],
        ]),
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({ providerInstances: {} }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { providersValueAtom: () => "providers", updateSettings: "update" },
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: "presentations" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));
vi.mock("../../lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/utils")>()),
  randomUUID: () => "test",
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ title, control }: { title: string; control: ReactNode }) => (
    <div>
      {title}
      {control}
    </div>
  ),
}));
vi.mock("./ChatGptUsageButton", () => ({
  ChatGptUsageButton: () => <button>Manage usage</button>,
}));

import { AddCodexAccountDialog } from "./AddCodexAccountDialog";
import { ChatGptWelcomeCoordinator } from "./ChatGptWelcomeCoordinator";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

const environmentId = EnvironmentId.make("remote-test");
const instanceId = ProviderInstanceId.make("codex_test");
function provider(auth: ServerProvider["auth"]): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    displayName: "ChatGPT - Personal",
    installed: true,
    enabled: true,
    version: "test",
    status: "ready",
    auth,
    checkedAt: "2026-09-28T00:00:00.000Z",
    models: [],
    skills: [],
    slashCommands: [],
    setup: { canAuthenticate: true, canInstall: true },
  };
}
function Onboarding({ inline = false }: { inline?: boolean }) {
  const [adding, setAdding] = useState(true);
  const [createdAccount, setCreatedAccount] = useState<ProviderInstanceId | null>(null);
  return (
    <Dialog open>
      <DialogPopup>
        <DialogTitle>Connect your agents</DialogTitle>
        {createdAccount && <p>Pending account in onboarding</p>}
      </DialogPopup>
      {adding && (
        <AddCodexAccountDialog
          environmentId={environmentId}
          onClose={() => setAdding(false)}
          onAccountCreated={inline ? setCreatedAccount : undefined}
          renderSetup={() => <p>Waiting for destination connection</p>}
        />
      )}
      <ChatGptWelcomeCoordinator />
    </Dialog>
  );
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  mocks.providers = [];
  mocks.update.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(inline = false) {
  await act(async () => root.render(<Onboarding inline={inline} />));
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
it("replaces account setup with one confirmation after the destination enables sharing", async () => {
  await render();
  await click("Continue");
  mocks.providers = [provider({ status: "unauthenticated" })];
  await render();
  expect(document.body.textContent).toContain("Waiting for destination connection");
  // An identity login or incomplete transfer is not a usable sharing connection.
  mocks.providers = [provider({ status: "authenticated", subscriptionSharing: false })];
  await render();
  expect(document.body.textContent).toContain("Waiting for destination connection");
  expect(
    [...document.querySelectorAll('[role="dialog"][data-open]')]
      .map((dialog) => dialog.textContent)
      .join(" "),
  ).not.toContain("Your ChatGPT plan is connected");
  mocks.providers = [
    provider({ status: "authenticated", subscriptionSharing: true, profileId: "profile-test" }),
  ];
  await render();
  expect(document.body.textContent).not.toContain("Waiting for destination connection");
  expect(
    [...document.querySelectorAll('[role="dialog"]')].filter((dialog) =>
      dialog.textContent?.includes("Your ChatGPT plan is connected"),
    ),
  ).toHaveLength(1);
  await click("Continue");
  expect(document.body.textContent).toContain("Connect your agents");
  expect(
    [...document.querySelectorAll('[role="dialog"][data-open]')]
      .map((dialog) => dialog.textContent)
      .join(" "),
  ).not.toContain("Your ChatGPT plan is connected");
  expect(document.body.textContent).not.toContain("Finish later");
  await render();
  expect(
    [...document.querySelectorAll('[role="dialog"][data-open]')]
      .map((dialog) => dialog.textContent)
      .join(" "),
  ).not.toContain("Your ChatGPT plan is connected");
});
it("keeps unsuccessful setup open and allows finishing later without confirming a connection", async () => {
  await render();
  await click("Continue");
  mocks.providers = [provider({ status: "unauthenticated" })];
  await render();
  expect(document.body.textContent).toContain("Waiting for destination connection");
  await click("Finish later");
  expect(document.body.textContent).toContain("Connect your agents");
  expect(document.body.textContent).not.toContain("Waiting for destination connection");
  expect(
    [...document.querySelectorAll('[role="dialog"][data-open]')]
      .map((dialog) => dialog.textContent)
      .join(" "),
  ).not.toContain("Your ChatGPT plan is connected");
});

it("dismisses the name dialog before sign-in finishes when onboarding owns setup", async () => {
  await render(true);
  await click("Continue");
  expect(document.body.textContent).toContain("Pending account in onboarding");
  expect(document.body.textContent).not.toContain("Add ChatGPT account");
  expect(document.body.textContent).not.toContain("Waiting for destination connection");
  mocks.providers = [provider({ status: "unauthenticated" })];
  await render(true);
  expect([...document.querySelectorAll('[role="dialog"][data-open]')]).toHaveLength(1);
  mocks.providers = [provider({ status: "authenticated", subscriptionSharing: false })];
  await render(true);
  expect([...document.querySelectorAll('[role="dialog"][data-open]')]).toHaveLength(1);
  mocks.providers = [
    provider({ status: "authenticated", subscriptionSharing: true, profileId: "profile-test" }),
  ];
  await render(true);
  expect(document.body.textContent).toContain("Your ChatGPT plan is connected");
  await click("Continue");
  expect(document.body.textContent).toContain("Connect your agents");
  expect(document.body.textContent).not.toContain("Finish later");
});
it("keeps the name dialog available when creating the onboarding account fails", async () => {
  mocks.update.mockResolvedValue({ _tag: "Failure" });
  await render(true);
  await click("Continue");
  expect(document.body.textContent).toContain("Add ChatGPT account");
  expect(document.body.textContent).not.toContain("Pending account in onboarding");
  mocks.update.mockResolvedValue({ _tag: "Success", value: undefined });
  await click("Continue");
  expect(document.body.textContent).toContain("Pending account in onboarding");
  expect(document.body.textContent).not.toContain("Add ChatGPT account");
});
