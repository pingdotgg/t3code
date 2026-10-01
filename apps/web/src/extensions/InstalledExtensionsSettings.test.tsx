import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, it, expect, vi } from "vite-plus/test";
import { AuthAccessWriteScope } from "@t3tools/contracts";
import type { InstalledPackage } from "./installedController";
import {
  AGENT_SESSIONS_IMPORT,
  AGENT_SESSIONS_SCAN,
  BROWSER_CAPTURE,
  BROWSER_SURFACE,
  UI_KEYBINDINGS_GLOBAL,
  filePresentationApi,
} from "@t3tools/extension-sdk/catalogue";
import {
  InstalledExtensionsSettings,
  PERMISSION_SUGGESTION_NOTE,
} from "./InstalledExtensionsSettings";
const fixture = vi.hoisted(() => ({
  manage: true,
  connected: true,
  install: vi.fn(async () => ({})),
  update: vi.fn(async () => ({})),
  refresh: vi.fn(async () => {}),
  installations: [] as readonly InstalledPackage[],
  select: vi.fn(async () => ({})),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => [
    { id: "project-a", environmentId: "env-a", title: "Workspace A", workspaceRoot: "/fixture/a" },
    { id: "project-b", environmentId: "env-b", title: "Workspace B", workspaceRoot: "/fixture/b" },
  ],
}));
vi.mock("../state/projects", () => ({ environmentProjects: { projectsAtom: {} } }));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { environmentId: "env-a", label: "Environment A" },
      { environmentId: "env-b", label: "Environment B" },
    ],
  }),
}));
vi.mock("../state/session", () => ({
  useEnvironmentSessionState: () => ({
    data: { authenticated: true, scopes: fixture.manage ? [AuthAccessWriteScope] : [] },
  }),
  usePreparedConnection: () => (fixture.connected ? { _tag: "Some", value: {} } : { _tag: "None" }),
}));
vi.mock("./installedEnvironment", () => ({
  useInstalledExtensions: () => ({
    installations: fixture.installations,
    loading: false,
    error: null,
  }),
  installEnvironmentExtension: fixture.install,
  manageInstalledExtension: fixture.update,
  refreshInstalledExtensions: fixture.refresh,
  selectInstalledApiProvider: fixture.select,
}));
vi.mock("../components/ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));
vi.mock("../components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean;
    onCheckedChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));
