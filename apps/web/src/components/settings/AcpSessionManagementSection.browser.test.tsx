import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
  type AcpRegistryConfigurableProvider,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

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

async function renderSection(readOnly = false) {
  const screen = await render(
    <AcpSessionManagementSection
      environmentId={environmentId}
      instanceId={instanceId}
      provider={provider}
      projects={[{ id: projectId, title: "Antigravity", workspaceRoot: session.cwd }]}
      readOnly={readOnly}
    />,
  );
  const button = (label: string) => {
    const found = [...screen.container.querySelectorAll("button")].find(
      (element) => element.textContent === label,
    );
    expect(found, `button ${label}`).toBeDefined();
    return found!;
  };
  return Object.assign(screen, {
    button,
    click: (label: string) => act(async () => button(label).click()),
  });
}

function setup() {
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
}

it("does not import with provider management alone", async () => {
  setup();
  grants.scopes.delete("orchestration:operate");
  await using screen = await renderSection();
  await screen.click("List sessions");
  expect(screen.button("Import").disabled).toBe(true);
  await screen.click("Import");
  expect(commands.import).not.toHaveBeenCalled();
});

it("rechecks task access after confirming deletion", async () => {
  setup();
  await using screen = await renderSection();
  await screen.click("List sessions");
  dialogs.confirm.mockImplementationOnce(async () => {
    grants.scopes.delete("orchestration:operate");
    return true;
  });
  await screen.click("Delete");
  expect(commands.delete).not.toHaveBeenCalled();
});

it.each(["Save", "Disable"])("keeps other provider edits through a %s refetch", async (action) => {
  setup();
  const providers: AcpRegistryConfigurableProvider[] = ["google", "other"].map((providerId) => ({
    providerId,
    supported: ["openai"],
    required: false,
    current: { apiType: "openai", baseUrl: "https://api.example.test/v1" },
  }));
  const response = { _tag: "Success" as const, value: { providers } };
  commands.listProviders.mockResolvedValue(response);
  await using screen = await renderSection();
  await screen.click("List providers");
  const input = (label: string) =>
    screen.container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  await userEvent.fill(input("other base URL"), "https://other.example.test/v1");
  await userEvent.fill(input("other write-only headers JSON"), '{"X-Test":"unsaved"}');
  await userEvent.fill(input("google write-only headers JSON"), '{"X-Test":"saved"}');

  let resolveReload!: (value: typeof response) => void;
  const reload = new Promise<typeof response>((resolve) => {
    resolveReload = resolve;
  });
  commands.listProviders.mockReturnValueOnce(reload);
  let resolveMutation!: () => void;
  const mutation = new Promise<void>((resolve) => {
    resolveMutation = resolve;
  });
  const command = action === "Save" ? commands.setProvider : commands.disableProvider;
  command.mockReturnValueOnce(
    mutation.then(() => ({
      _tag: "Success",
      value: action === "Save" ? { configured: true } : { disabled: true },
    })),
  );
  await screen.click(action);
  expect(screen.button("Refresh").disabled).toBe(true);
  await act(async () => resolveMutation());
  for (const button of screen.container.querySelectorAll<HTMLButtonElement>("button")) {
    if (button.textContent === "Save" || button.textContent === "Disable") {
      expect(button.disabled).toBe(true);
    }
  }
  await userEvent.fill(input("other base URL"), "https://newer.example.test/v1");
  await act(async () => resolveReload(response));

  expect(input("other base URL").value).toBe("https://newer.example.test/v1");
  expect(input("other write-only headers JSON").value).toBe('{"X-Test":"unsaved"}');
  expect(input("google write-only headers JSON").value).toBe("");
  await screen.click("Refresh");
  expect(input("other base URL").value).toBe("https://api.example.test/v1");
  expect(input("other write-only headers JSON").value).toBe("");
});

it.each([true, false])(
  "enables project actions after projects arrive (sessions: %s)",
  async (canList) => {
    setup();
    const props = {
      environmentId,
      instanceId,
      provider: { ...provider, nativeSessions: { ...provider.nativeSessions, canList } },
      readOnly: false,
    };
    await using screen = await render(<AcpSessionManagementSection {...props} projects={[]} />);
    await screen.rerender(
      <AcpSessionManagementSection
        {...props}
        projects={[{ id: projectId, title: "Antigravity", workspaceRoot: session.cwd }]}
      />,
    );
    const action = screen.getByRole("button", {
      name: canList ? "List sessions" : "List providers",
    });
    await expect.element(action).toBeEnabled();
    if (!canList) {
      await expect.element(screen.getByRole("combobox")).not.toBeInTheDocument();
    }
    await action.click();
    if (canList) {
      await expect.element(screen.getByText(session.title)).toBeVisible();
      expect(commands.list).toHaveBeenCalledWith({
        environmentId,
        input: { instanceId, projectId },
      });
    } else {
      await expect
        .element(screen.getByRole("textbox", { name: "google base URL" }))
        .toHaveValue("https://api.example.test/v1");
      expect(commands.listProviders).toHaveBeenCalledWith({
        environmentId,
        input: { instanceId, projectId },
      });
    }
  },
);

