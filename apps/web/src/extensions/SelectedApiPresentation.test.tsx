// Fixture loading deliberately exercises the independently packaged ESM source, outside Effect services.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as React from "react";
import * as Schema from "effect/Schema";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, ProjectId, ExtensionInstallation } from "@t3tools/contracts";
import type { ApiInvocation } from "@t3tools/extension-sdk/capabilities";
import { validateEnvironmentPackage } from "@t3tools/extension-sdk/environment";
import { createInstalledExtensionController } from "./installedController";
import { registerInstalledApiClient, setInstalledApiPolicy } from "./installedApiClients";
import { registerWorkspaceExtension } from "./workspaceRegistry";
import { installedWorkspaceContext } from "./installedContext";
import { extensionWorkspaceRevision } from "@t3tools/contracts";
import {
  useRightPanelStore,
  selectSelectedRightPanelSurface,
  type RightPanelSurface,
} from "../rightPanelStore";
import { NativeRightPanel, type NativePanelBindings } from "./nativePanels";
vi.mock("./terminal/PersistentThreadTerminal", () => ({
  PersistentThreadTerminalDrawer: () => null,
  PersistentThreadTerminalPanel: () => null,
}));
vi.mock("../components/AgentsPanel", () => ({ AgentsPanel: () => null }));
vi.mock("../components/pullRequest/PullRequestDetailPanel", () => ({
  PullRequestDetailPanel: () => null,
}));
vi.mock("../components/pullRequest/PullRequestGhosts", () => ({
  PullRequestDetailGhost: () => null,
}));
vi.mock("../components/pullRequest/PullRequestsUnavailableState", () => ({
  PullRequestsUnavailableState: () => null,
}));
vi.mock("../state/entities", () => ({ useThreadShell: () => null }));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => null }));
vi.mock("../components/files/FilePreviewPanel", () => ({
  default: () => <p>Legacy private panel</p>,
}));
const decodeInstallation = Schema.decodeUnknownSync(ExtensionInstallation);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it.each([1, 2])(
  "loads an independent installed Files module with surface state version %i through the API version 1 presentation contract",
  async (stateVersion) => {
    const root = new URL(
      "../../../../packages/extension-sdk/examples/installable-files/",
      import.meta.url,
    );
    const sourcePackage = validateEnvironmentPackage(
      JSON.parse(NodeFS.readFileSync(new URL("t3-extension.json", root), "utf8")),
    );
    const pkg = validateEnvironmentPackage({
      ...sourcePackage,
      manifest: {
        ...sourcePackage.manifest,
        surfaces: sourcePackage.manifest.surfaces.map((surface) => ({ ...surface, stateVersion })),
      },
    });
    const installation = decodeInstallation({
      id: pkg.manifest.id,
      contentHash: "a".repeat(64),
      enabled: true,
      package: pkg,
      grants: {
        projectIds: [ProjectId.make("project")],
        capabilities: ["t3.workspace/read-text", "t3.workspace/list-entries", "t3.file/open"],
      },
    });
    const context = installedWorkspaceContext({
      environmentId: "installed-proof-" + stateVersion,
      projectId: "project",
      threadId: "thread",
      projectWorkspaceRoot: "/fixtures/workspace",
      threadWorktreePath: "/fixtures/worktree",
      client: "web",
    });
    const calls: ApiInvocation[] = [];
    const controller = createInstalledExtensionController({
      environmentId: context.resource.environmentId,
      React,
      list: async () => ({
        installations: [installation],
        apiSelections: [],
        apiResolution: [{ id: "t3.file/presentation", providerId: pkg.manifest.id }],
      }),
      policyChanged: (policy) => setInstalledApiPolicy(context.resource.environmentId, policy),
      client: async () => ({
        code: NodeFS.readFileSync(new URL("client.mjs", root), "utf8").replace(
          "stateVersion: 1",
          "stateVersion: " + stateVersion,
        ),
        contentHash: installation.contentHash,
      }),
      load: async (code) =>
        (
          await import(
            /* @vite-ignore */ "data:text/javascript;base64," + Buffer.from(code).toString("base64")
          )
        ).default,
      invoke: vi.fn(),
      discoverApis: async () => [
        {
          id: "t3.file/presentation",
          providerId: pkg.manifest.id,
          pluginId: pkg.manifest.id,
          version: "1.0.0",
          generation: 1,
          health: "ready",
          selected: true,
        },
      ],
      subscribeApi: () => ({ async *[Symbol.asyncIterator]() {} }),
      invokeApi: async (_id, _hash, request) => {
        expect(request.context.workspaceRevision).toBe(
          extensionWorkspaceRevision("/fixtures/workspace", "/fixtures/worktree"),
        );
        expect(request.context.resource).toMatchObject({
          environmentId: "installed-proof-" + stateVersion,
          projectId: "project",
          threadId: "thread",
        });
        calls.push(request);
        if (request.id === "t3.file/presentation")
          return {
            surfaceId: pkg.manifest.id + "/view",
            placement: "side-panel",
            restoreState: {
              relativePath: (request.input as { relativePath: string }).relativePath,
            },
          };
        if (request.method === "listEntries")
          return {
            entries: [
              { name: "README.md", relativePath: "README.md", kind: "file" },
              { name: "other.txt", relativePath: "other.txt", kind: "file" },
            ],
            nextCursor: null,
          };
        if (request.method === "readText")
          return {
            relativePath: (request.input as { relativePath: string }).relativePath,
            contents:
              (request.input as { relativePath: string }).relativePath === "other.txt"
                ? "Other file contents"
                : "Independent file contents",
            byteLength: 25,
            truncated: false,
          };
        throw new Error("Unexpected API");
      },
      register: (extension, client) => {
        const surface = registerWorkspaceExtension(extension, undefined, {
          environmentId: context.resource.environmentId,
        });
        const api = registerInstalledApiClient(
          context.resource.environmentId,
          extension.manifest.id,
          client,
        );
        return () => {
          api();
          surface();
        };
      },
      changed: () => {},
    });
    const threadRef = {
      environmentId: EnvironmentId.make(context.resource.environmentId),
      threadId: ThreadId.make("thread"),
    };
    const surface = { kind: "files" as const, id: "files" as const };
    const bindings: NativePanelBindings = {
      browser: null,
      terminal: null,
      versionControl: null,
      files: {
        environmentId: threadRef.environmentId,
        cwd: "/fixtures/workspace",
        projectName: "Fixture",
        threadRef,
        composerDraftTarget: threadRef,
        keybindings: [],
        availableEditors: [],
        surface,
        hasProject: true,
        onOpenFile: () => {},
        onPendingChange: () => {},
        selectedFilePending: false,
        workspaceMutationId: null,
      },
      get diff(): NativePanelBindings["diff"] {
        throw new Error("Unexpected diff binding");
      },
      get agents(): NativePanelBindings["agents"] {
        throw new Error("Unexpected agents binding");
      },
    };
    let renderer!: ReactTestRenderer;
    await controller.refresh();
    try {
      await act(async () => {
        renderer = create(
          <NativeRightPanel
            surface={surface}
            threadRef={threadRef}
            context={context}
            visible
            bindings={bindings}
          />,
        );
      });
      expect(JSON.stringify(renderer.toJSON())).not.toContain("Legacy private panel");
      const file = renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes("README.md"));
      expect(file).toBeDefined();
      await act(async () => {
        file!.props.onClick();
      });
      expect(JSON.stringify(renderer.toJSON())).toContain("Independent file contents");
      expect(calls.map((call) => call.id + "/" + call.method)).toEqual([
        "t3.file/presentation/open",
        "t3.workspace/files/listEntries",
        "t3.workspace/files/readText",
      ]);
      const callsBeforeUnrelatedChange = calls.length;
      let stopOtherEnvironment!: () => void;
      let stopOtherPlugin!: () => void;
      const peer = {
        subscribeApi: () => ({ async *[Symbol.asyncIterator]() {} }),
        invokeApi: vi.fn(),
        discoverApis: vi.fn(async () => []),
      };
      await act(async () => {
        stopOtherEnvironment = registerInstalledApiClient(
          "unrelated-environment",
          "unrelated.peer",
          peer,
        );
        stopOtherPlugin = registerInstalledApiClient(
          context.resource.environmentId,
          "unrelated.peer",
          peer,
        );
        setInstalledApiPolicy(context.resource.environmentId, {
          apiSelections: [],
          apiResolution: [
            { id: "t3.file/presentation", providerId: pkg.manifest.id },
            { id: "unrelated/api", providerId: "unrelated.peer" },
          ],
        });
      });
      expect(calls).toHaveLength(callsBeforeUnrelatedChange);
      expect(JSON.stringify(renderer.toJSON())).toContain("Independent file contents");
      await act(async () => {
        stopOtherEnvironment();
        stopOtherPlugin();
      });
      await act(async () => {
        renderer.unmount();
      });
      await act(async () => {
        renderer = create(
          <NativeRightPanel
            surface={surface}
            threadRef={threadRef}
            context={context}
            visible
            bindings={bindings}
          />,
        );
      });
      expect(JSON.stringify(renderer.toJSON())).toContain("Independent file contents");
      expect(calls.filter((call) => call.method === "readText")).toHaveLength(2);
      const currentFile = () => {
        const current = selectSelectedRightPanelSurface(
          useRightPanelStore.getState().byThreadKey,
          threadRef,
        );
        if (current?.kind !== "file") throw new Error("Expected actual store file surface");
        return current;
      };
      const fileView = (file: Extract<RightPanelSurface, { kind: "file" }>) => (
        <NativeRightPanel
          surface={file}
          threadRef={threadRef}
          context={context}
          visible
          bindings={Object.assign(Object.create(bindings) as NativePanelBindings, {
            files: { ...bindings.files!, surface: file },
          })}
        />
      );
      useRightPanelStore.getState().openFile(threadRef, "README.md");
      await act(async () => {
        renderer.update(fileView(currentFile()));
      });
      const chooseOther = async () => {
        await act(async () => {
          renderer.root
            .findAllByType("button")
            .find((button) => button.children.includes("other.txt"))!
            .props.onClick();
        });
      };
      await chooseOther();
      expect(JSON.stringify(renderer.toJSON())).toContain("Other file contents");
      const persistedFile = currentFile();
      await act(async () => {
        renderer.unmount();
      });
      await act(async () => {
        renderer = create(fileView(persistedFile));
      });
      expect(JSON.stringify(renderer.toJSON())).toContain("Other file contents");
      useRightPanelStore.getState().openFile(threadRef, "README.md", 7);
      await act(async () => {
        renderer.update(fileView(currentFile()));
      });
      expect(JSON.stringify(renderer.toJSON())).toContain("Independent file contents");
      expect(JSON.stringify(renderer.toJSON())).not.toContain("Other file contents");
      await chooseOther();
      useRightPanelStore.getState().closeSurface(threadRef, currentFile().id);
      useRightPanelStore.getState().openFile(threadRef, "README.md");
      await act(async () => {
        renderer.update(fileView(currentFile()));
      });
      expect(JSON.stringify(renderer.toJSON())).toContain("Independent file contents");
      await act(async () => {
        controller.dispose();
      });
      expect(JSON.stringify(renderer.toJSON())).not.toContain("Independent file contents");
    } finally {
      await act(async () => {
        renderer?.unmount();
        controller.dispose();
        setInstalledApiPolicy(context.resource.environmentId, null);
      });
    }
  },
);
