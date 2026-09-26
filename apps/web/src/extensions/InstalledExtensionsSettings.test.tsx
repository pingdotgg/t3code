import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, it, expect, vi } from "vite-plus/test";
import { AuthAccessWriteScope } from "@t3tools/contracts";
import type { InstalledPackage } from "./installedController";
import { filePresentationApi } from "@t3tools/extension-sdk/catalogue";
import { InstalledExtensionsSettings } from "./InstalledExtensionsSettings";
const fixture = vi.hoisted(() => ({
  manage: true,
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
describe("installed package settings", () => {
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
    const permissions = () =>
      root.root
        .findAllByType("button")
        .find((button) => button.children.join("") === "Apply selected permissions")!;
    expect(permissions().props.disabled).toBe(false);
    await act(async () => permissions().props.onClick());
    expect(fixture.update).toHaveBeenLastCalledWith("env-a", {
      id: "example.files",
      action: "grants",
      grants: { capabilities: [], projectIds: [] },
    });
    await act(async () => {
      const inputs = root.root.findAllByType("input");
      inputs[1]!.props.onChange({ target: { checked: true } });
      inputs[2]!.props.onChange({ target: { checked: true } });
    });
    await act(async () => permissions().props.onClick());
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