vi.mock("../components/ui/menu", () => ({
  Menu: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  MenuPopup: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  MenuTrigger: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
  MenuItem: (props: React.ComponentProps<"button">) => <button {...props} />,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const buttonIn = (root: ReactTestRenderer, label: string) =>
  root.root.findAllByType("button").find((node) => node.children.join("") === label)!;
/** The last checkbox with this label: an open permission editor renders after the install form. */
const checkboxIn = (root: ReactTestRenderer, label: string) =>
  root.root
    .findAllByType("label")
    .filter((node) => node.children.filter((child) => typeof child === "string").join("") === label)
    .at(-1)!
    .findByType("input");
function installed(
  grants: InstalledPackage["grants"],
  requiredGrants?: readonly string[],
): InstalledPackage {
  return {
    id: "example.agents",
    enabled: true,
    contentHash: "b".repeat(64),
    grants,
    ...(requiredGrants ? { requiredGrants } : {}),
    package: {
      format: 2,
      manifest: { id: "example.agents", version: "2.0.0", apiVersion: 1, surfaces: [] },
      serverEntry: "server.mjs",
      tools: [],
      requires: [],
      dependencies: [],
      provides: [],
    },
  };
}
describe("installed package settings", () => {
  it("describes environment-wide clone and discovery grants without project-scoped consent", async () => {
    fixture.manage = true;
    fixture.installations = [
      installed({ projectIds: [], capabilities: ["t3.projects/create", "t3.source-control/read"] }),
    ];
    const text = (node: ReactTestInstance | string): string =>
      typeof node === "string" ? node : node.children.map(text).join("");
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<InstalledExtensionsSettings />);
      });
      await act(async () => buttonIn(root, "Edit permissions").props.onClick());
      expect(text(root.root)).toContain("provider credentials or SSH keys");
      expect(text(root.root)).toContain(
        "account-wide repository names, including private repositories",
      );
      expect(text(root.root)).not.toContain("Allow t3.projects/create in selected projects");
      expect(text(root.root)).not.toContain("Allow t3.source-control/read in selected projects");
    } finally {
      if (root) await act(async () => root.unmount());
      fixture.installations = [];
    }
  });
  it("requires explicit trust and project selection, then resets consent on environment switch", async () => {
    fixture.manage = true;
    fixture.install.mockClear();
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<InstalledExtensionsSettings />);
      });
      const button = (label: string) =>
        root.root.findAllByType("button").find((node) => node.children.join("") === label)!;
      expect(button("Install package").props.disabled).toBe(true);
      await act(async () => {
        const inputs = root.root.findAllByType("input");
        inputs[0]!.props.onChange({ target: { value: "/environment/package" } });
        inputs[1]!.props.onChange({ target: { checked: true } });
        inputs[2]!.props.onChange({ target: { checked: true } });
      });
      expect(button("Install package").props.disabled).toBe(true);
      await act(async () =>
        root.root
          .findAllByType("input")
          .at(-1)!
          .props.onChange({ target: { checked: true } }),
      );
      expect(button("Install package").props.disabled).toBe(false);
      await act(async () => button("Install package").props.onClick());
      expect(fixture.install).toHaveBeenCalledWith("env-a", {
        sourceDir: "/environment/package",
        projectIds: ["project-a"],
        capabilities: ["t3.workspace/read-text"],
        trusted: true,
      });
      expect(button("Install package").props.disabled).toBe(true);
      await act(async () => button("Environment B").props.onClick());
      expect(root.root.findAllByType("input")[0]!.props.value).toBe("");
      expect(JSON.stringify(root.toJSON())).toContain("Workspace B");
      expect(JSON.stringify(root.toJSON())).not.toContain("Workspace A");
    } finally {
      await act(async () => root?.unmount());
    }
  });
  it("offers the agent session scan and import grants as separate choices", async () => {
    fixture.manage = true;
    fixture.install.mockClear();
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<InstalledExtensionsSettings />);
      });
      const grantInput = (grant: string) =>
        root.root
          .findAllByType("label")
          .find(
            (label) =>
              label.children.filter((child) => typeof child === "string").join("") ===
              `Allow ${grant} in selected projects`,
          )
          ?.findByType("input");
      expect(grantInput(AGENT_SESSIONS_SCAN)).toBeDefined();
      expect(grantInput(AGENT_SESSIONS_IMPORT)).toBeDefined();
      await act(async () => {
        const inputs = root.root.findAllByType("input");
        inputs[0]!.props.onChange({ target: { value: "/environment/package" } });
        inputs[1]!.props.onChange({ target: { checked: true } });
        inputs.at(-1)!.props.onChange({ target: { checked: true } });
      });
      await act(async () =>
        grantInput(AGENT_SESSIONS_SCAN)!.props.onChange({ target: { checked: true } }),
      );
      await act(async () =>
        grantInput(AGENT_SESSIONS_IMPORT)!.props.onChange({ target: { checked: true } }),
      );
      await act(async () =>
        root.root
          .findAllByType("button")
          .find((node) => node.children.join("") === "Install package")!
          .props.onClick(),
      );
      expect(fixture.install).toHaveBeenCalledWith("env-a", {
        sourceDir: "/environment/package",
        projectIds: ["project-a"],
        capabilities: [AGENT_SESSIONS_SCAN, AGENT_SESSIONS_IMPORT],
        trusted: true,
      });
    } finally {
      await act(async () => root?.unmount());
    }
  });
  it("does not offer an enabled install action to a read-only session", async () => {
    fixture.manage = false;
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<InstalledExtensionsSettings />);
      });
      await act(async () => {
        const inputs = root.root.findAllByType("input");
        inputs[0]!.props.onChange({ target: { value: "/fixture" } });
        inputs.at(-1)!.props.onChange({ target: { checked: true } });
      });
      expect(
        root.root
          .findAllByType("button")
          .find((node) => node.children.join("") === "Install package")!.props.disabled,
      ).toBe(true);
    } finally {
      await act(async () => root?.unmount());
      fixture.manage = true;
    }
  });
});

