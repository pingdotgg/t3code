import {
  CivilizationDefaultConfig,
  EnvironmentId,
  ProjectId,
  type CivilizationEffectiveConfig,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const atoms = vi.hoisted(() => ({ data: Symbol("data") }));
const testState = vi.hoisted(() => ({
  writable: true,
  calls: [] as unknown[],
  purgeResponses: [] as unknown[],
  refreshes: 0,
}));

const environmentId = EnvironmentId.make("environment-ui4");
const projectId = ProjectId.make("project-ui4");
const EFFECTIVE = {
  config: CivilizationDefaultConfig,
  environmentRevision: 4,
  projectRevision: 8,
  provenance: [],
  selectedNameProbabilities: [],
  selectedProfileProbabilities: [],
} satisfies CivilizationEffectiveConfig;

vi.mock("@effect/atom-react", () => ({
  useAtomSet: () => async (input: unknown) => {
    testState.calls.push(input);
    const typed = input as { type: string };
    switch (typed.type) {
      case "export":
        return {
          schemaVersion: 1,
          projectId,
          exportedAt: "2026-10-16T18:00:00.000Z",
          environmentRevision: 4,
          projectRevision: 8,
          effectiveConfig: CivilizationDefaultConfig,
          limitations: {
            mode: "inspection_backup_only",
            inspectionBackupOnly: true,
            restorable: false,
            excluded: ["provider transcripts", "external backups"],
          },
          citizens: [],
          notes: [],
          mail: [],
        };
      case "retentionGet":
        return { noteRetentionDays: 30, diagnosticRetentionDays: 7, tombstoneRetentionDays: 30 };
      case "retentionPreview":
        return {
          projectId,
          previewToken: "retention-token",
          environmentRevision: 4,
          projectRevision: 8,
          current: {
            noteRetentionDays: 30,
            diagnosticRetentionDays: 7,
            tombstoneRetentionDays: 30,
          },
          configured: {
            noteRetentionDays: 7,
            diagnosticRetentionDays: 3,
            tombstoneRetentionDays: 14,
          },
          proposed: {
            noteRetentionDays: 7,
            diagnosticRetentionDays: 3,
            tombstoneRetentionDays: 14,
          },
          newlyEligible: {
            resolvedNotes: 2,
            resolvedNoteBodyBytes: 64,
            diagnosticReferences: 1,
            diagnosticInspections: 2,
            tombstones: 1,
          },
          samples: {
            noteIds: ["note:old"],
            contextReferenceIds: ["context:old"],
            contextInspectionIds: ["inspection:old"],
            tombstoneThreadIds: ["thread:old"],
            partial: true,
          },
          warnings: ["Retention cleanup is irreversible."],
        };
      case "retentionApply":
        return {
          projectId,
          applied: { noteRetentionDays: 7, diagnosticRetentionDays: 3, tombstoneRetentionDays: 14 },
          newlyEligible: {
            resolvedNotes: 2,
            resolvedNoteBodyBytes: 64,
            diagnosticReferences: 1,
            diagnosticInspections: 2,
            tombstones: 1,
          },
        };
      case "purgePreview":
        return {
          projectId,
          previewToken: "purge-token",
          environmentRevision: 4,
          projectRevision: 8,
          censusRevision: 10,
          notesRevision: 11,
          mailRevision: 12,
          counts: {
            citizens: 1,
            notes: 2,
            noteBodyBytes: 64,
            messages: 3,
            messageBodyBytes: 128,
            contextReferences: 4,
            contextInspections: 7,
            receipts: 5,
            quotaWindows: 6,
            projectConfigRows: 1,
            projectStateRows: 1,
          },
          limitations: {
            mode: "inspection_backup_only",
            inspectionBackupOnly: true,
            restorable: false,
            excluded: ["provider transcripts", "external backups"],
          },
          warnings: ["This does not erase provider transcripts."],
        };
      case "purgeApply": {
        const response = testState.purgeResponses.shift();
        if (response instanceof Error) throw response;
        return response;
      }
      default:
        throw new Error(`Unexpected action ${typed.type}`);
    }
  },
}));

vi.mock("../../state/civilization", () => ({
  civilizationDataAction: atoms.data,
  refreshCivilizationOverview: () => {
    testState.refreshes += 1;
  },
}));

vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => testState.writable,
}));

vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("../ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
}));

vi.mock("./settingsLayout", () => ({
  SettingsSection: ({
    children,
    title,
    id,
  }: {
    children: ReactNode;
    title: string;
    id?: string;
  }) => (
    <section id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
  }) => (
    <div>
      <span>{title}</span>
      <span>{description}</span>
      {control}
    </div>
  ),
}));

import { CivilizationDataRetention } from "./CivilizationDataRetention";

let renderer: ReactTestRenderer | undefined;

