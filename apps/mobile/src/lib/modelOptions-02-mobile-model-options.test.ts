import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerConfig,
  type ServerSettings,
} from "@t3tools/contracts";

import {
  buildModelOptions,
  describeUnavailableModelSelection,
  groupByProvider,
  isModelSelectionUnavailable,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
  resolveSelectableModelSelection,
  type ModelOption,
} from "./modelOptions";




describe("mobile model options", () => {
  describe("project-aware enablement", () => {
    const projectId = ProjectId.make("project-a");
    const instanceId = ProviderInstanceId.make("codex_work");

    function configWith(settings: ServerSettings): ServerConfig {
      return {
        providers: [
          {
            instanceId,
            driver: "codex",
            displayName: "Codex Work",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            models: [{ slug: "model-a", name: "Model A", isCustom: false, capabilities: null }],
          },
        ],
        settings,
      } as unknown as ServerConfig;
    }

    it("refuses to send a non-Antigravity model the project turned off", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
        },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      };
      const selection = { instanceId, model: "model-a" };

      expect(isModelSelectionUnavailable(configWith(settings), selection, projectId)).toBe(true);
      expect(isModelSelectionUnavailable(configWith(settings), selection, null)).toBe(false);
    });

    it("hides an instance the project disables even though the machine enables it", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
        },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      };

      expect(buildModelOptions(configWith(settings), null, undefined, projectId)).toEqual([]);
    });

    it("hides a machine-disabled instance for a project with no override, even though another project's keep-alive left it running", () => {
      const otherProjectId = ProjectId.make("project-b");
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
        },
        projectSettingsOverrides: {
          [otherProjectId]: { providerInstances: { [instanceId]: { enabled: true } } },
        },
      };

      expect(buildModelOptions(configWith(settings), null, undefined, projectId)).toEqual([]);
    });

    it("refuses to send an instance the project merely inherits as disabled, not just an explicit override", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
        },
      };
      const selection = { instanceId, model: "model-a" };

      expect(isModelSelectionUnavailable(configWith(settings), selection, projectId)).toBe(true);
      expect(
        describeUnavailableModelSelection(configWith(settings), selection, projectId).title,
      ).toBe("Model turned off for this project");
      expect(isModelSelectionUnavailable(configWith(settings), selection, null)).toBe(true);
    });

    it("marks a project-disabled instance's fallback selection unavailable instead of reviving it", () => {
      const settings: ServerSettings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
        },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      };
      const fallback = { instanceId, model: "model-a" };

      const options = buildModelOptions(configWith(settings), fallback, undefined, projectId);

      expect(options).toHaveLength(1);
      expect(options[0]).toMatchObject({ selection: fallback, isUnavailable: true });
    });

    it("rejects a project-disabled antigravity instance's selection instead of keeping it", () => {
      const antigravityInstanceId = ProviderInstanceId.make("antigravity_work");
      const config = {
        providers: [
          {
            instanceId: antigravityInstanceId,
            driver: "antigravity",
            displayName: "Antigravity Work",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            availability: "available",
            models: [{ slug: "model-a", name: "Model A", isCustom: false, capabilities: null }],
          },
        ],
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [antigravityInstanceId]: {
              driver: ProviderDriverKind.make("antigravity"),
              enabled: true,
            },
          },
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [antigravityInstanceId]: { enabled: false } } },
          },
        },
      } as unknown as ServerConfig;
      const selection = { instanceId: antigravityInstanceId, model: "model-a" };

      expect(resolveSelectableModelSelection(config, selection, projectId)).toBeNull();
      expect(resolveSelectableModelSelection(config, selection, null)).toBe(selection);
      expect(
        resolveSelectableModelSelection({ ...config, providers: [] }, selection, projectId),
      ).toBeNull();
    });
  });
});