it("labels a disconnected environment's installations as last known and disables changes", async () => {
  fixture.manage = true;
  fixture.installations = [
    {
      id: "example.files",
      enabled: true,
      contentHash: "a".repeat(64),
      grants: { capabilities: [], projectIds: [] },
      package: {
        format: 1,
        manifest: { id: "example.files", version: "1.0.0", apiVersion: 1, surfaces: [] },
        serverEntry: "server.mjs",
        tools: [],
      },
    },
  ];
  const label = "Disconnected. Showing the last known installations.";
  let root!: ReactTestRenderer;
  try {
    fixture.connected = false;
    await act(async () => {
      root = create(<InstalledExtensionsSettings />);
    });
    const rollback = () =>
      root.root
        .findAllByType("button")
        .find((node) => node.children.join("") === "Roll back package")!;
    expect(JSON.stringify(root.toJSON())).toContain(label);
    expect(rollback().props.disabled).toBe(true);
    fixture.connected = true;
    await act(async () => {
      root.update(<InstalledExtensionsSettings />);
    });
    expect(JSON.stringify(root.toJSON())).not.toContain(label);
    expect(rollback().props.disabled).toBe(false);
  } finally {
    await act(async () => root?.unmount());
    fixture.connected = true;
    fixture.installations = [];
  }
});

it("selects a package-provided API explicitly without changing installation grants", async () => {
  fixture.manage = true;
  fixture.select.mockClear();
  fixture.install.mockClear();
  fixture.installations = [
    {
      id: "example.files",
      enabled: true,
      contentHash: "a".repeat(64),
      grants: { capabilities: [], projectIds: [] },
      package: {
        format: 2,
        manifest: { id: "example.files", version: "1.0.0", apiVersion: 1, surfaces: [] },
        serverEntry: "server.mjs",
        tools: [],
        requires: [],
        dependencies: [],
        provides: [filePresentationApi.definition],
      },
    },
  ];
  let root!: ReactTestRenderer;
  try {
    await act(async () => {
      root = create(<InstalledExtensionsSettings />);
    });
    const select = root.root
      .findAllByType("button")
      .find((button) => button.children.join("") === "Use for t3.file/presentation");
    expect(select).toBeDefined();
    await act(async () => {
      select!.props.onClick();
    });
    expect(fixture.select).toHaveBeenCalledWith("env-a", {
      id: "t3.file/presentation",
      providerId: "example.files",
      fallbackProviderIds: [],
    });
    expect(fixture.install).not.toHaveBeenCalled();
    await act(async () => buttonIn(root, "Edit permissions").props.onClick());
    await act(async () => {
      checkboxIn(root, "Workspace A · /fixture/a").props.onChange({ target: { checked: true } });
      checkboxIn(root, "Allow workspace text reads in selected projects").props.onChange({
        target: { checked: true },
      });
    });
    await act(async () => buttonIn(root, "Apply selected permissions").props.onClick());
    expect(fixture.update).toHaveBeenLastCalledWith("env-a", {
      id: "example.files",
      action: "grants",
      grants: { capabilities: ["t3.workspace/read-text"], projectIds: ["project-a"] },
    });
    expect(root.root.findAllByType("input").at(-1)!.props.checked).toBe(false);
    fixture.update.mockRejectedValueOnce(
      new Error("No previous package is available for rollback"),
    );
    const rollback = root.root
      .findAllByType("button")
      .find((button) => button.children.join("") === "Roll back package");
    expect(rollback).toBeDefined();
    await act(async () => {
      rollback!.props.onClick();
    });
    expect(fixture.update).toHaveBeenCalledWith("env-a", {
      id: "example.files",
      action: "rollback",
    });
    expect(JSON.stringify(root.toJSON())).toContain(
      "No previous package is available for rollback",
    );
  } finally {
    fixture.installations = [];
    await act(async () => root?.unmount());
  }
});