it.each([true, false])(
  "preserves valid selection and clears removed project data (sessions: %s)",
  async (canList) => {
    setup();
    const first = { id: projectId, title: "Antigravity", workspaceRoot: session.cwd };
    const second = { id: ProjectId.make("second"), title: "Second", workspaceRoot: "/second" };
    const props = {
      environmentId,
      instanceId,
      readOnly: false,
      provider: { ...provider, nativeSessions: { ...provider.nativeSessions, canList } },
    };
    commands.list.mockResolvedValue({
      _tag: "Success",
      value: { sessions: [session], nextCursor: "page-2" },
    });
    await using screen = await render(
      <AcpSessionManagementSection {...props} projects={[first, second]} />,
    );
    await screen.getByRole("combobox").click();
    await screen.getByRole("option", { name: "Second", exact: true }).click();
    if (canList) await screen.getByRole("button", { name: "List sessions" }).click();
    await screen.getByRole("button", { name: "List providers" }).click();
    await userEvent.fill(
      screen.getByRole("textbox", { name: "google base URL" }),
      "https://draft.test",
    );
    await userEvent.fill(
      screen.getByLabelText("google write-only headers JSON"),
      '{"Secret":"draft"}',
    );

    await screen.rerender(
      <AcpSessionManagementSection
        {...props}
        projects={[
          first,
          { id: ProjectId.make("third"), title: "Third", workspaceRoot: "/third" },
          second,
        ]}
      />,
    );
    await expect
      .element(
        screen.getByRole("combobox", {
          name: canList ? "Project for ACP sessions" : "Project for ACP providers",
        }),
      )
      .toHaveTextContent("Second");
    await expect
      .element(screen.getByRole("textbox", { name: "google base URL" }))
      .toHaveValue("https://draft.test");
    await screen.getByRole("button", { name: "Save", exact: true }).click();
    expect(commands.setProvider).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        instanceId,
        projectId: second.id,
        providerId: "google",
        apiType: "openai",
        baseUrl: "https://draft.test",
        headers: { Secret: "draft" },
      },
    });

    await screen.rerender(<AcpSessionManagementSection {...props} projects={[first]} />);
    await expect.element(screen.getByText(session.title)).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("textbox", { name: "google base URL" }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "List providers" })).toBeEnabled();
    await screen.getByRole("button", { name: "List providers" }).click();
    expect(commands.listProviders).toHaveBeenLastCalledWith({
      environmentId,
      input: { instanceId, projectId },
    });
    await expect.element(screen.getByLabelText("google write-only headers JSON")).toHaveValue("");
    await expect
      .element(screen.getByRole("textbox", { name: "google base URL" }))
      .toHaveValue("https://api.example.test/v1");
    await screen.rerender(<AcpSessionManagementSection {...props} projects={[]} />);
    await expect.element(screen.getByRole("button", { name: "List providers" })).toBeDisabled();
    await expect
      .element(screen.getByRole("textbox", { name: "google base URL" }))
      .not.toBeInTheDocument();
  },
);

it.each([true, false])(
  "ignores late listing results after project replacement (sessions: %s)",
  async (canList) => {
    setup();
    const response = canList
      ? { _tag: "Success", value: { sessions: [session], nextCursor: "old-page" } }
      : {
          _tag: "Success",
          value: {
            providers: [
              { providerId: "stale", supported: ["openai"], required: false, current: null },
            ],
          },
        };
    let finish!: (value: typeof response) => void;
    const pending = new Promise<typeof response>((resolve) => {
      finish = resolve;
    });
    (canList ? commands.list : commands.listProviders).mockReturnValueOnce(pending);
    await using screen = await renderSection();
    await screen.click(canList ? "List sessions" : "List providers");
    await screen.rerender(
      <AcpSessionManagementSection
        environmentId={environmentId}
        instanceId={instanceId}
        provider={provider}
        readOnly={false}
        projects={[
          {
            id: ProjectId.make("replacement"),
            title: "Replacement",
            workspaceRoot: "/replacement",
          },
        ]}
      />,
    );
    await act(async () => finish(response));
    await expect.element(screen.getByText(session.title)).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    await expect.element(screen.getByLabelText("stale base URL")).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: canList ? "List sessions" : "List providers" }))
      .toBeEnabled();
    await screen.click(canList ? "List sessions" : "List providers");
    expect(canList ? commands.list : commands.listProviders).toHaveBeenLastCalledWith({
      environmentId,
      input: { instanceId, projectId: ProjectId.make("replacement") },
    });
  },
);

it.each(["Save", "Disable"])("does not refetch the old project after a late %s", async (action) => {
  setup();
  const command = action === "Save" ? commands.setProvider : commands.disableProvider;
  let finish!: () => void;
  command.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }).then(() => ({
      _tag: "Success",
      value: action === "Save" ? { configured: true } : { disabled: true },
    })),
  );
  await using screen = await renderSection();
  await screen.click("List providers");
  await screen.click(action);
  expect(command).toHaveBeenCalledOnce();
  await screen.rerender(
    <AcpSessionManagementSection
      environmentId={environmentId}
      instanceId={instanceId}
      provider={provider}
      readOnly={false}
      projects={[
        { id: ProjectId.make("replacement"), title: "Replacement", workspaceRoot: "/replacement" },
      ]}
    />,
  );
  await act(async () => finish());
  expect(commands.listProviders).toHaveBeenCalledOnce();
  await expect.element(screen.getByRole("button", { name: "List providers" })).toBeEnabled();
});

it.each(["Delete", "Disable"])(
  "does not act on a replaced project after confirming %s",
  async (action) => {
    setup();
    let finish!: (confirmed: boolean) => void;
    dialogs.confirm.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    await using screen = await renderSection();
    await screen.click(action === "Delete" ? "List sessions" : "List providers");
    await screen.click(action);
    await screen.rerender(
      <AcpSessionManagementSection
        environmentId={environmentId}
        instanceId={instanceId}
        provider={provider}
        readOnly={false}
        projects={[
          {
            id: ProjectId.make("replacement"),
            title: "Replacement",
            workspaceRoot: "/replacement",
          },
        ]}
      />,
    );
    await act(async () => finish(true));
    expect(action === "Delete" ? commands.delete : commands.disableProvider).not.toHaveBeenCalled();
  },
);