const render = async (enabled = true) => {
  await act(() => {
    renderer = create(
      <CivilizationDataRetention
        environmentId={environmentId}
        projectId={projectId}
        environmentLabel="UI-4 machine"
        effective={EFFECTIVE}
        enabled={enabled}
        refreshProjectData={() => {
          testState.refreshes += 1;
        }}
      />,
    );
  });
};

const button = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.props.children === label);
const text = () => JSON.stringify(renderer?.toJSON());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:test"),
    revokeObjectURL: vi.fn(),
  });
  vi.stubGlobal("document", {
    createElement: () => ({ href: "", download: "", click: vi.fn() }),
  });
  testState.writable = true;
  testState.calls = [];
  testState.purgeResponses = [];
  testState.refreshes = 0;
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("Civilization data and retention", () => {
  it("exports only on explicit action and shows inspection-only limitations", async () => {
    await render();
    expect(testState.calls).toEqual([]);

    await act(async () => {
      button("Export JSON")!.props.onClick();
      await Promise.resolve();
    });

    expect(testState.calls).toEqual([{ environmentId, projectId, type: "export" }]);
    expect(text()).toContain("Inspection/backup only");
    expect(text()).toContain("restorable: no");
    expect(text()).toContain("provider transcripts");
    expect(text()).toContain("external backups");
  });

  it("uses the exact retention preview token and blocks apply after permission revocation", async () => {
    await render();
    await act(async () => {
      button("Preview reduction")!.props.onClick();
      await Promise.resolve();
    });

    expect(testState.calls).toHaveLength(1);
    expect(testState.calls[0]).toEqual({ environmentId, projectId, type: "retentionPreview" });
    expect(text()).toContain("Retention cleanup is irreversible.");
    expect(text()).toContain("sample list is partial");

    testState.writable = false;
    await act(() => button("Apply reduction")!.props.onClick());
    expect(testState.calls).toHaveLength(1);
    expect(text()).toContain("Permission changed");

    testState.writable = true;
    await act(async () => {
      button("Apply reduction")!.props.onClick();
      await Promise.resolve();
    });
    expect(testState.calls[1]).toEqual({
      environmentId,
      projectId,
      type: "retentionApply",
      expectedPreviewToken: "retention-token",
    });
    expect(
      testState.calls.filter((call) => (call as { type: string }).type === "retentionPreview"),
    ).toHaveLength(1);
  });

  it("purges in bounded batches with one reviewed token and never silently re-previews", async () => {
    testState.purgeResponses = [
      {
        projectId,
        complete: false,
        deletedThisBatch: 100,
        remaining: 4,
        progressState: "in_progress",
        purgeStartedAt: "2026-10-16T18:00:00.000Z",
        purgeCompletedAt: null,
      },
      {
        projectId,
        complete: true,
        deletedThisBatch: 4,
        remaining: 0,
        progressState: "complete",
        purgeStartedAt: "2026-10-16T18:00:00.000Z",
        purgeCompletedAt: "2026-10-16T18:01:00.000Z",
      },
    ];
    await render();

    await act(async () => {
      button("Preview purge")!.props.onClick();
      await Promise.resolve();
    });
    expect(text()).toContain("This does not erase provider transcripts.");
    expect(text()).toContain("external backups");

    await act(async () => {
      button("Purge this project")!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const purgeCalls = testState.calls.filter(
      (call) => (call as { type: string }).type === "purgeApply",
    );
    expect(purgeCalls).toEqual([
      {
        environmentId,
        projectId,
        type: "purgeApply",
        expectedPreviewToken: "purge-token",
        batchSize: CivilizationDefaultConfig.operations.cleanupBatch,
      },
      {
        environmentId,
        projectId,
        type: "purgeApply",
        expectedPreviewToken: "purge-token",
        batchSize: CivilizationDefaultConfig.operations.cleanupBatch,
      },
    ]);
    expect(
      testState.calls.filter((call) => (call as { type: string }).type === "purgePreview"),
    ).toHaveLength(1);
    expect(testState.refreshes).toBe(2);
    expect(text()).toContain("Civilization project purge completed.");
  });

  it("stops after partial purge progress on error and requires a fresh preview", async () => {
    testState.purgeResponses = [
      {
        projectId,
        complete: false,
        deletedThisBatch: 100,
        remaining: 4,
        progressState: "in_progress",
        purgeStartedAt: "2026-10-16T18:00:00.000Z",
        purgeCompletedAt: null,
      },
      new Error("preview token conflict"),
    ];
    await render();
    await act(async () => {
      button("Preview purge")!.props.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      button("Purge this project")!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      testState.calls.filter((call) => (call as { type: string }).type === "purgePreview"),
    ).toHaveLength(1);
    expect(
      testState.calls.filter((call) => (call as { type: string }).type === "purgeApply"),
    ).toHaveLength(2);
    expect(text()).toContain("The purge stopped; a new preview is required before continuing.");
    expect(testState.refreshes).toBe(0);
  });
});