it("edits an installation's permissions starting from its current grants", async () => {
  fixture.manage = true;
  fixture.update.mockClear();
  const grants = {
    capabilities: ["t3.workspace/read-text", AGENT_SESSIONS_SCAN],
    projectIds: ["project-a" as InstalledPackage["grants"]["projectIds"][number]],
  };
  fixture.installations = [installed(grants)];
  let root!: ReactTestRenderer;
  try {
    await act(async () => {
      root = create(<InstalledExtensionsSettings />);
    });
    // The card shows what is held and what each grant allows.
    const text = (node: ReactTestInstance | string): string =>
      typeof node === "string" ? node : node.children.map(text).join("");
    expect(root.root.findAllByType("li").map(text)).toContain(
      `${AGENT_SESSIONS_SCAN} — Allows t3.agents/sessions: scan, import`,
    );
    await act(async () => buttonIn(root, "Edit permissions").props.onClick());
    expect(checkboxIn(root, "Workspace A · /fixture/a").props.checked).toBe(true);
    expect(checkboxIn(root, "Allow workspace text reads in selected projects").props.checked).toBe(
      true,
    );
    expect(
      checkboxIn(root, `Allow ${AGENT_SESSIONS_SCAN} in selected projects`).props.checked,
    ).toBe(true);
    expect(
      checkboxIn(root, `Allow ${AGENT_SESSIONS_IMPORT} in selected projects`).props.checked,
    ).toBe(false);
    await act(async () => buttonIn(root, "Apply selected permissions").props.onClick());
    expect(fixture.update).toHaveBeenLastCalledWith("env-a", {
      id: "example.agents",
      action: "grants",
      grants,
    });
  } finally {
    fixture.installations = [];
    await act(async () => root?.unmount());
  }
});

it("grants exactly the missing required permissions and never removes a held one", async () => {
  fixture.manage = true;
  fixture.update.mockClear();
  const projectIds = ["project-a" as InstalledPackage["grants"]["projectIds"][number]];
  fixture.installations = [
    installed({ capabilities: ["t3.workspace/read-text", "example.custom/grant"], projectIds }, [
      "t3.workspace/read-text",
      AGENT_SESSIONS_SCAN,
      AGENT_SESSIONS_IMPORT,
    ]),
  ];
  let root!: ReactTestRenderer;
  try {
    await act(async () => {
      root = create(<InstalledExtensionsSettings />);
    });
    const status = root.root
      .findAllByProps({ role: "status" })
      .find((node) => node.children.join("").includes("permissions it"));
    expect(status?.children.join("")).toBe("This version can use 2 permissions it does not have:");
    expect(JSON.stringify(root.toJSON())).toContain(PERMISSION_SUGGESTION_NOTE);
    await act(async () => buttonIn(root, "Grant 2 new permissions").props.onClick());
    expect(fixture.update).toHaveBeenCalledTimes(1);
    expect(fixture.update).toHaveBeenLastCalledWith("env-a", {
      id: "example.agents",
      // Only the additions go over the wire; the server unions them with its current grants.
      action: "addGrants",
      grants: { capabilities: [AGENT_SESSIONS_SCAN, AGENT_SESSIONS_IMPORT], projectIds: [] },
    });
    // Nothing is offered once everything required is held, or by a server that does not say.
    fixture.installations = [
      installed({ capabilities: [AGENT_SESSIONS_SCAN], projectIds }, [AGENT_SESSIONS_SCAN]),
    ];
    await act(async () => root.update(<InstalledExtensionsSettings />));
    expect(JSON.stringify(root.toJSON())).not.toContain("new permission");
    fixture.installations = [installed({ capabilities: [], projectIds })];
    await act(async () => root.update(<InstalledExtensionsSettings />));
    expect(JSON.stringify(root.toJSON())).not.toContain("new permission");
  } finally {
    fixture.installations = [];
    await act(async () => root?.unmount());
  }
});

