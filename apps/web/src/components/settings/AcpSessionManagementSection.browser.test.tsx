import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({
  list: vi.fn(),
  import: vi.fn(),
  delete: vi.fn(),
  listProviders: vi.fn(),
  setProvider: vi.fn(),
  disableProvider: vi.fn(),
  logout: vi.fn(),
}));
const grants = vi.hoisted(() => ({ scopes: new Set<string>() }));
const dialogs = vi.hoisted(() => ({ confirm: vi.fn() }));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: ((_id: unknown, scope: string) => grants.scopes.has(scope)) as never,
  readEnvironmentScope: ((_id: unknown, scope: string) => grants.scopes.has(scope)) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => {
  const { serverEnvironment } = await import("../../state/server");
  const byAtom = new Map<unknown, unknown>([
    [serverEnvironment.listAcpRegistrySessions, commands.list],
    [serverEnvironment.importAcpRegistrySession, commands.import],
    [serverEnvironment.deleteAcpRegistrySession, commands.delete],
    [serverEnvironment.listAcpRegistryProviders, commands.listProviders],
    [serverEnvironment.setAcpRegistryProvider, commands.setProvider],
    [serverEnvironment.disableAcpRegistryProvider, commands.disableProvider],
    [serverEnvironment.logoutAcpRegistry, commands.logout],
  ]);
  return {
    ...(await original()),
    useAtomCommand: ((atom: unknown) => byAtom.get(atom)) as never,
  };
});
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  ensureLocalApi: () => ({ dialogs }) as never,
}));

import { AcpSessionManagementSection } from "./AcpSessionManagementSection";

const environmentId = EnvironmentId.make("remote-device");
const instanceId = ProviderInstanceId.make("acpRegistry_antigravity");
const projectId = ProjectId.make("project-antigravity");
const session = {
  sessionId: "native-session-1",
  cwd: "/workspace/antigravity",
  additionalDirectories: [],
  title: "Native Antigravity session",
  updatedAt: "2026-08-23T00:00:00Z",
  importedThreadId: null,
} as const;
const provider = {
  instanceId,
  driver: ProviderDriverKind.make("acpRegistry"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", canLogout: true },
  nativeSessions: { canList: true, canLoad: true, canResume: true, canDelete: true },
  configurableProviders: true,
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;

function render(readOnly = false) {
  return act(async () =>
    root.render(
      <AcpSessionManagementSection
        environmentId={environmentId}
        instanceId={instanceId}
        provider={provider}
        projects={[{ id: projectId, title: "Antigravity", workspaceRoot: session.cwd }]}
        readOnly={readOnly}
      />,
    ),
  );
}
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}
const click = (label: string) => act(async () => button(label).click());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  grants.scopes = new Set(["orchestration:read", "orchestration:operate", "providers:manage"]);
  commands.list.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      sessions: [session],
      nextCursor: null,
      canLoad: true,
      canResume: true,
      canDelete: true,
    },
  });
  commands.import.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { threadId: ThreadId.make("thread-imported"), imported: true },
  });
  commands.delete.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { deleted: true },
  });
  commands.listProviders.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      providers: [
        {
          providerId: "google",
          supported: ["openai"],
          required: false,
          current: { apiType: "openai", baseUrl: "https://api.example.test/v1" },
        },
      ],
    },
  });
  commands.setProvider.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { configured: true },
  });
  commands.disableProvider.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { disabled: true },
  });
  commands.logout.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { loggedOut: true },
  });
  dialogs.confirm.mockReset().mockResolvedValue(true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("AcpSessionManagementSection", () => {
  it("lists and imports native sessions through the owning environment", async () => {
    await render();
    await click("List sessions");

    expect(commands.list).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, projectId },
    });
    expect(container.textContent).toContain(session.title);

    await click("Import");

    expect(commands.import).toHaveBeenCalledWith({
      environmentId,
      input: {
        instanceId,
        projectId,
        sessionId: session.sessionId,
        title: session.title,
        updatedAt: session.updatedAt,
      },
    });
    expect(button("Imported").disabled).toBe(true);
  });

  it("logs out the provider instance through the owning environment", async () => {
    await render();
    await click("Log out");

    expect(commands.logout).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId },
    });
  });

  it("deletes unimported native sessions after destructive confirmation", async () => {
    await render();
    await click("List sessions");
    await click("Delete");

    expect(dialogs.confirm).toHaveBeenCalledOnce();
    expect(commands.delete).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, projectId, sessionId: session.sessionId },
    });
  });

  it("locks the project picker while a project-scoped request is pending", async () => {
    const pending = deferred<{
      readonly _tag: "Success";
      readonly value: { readonly providers: [] };
    }>();
    commands.listProviders.mockReturnValueOnce(pending.promise);
    await render();
    const picker = () =>
      container.querySelector<HTMLElement>('[aria-label="Project for ACP sessions"]')!;
    expect(picker().hasAttribute("data-disabled")).toBe(false);

    await click("List providers");

    expect(picker().hasAttribute("data-disabled")).toBe(true);
    await act(async () => pending.resolve({ _tag: "Success", value: { providers: [] } }));
    expect(picker().hasAttribute("data-disabled")).toBe(false);
  });

  it("lists, saves, and disables configurable ACP providers", async () => {
    await render();
    await click("List providers");

    expect(commands.listProviders).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, projectId },
    });
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="google base URL"]')?.value,
    ).toBe("https://api.example.test/v1");
    await click("Save");
    expect(commands.setProvider).toHaveBeenCalledWith({
      environmentId,
      input: {
        instanceId,
        projectId,
        providerId: "google",
        apiType: "openai",
        baseUrl: "https://api.example.test/v1",
      },
    });

    await click("Disable");
    expect(commands.disableProvider).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, projectId, providerId: "google" },
    });
  });
});

it("imports with task access even when provider configuration is read-only", async () => {
  grants.scopes.delete("providers:manage");
  await render(true);
  await click("List sessions");
  await click("Import");
  expect(commands.import).toHaveBeenCalledOnce();
});

it("does not import with provider management alone", async () => {
  grants.scopes.delete("orchestration:operate");
  await render();
  await click("List sessions");
  expect(button("Import").disabled).toBe(true);
  await click("Import");
  expect(commands.import).not.toHaveBeenCalled();
});

it("rechecks task access after confirming deletion", async () => {
  await render();
  await click("List sessions");
  dialogs.confirm.mockImplementationOnce(async () => {
    grants.scopes.delete("orchestration:operate");
    return true;
  });
  await click("Delete");
  expect(commands.delete).not.toHaveBeenCalled();
});
