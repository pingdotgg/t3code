import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  buildProviderInstanceUpdatePatch,
  filterArchivedThreadGroups,
  formatDiagnosticsDescription,
} from "./SettingsPanels.logic";

const archivedGroups = [
  {
    project: {
      id: "project-docs",
      name: "Docs Portal",
      cwd: "/work/clients/docs",
    },
    threads: [
      {
        id: "thread-docs-bug",
        title: "Fix publishing bug",
        branch: "docs-fix",
        worktreePath: "/work/clients/docs/.worktrees/docs-fix",
      },
      {
        id: "thread-docs-copy",
        title: "Rewrite homepage copy",
        branch: null,
        worktreePath: null,
      },
    ],
  },
  {
    project: {
      id: "project-api",
      name: "API Service",
      cwd: "/work/services/api",
    },
    threads: [
      {
        id: "thread-api-cache",
        title: "Tune cache invalidation",
        branch: "cache-tuning",
        worktreePath: "/work/services/api/.worktrees/cache-tuning",
      },
    ],
  },
];

describe("archive thread search helpers", () => {
  it("returns all groups for an empty query", () => {
    expect(filterArchivedThreadGroups(archivedGroups, "  ")).toEqual(archivedGroups);
  });

  it("keeps all project threads when the project name matches", () => {
    const filtered = filterArchivedThreadGroups(archivedGroups, "docs portal");

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.project.id).toBe("project-docs");
    expect(filtered[0]?.threads.map((thread) => thread.id)).toEqual([
      "thread-docs-bug",
      "thread-docs-copy",
    ]);
  });

  it("keeps all project threads when the project cwd matches", () => {
    const filtered = filterArchivedThreadGroups(archivedGroups, "services api");

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.project.id).toBe("project-api");
    expect(filtered[0]?.threads.map((thread) => thread.id)).toEqual(["thread-api-cache"]);
  });

  it("keeps only matching threads when the thread title matches", () => {
    const filtered = filterArchivedThreadGroups(archivedGroups, "  HOMEpage  ");

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.project.id).toBe("project-docs");
    expect(filtered[0]?.threads.map((thread) => thread.id)).toEqual(["thread-docs-copy"]);
  });

  it("matches thread branch and worktree path", () => {
    expect(
      filterArchivedThreadGroups(archivedGroups, "cache-tuning")[0]?.threads.map(
        (thread) => thread.id,
      ),
    ).toEqual(["thread-api-cache"]);

    expect(
      filterArchivedThreadGroups(archivedGroups, "worktrees docs-fix")[0]?.threads.map(
        (thread) => thread.id,
      ),
    ).toEqual(["thread-docs-bug"]);
  });

  it("drops groups with no matches", () => {
    expect(filterArchivedThreadGroups(archivedGroups, "not-here")).toEqual([]);
  });
});

describe("formatDiagnosticsDescription", () => {
  it("collapses trace and metric URLs that share the same OTEL base path", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      }),
    ).toBe("Local trace file. Exporting OTEL to http://localhost:4318/v1/{traces,metrics}.");
  });

  it("keeps separate trace and metric URLs when their base paths differ", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:9000/v1/metrics",
      }),
    ).toBe(
      "Local trace file. Exporting OTEL traces to http://localhost:4318/v1/traces and metrics to http://localhost:9000/v1/metrics.",
    );
  });

  it("omits OTEL text when no exporter is enabled", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      }),
    ).toBe("Local trace file.");
  });
});

describe("buildProviderInstanceUpdatePatch", () => {
  it("promotes an edited default provider into providerInstances and resets the legacy provider", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        binaryPath: "/opt/t3/codex",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            binaryPath: "/legacy/codex",
          },
        },
      },
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: true,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers?.codex).toEqual(DEFAULT_SERVER_SETTINGS.providers.codex);
  });

  it("updates custom instances without touching legacy provider settings", () => {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        homePath: "/Users/example/.codex-personal",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: DEFAULT_SERVER_SETTINGS,
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: false,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers).toBeUndefined();
  });
});