it("lists missing host-checked grants with what they allow and lets them be granted", async () => {
  fixture.manage = true;
  fixture.update.mockClear();
  const projectIds = ["project-a" as InstalledPackage["grants"]["projectIds"][number]];
  const hostChecked = [BROWSER_SURFACE, BROWSER_CAPTURE, UI_KEYBINDINGS_GLOBAL];
  fixture.installations = [installed({ capabilities: [], projectIds }, hostChecked)];
  let root!: ReactTestRenderer;
  try {
    await act(async () => {
      root = create(<InstalledExtensionsSettings />);
    });
    const text = (node: ReactTestInstance | string): string =>
      typeof node === "string" ? node : node.children.map(text).join("");
    expect(text(root.root)).toContain("This version can use 3 permissions it does not have:");
    expect(text(root.root)).toContain(`${BROWSER_SURFACE} — Host service ${BROWSER_SURFACE}`);
    expect(text(root.root)).toContain(`${BROWSER_CAPTURE} — Host service ${BROWSER_CAPTURE}`);
    expect(text(root.root)).toContain(
      `${UI_KEYBINDINGS_GLOBAL} — Checked by t3.ui/keybindings when it is called`,
    );
    // Each can also be chosen by hand, not only while held.
    await act(async () => buttonIn(root, "Edit permissions").props.onClick());
    for (const grant of hostChecked)
      expect(checkboxIn(root, `Allow ${grant} in selected projects`)).toBeDefined();
    await act(async () => buttonIn(root, "Grant 3 new permissions").props.onClick());
    expect(fixture.update).toHaveBeenLastCalledWith("env-a", {
      id: "example.agents",
      action: "addGrants",
      grants: { capabilities: hostChecked, projectIds: [] },
    });
  } finally {
    fixture.installations = [];
    await act(async () => root?.unmount());
  }
});

it("does not offer new grants that would exceed the per-installation cap", async () => {
  fixture.manage = true;
  fixture.update.mockClear();
  const projectIds = ["project-a" as InstalledPackage["grants"]["projectIds"][number]];
  const held = Array.from({ length: 31 }, (_, index) => `example.held/grant-${index}`);
  fixture.installations = [
    installed({ capabilities: held, projectIds }, [AGENT_SESSIONS_SCAN, AGENT_SESSIONS_IMPORT]),
  ];
  let root!: ReactTestRenderer;
  try {
    await act(async () => {
      root = create(<InstalledExtensionsSettings />);
    });
    const text = (node: ReactTestInstance | string): string =>
      typeof node === "string" ? node : node.children.map(text).join("");
    // The missing grants stay listed, but the action the server would reject is not offered.
    expect(text(root.root)).toContain("This version can use 2 permissions it does not have:");
    expect(buttonIn(root, "Grant 2 new permissions")).toBeUndefined();
    const status = root.root
      .findAllByProps({ role: "status" })
      .find((node) => node.children.join("").includes("at most 32"));
    expect(status?.children.join("")).toBe(
      "An installation can hold at most 32 permissions and this one has 31. Use Edit permissions to remove ones it does not need, then grant these.",
    );
    // The editor cannot apply more than the cap either.
    await act(async () => buttonIn(root, "Edit permissions").props.onClick());
    expect(buttonIn(root, "Apply selected permissions").props.disabled).toBe(false);
    await act(async () =>
      checkboxIn(root, `Allow ${AGENT_SESSIONS_SCAN} in selected projects`).props.onChange({
        target: { checked: true },
      }),
    );
    await act(async () =>
      checkboxIn(root, `Allow ${AGENT_SESSIONS_IMPORT} in selected projects`).props.onChange({
        target: { checked: true },
      }),
    );
    expect(buttonIn(root, "Apply selected permissions").props.disabled).toBe(true);
    expect(fixture.update).not.toHaveBeenCalled();
  } finally {
    fixture.installations = [];
    await act(async () => root?.unmount());
  }
});
