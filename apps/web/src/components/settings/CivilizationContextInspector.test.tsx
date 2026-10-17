import {
  CivilizationContextInspectionId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  type CivilizationContextInspectionDetail,
  type CivilizationContextInspectionSummary,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  writable: false,
  sensitiveCalls: [] as unknown[],
  pageCalls: [] as unknown[][],
  detailMode: "retained" as "retained" | "unavailable",
}));

const sensitiveAtom = vi.hoisted(() => Symbol("civilization-sensitive"));
const environmentId = EnvironmentId.make("environment-context-inspector");
const projectId = ProjectId.make("project-context-inspector");
const threadId = ThreadId.make("thread-context-inspector");
const inspectionId = CivilizationContextInspectionId.make("context-inspection-ui");
const runId = RunId.make("run-context-inspector");
const attemptId = RunAttemptId.make("attempt-context-inspector");
const providerInstanceId = ProviderInstanceId.make("codex-main");
const providerDriver = ProviderDriverKind.make("codex");
const packetText = `<t3_civilization_packet_v1>\n${"x".repeat(12_000)}\n</t3_civilization_packet_v1>`;

const summary: CivilizationContextInspectionSummary = {
  inspectionId,
  projectId,
  threadId,
  runId,
  attemptId,
  providerTurnOrdinal: 2,
  providerInstanceId,
  providerDriver,
  outcome: "provider_start_accepted",
  suppressionReason: null,
  diagnosticsMode: "normal",
  packetTextState: "retained_normal",
  transport: {
    kind: "codex.additional_context",
    description: "turn/start params.additionalContext.t3_civilization.value",
    trust: "untrusted",
  },
  packetRevision: "sha256:revision",
  packetHash: "sha256:packet",
  packetBytes: 12_100,
  composition: {
    roster: { candidates: 4, included: 3, omitted: 1 },
    notes: { candidates: 2, included: 1, omitted: 1 },
    inbox: { candidates: 1, included: 1, omitted: 0 },
  },
  budget: {
    limitBytes: 16_384,
    packetBytes: 12_100,
    requiredBytes: 4_000,
    rosterBytes: 3_000,
    noteBytes: 2_000,
    inboxBytes: 3_100,
    unusedBytes: 4_284,
  },
  contextReferenceId: "context-reference-ui",
  environmentRevision: 7,
  projectRevision: 9,
  citizenRevision: 3,
  censusRevision: 12,
  notesRevision: 13,
  inboxRevision: 14,
  createdAt: "2026-10-16T20:00:00.000Z",
  updatedAt: "2026-10-16T20:00:01.000Z",
  providerStartAt: "2026-10-16T20:00:01.000Z",
};

const retainedDetail: CivilizationContextInspectionDetail = {
  ...summary,
  selectedCitizenIds: [threadId],
  selectedNoteIds: [],
  selectedInboxIds: [],
  packetText,
};

const unavailableDetail: CivilizationContextInspectionDetail = {
  ...summary,
  diagnosticsMode: "errors",
  packetTextState: "errors_only_accepted_cleared",
  selectedCitizenIds: [threadId],
  selectedNoteIds: [],
  selectedInboxIds: [],
  packetText: null,
};

vi.mock("@effect/atom-react", () => ({
  useAtomSet: () => async (input: unknown) => {
    testState.sensitiveCalls.push(input);
    return testState.detailMode === "retained" ? retainedDetail : unavailableDetail;
  },
}));

vi.mock("../../state/civilization", () => ({
  civilizationSensitiveReadAction: sensitiveAtom,
  useCivilizationContextInspectionPage: (...args: unknown[]) => {
    testState.pageCalls.push(args);
    return {
      data: {
        projectId,
        inspections: [summary],
        nextCursor: null,
        partial: false,
      },
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
  },
}));

vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => testState.writable,
  readEnvironmentScope: () => testState.writable,
}));

vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("../ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));

vi.mock("../ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  SelectPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <div {...props}>{children}</div>
  ),
  SelectValue: () => <span />,
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
}));

import { CivilizationContextInspector } from "./CivilizationContextInspector";

let renderer: ReactTestRenderer | undefined;
const render = async (
  initialFilters?: React.ComponentProps<typeof CivilizationContextInspector>["initialFilters"],
) => {
  await act(() => {
    renderer = create(
      <CivilizationContextInspector
        environmentId={environmentId}
        projectId={projectId}
        targetLabel="Inspector machine"
        initialFilters={initialFilters}
      />,
    );
  });
};
const text = () => JSON.stringify(renderer?.toJSON());
const buttons = () => renderer?.root.findAllByType("button") ?? [];
const buttonNamed = (name: string) => buttons().find((button) => button.props.children === name);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.writable = false;
  testState.sensitiveCalls = [];
  testState.pageCalls = [];
  testState.detailMode = "retained";
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("Civilization context inspector", () => {
  it("renders metadata and all turn filters without prefetching sensitive detail", async () => {
    await render();
    expect(text()).toContain("Context inspector");
    expect(text()).toContain("historical records");
    expect(text()).toContain(String(runId));
    expect(text()).toContain(String(attemptId));
    expect(text()).toContain("provider turn ");
    expect(text()).toContain("Detail requires settings:write");
    expect(text()).not.toContain(packetText);
    expect(testState.sensitiveCalls).toEqual([]);

    const labels = renderer?.root.findAllByType("input").map((input) => input.props["aria-label"]);
    expect(labels).toEqual([
      "Context inspector thread ID",
      "Context inspector provider",
      "Context inspector run ID",
      "Context inspector attempt ID",
      "Context inspector provider turn",
    ]);
    expect(
      renderer?.root.findAll((node) => node.props["aria-label"] === "Context inspector outcome")
        .length,
    ).toBeGreaterThan(0);
  });

  it("applies route-provided historical identity to the first metadata query", async () => {
    await render({
      threadId,
      runId,
      attemptId,
      providerTurnOrdinal: 2,
    });
    const latest = testState.pageCalls.at(-1);
    expect(latest?.[0]).toBe(environmentId);
    expect(latest?.[1]).toBe(projectId);
    expect(latest?.[2]).toEqual({ threadId, runId, attemptId, providerTurnOrdinal: 2 });
    expect(latest?.[3]).toBeNull();
    expect(latest?.[4]).toBe(25);
    expect(testState.sensitiveCalls).toEqual([]);
  });

  it("loads exact packet detail only after an explicit settings-write Inspect click", async () => {
    testState.writable = true;
    await render();
    expect(testState.sensitiveCalls).toEqual([]);
    expect(text()).not.toContain(packetText);

    await act(async () => {
      buttonNamed("Inspect")?.props.onClick();
      await Promise.resolve();
    });

    expect(testState.sensitiveCalls).toEqual([
      { type: "contextInspection", environmentId, projectId, inspectionId },
    ]);
    const packetPre = renderer?.root.findAllByType("pre")[0];
    expect(packetPre?.props.children).toBe(packetText);
    expect(text()).toContain("Provider start accepted");
    expect(text()).toContain("Packet budget");
    expect(text()).toContain("Provenance");
    expect(buttonNamed("Copy")).toBeDefined();
    expect(buttonNamed("Download text")).toBeDefined();
    expect(packetPre?.props.className).toContain("max-h-[28rem]");
    expect(packetPre?.props.className).toContain("overflow-auto");
  });

  it("explains when diagnostics policy cleared the historical packet body", async () => {
    testState.writable = true;
    testState.detailMode = "unavailable";
    await render();
    await act(async () => {
      buttonNamed("Inspect")?.props.onClick();
      await Promise.resolve();
    });
    expect(text()).toContain("cleared after the provider accepted the start");
    expect(text()).not.toContain(packetText);
    expect(buttonNamed("Copy")).toBeUndefined();
  });
});
