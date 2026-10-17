import {
  CivilizationDefaultConfig,
  CivilizationMessageId,
  CivilizationNoteId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type CivilizationEffectiveConfig,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  writable: false,
  observedOnly: true,
  sensitiveCalls: [] as unknown[],
  citizenCalls: [] as unknown[],
  pageCalls: [] as unknown[],
  mailHookInputs: [] as Array<readonly [string | null, string | null]>,
}));

const atoms = vi.hoisted(() => ({
  sensitive: Symbol("sensitive"),
  citizen: Symbol("citizen"),
  page: Symbol("page"),
}));

const environmentId = EnvironmentId.make("environment-ui3");
const projectId = ProjectId.make("project-ui3");
const threadId = ThreadId.make("thread-ui3");
const noteId = CivilizationNoteId.make("note-ui3");
const messageId = CivilizationMessageId.make("mail-ui3");

const EFFECTIVE = {
  config: CivilizationDefaultConfig,
  environmentRevision: 7,
  projectRevision: 9,
  provenance: [],
  selectedNameProbabilities: [],
  selectedProfileProbabilities: [],
} satisfies CivilizationEffectiveConfig;

const citizen = {
  threadId,
  projectId,
  name: "Observed Ada",
  profileId: "calm",
  profileLabel: "Calm",
  generation: 1,
  lineageStatus: "resolved",
  parentThreadId: null,
  relationshipToParent: null,
  observedOnly: true,
  epoch: 2,
  closed: false,
  deleted: false,
  titleManaged: false,
  revision: 3,
} as const;

const note = {
  noteId,
  projectId,
  category: "fact",
  bodyBytes: 9,
  authorThreadId: threadId,
  authorEpoch: 2,
  acceptedRuntimeMode: "full-access",
  acceptedInteractionMode: "default",
  revision: 4,
  createdAt: "2026-10-16T18:00:00.000Z",
  updatedAt: "2026-10-16T18:01:00.000Z",
  resolvedAt: null,
} as const;

const mail = {
  messageId,
  senderThreadId: threadId,
  senderNameAtSend: "Ada",
  senderCitizenEpoch: 2,
  senderRunId: "run-ui3",
  recipientThreadId: threadId,
  recipientDeliveryEpoch: 3,
  replyToMessageId: null,
  bodyBytes: 11,
  acceptedRuntimeMode: "full-access",
  acceptedInteractionMode: "default",
  acceptedEnvironmentRevision: 7,
  acceptedProjectRevision: 9,
  acceptedAt: "2026-10-16T18:00:00.000Z",
  expiresAt: "2026-10-17T18:00:00.000Z",
  terminalRetentionDays: 30,
  firstOfferedAt: null,
  lastOfferedAt: null,
  offerCount: 0,
  acknowledgedAt: null,
  terminalAt: null,
  terminalReason: null,
} as const;

vi.mock("@effect/atom-react", () => ({
  useAtomSet: (atom: symbol) => async (input: unknown) => {
    if (atom === atoms.sensitive) {
      testState.sensitiveCalls.push(input);
      const typed = input as { type: string };
      return typed.type === "noteBody"
        ? { ...note, body: "secret note body", sourceReferences: [] }
        : { projectId, ...mail, body: "secret mail body" };
    }
    if (atom === atoms.citizen) {
      testState.citizenCalls.push(input);
      const typed = input as { type: string; request?: Record<string, unknown> };
      if (typed.type === "reassignmentPreview") {
        return {
          threadId,
          citizenRevision: 3,
          environmentRevision: 7,
          projectRevision: 9,
          current: {
            nameEntryId: "ada",
            name: "Observed Ada",
            profileEntryId: "calm",
            profileLabel: "Calm",
          },
          proposed: {
            nameEntryId: "ada",
            name: String(typed.request?.displayName ?? "Observed Ada"),
            profileEntryId: String(typed.request?.profileEntryId ?? "calm"),
            profileLabel: "Preview profile",
          },
        };
      }
      return { ...citizen, observedOnly: testState.observedOnly };
    }
    testState.pageCalls.push(input);
    throw new Error("Unexpected load-more action in test.");
  },
}));

vi.mock("../../state/civilization", () => ({
  civilizationCitizenAction: atoms.citizen,
  civilizationProjectReadAction: atoms.page,
  civilizationSensitiveReadAction: atoms.sensitive,
  mergeCivilizationRevisionPage: (current: unknown) => current,
  useCivilizationCensusPage: () => ({
    data: {
      projectId,
      revision: 10,
      citizens: [{ ...citizen, observedOnly: testState.observedOnly }],
      nextCursor: null,
      partial: false,
    },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
  useCivilizationNotesPage: () => ({
    data: { projectId, revision: 11, notes: [note], nextCursor: null, partial: false },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
  useCivilizationRetainedMailPage: (environment: string | null, project: string | null) => {
    testState.mailHookInputs.push([environment, project]);
    return {
      data:
        environment === null
          ? null
          : { projectId, revision: 12, messages: [mail], nextCursor: null, partial: false },
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

vi.mock("../ui/switch", () => ({
  Switch: ({ onCheckedChange: _onCheckedChange, ...props }: Record<string, unknown>) => (
    <input type="checkbox" {...props} />
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

vi.mock("./CivilizationDataRetention", () => ({
  CivilizationDataRetention: () => <div data-testid="civilization-data-retention" />,
}));

import { CivilizationProjectInspection } from "./CivilizationProjectInspection";

let renderer: ReactTestRenderer | undefined;

const render = async (allowSensitiveActions = true) => {
  await act(() => {
    renderer = create(
      <CivilizationProjectInspection
        environmentId={environmentId}
        projectId={projectId}
        targetLabel="UI-3 machine"
        effective={EFFECTIVE}
        allowSensitiveActions={allowSensitiveActions}
      />,
    );
  });
};

const text = () => JSON.stringify(renderer?.toJSON());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.writable = false;
  testState.observedOnly = true;
  testState.sensitiveCalls = [];
  testState.citizenCalls = [];
  testState.pageCalls = [];
  testState.mailHookInputs = [];
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("Civilization project inspection", () => {
  it("shows census and note metadata to read-only users without fetching sensitive bodies or retained mail", async () => {
    await render();

    expect(text()).toContain("Observed Ada");
    expect(text()).toContain("fact");
    expect(text()).toContain("Provider-owned · read only");
    expect(text()).toContain("Retained mail");
    expect(text()).toContain("Restricted");
    expect(testState.sensitiveCalls).toEqual([]);
    expect(testState.citizenCalls).toEqual([]);
    expect(testState.mailHookInputs.every(([environment]) => environment === null)).toBe(true);
    expect(text()).not.toContain("Reassign identity");
    expect(text()).not.toContain("Restore title");
    expect(text()).not.toContain("Reclaim title");
  });

  it("fetches note and retained-mail bodies only after explicit settings-write clicks", async () => {
    testState.writable = true;
    await render();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(testState.sensitiveCalls).toEqual([]);
    const openButtons = renderer!.root
      .findAllByType("button")
      .filter((button) => button.props.children === "Open body");
    expect(openButtons).toHaveLength(2);

    await act(async () => {
      openButtons[0]!.props.onClick();
      await Promise.resolve();
    });
    expect(testState.sensitiveCalls).toHaveLength(1);
    expect(testState.sensitiveCalls[0]).toMatchObject({ type: "noteBody", noteId });
    expect(text()).toContain("secret note body");

    await act(async () => {
      openButtons[1]!.props.onClick();
      await Promise.resolve();
    });
    expect(testState.sensitiveCalls).toHaveLength(2);
    expect(testState.sensitiveCalls[1]).toMatchObject({ type: "mailBody", messageId });
    expect(text()).toContain("secret mail body");

    const logged = [logSpy, infoSpy, warnSpy, errorSpy]
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map(String)
      .join("\n");
    expect(logged).not.toContain("secret note body");
    expect(logged).not.toContain("secret mail body");
  });

  it("keeps sensitive project actions disabled when multiple environments are selected", async () => {
    testState.writable = true;
    await render(false);

    expect(text()).toContain("Select one environment");
    expect(text()).not.toContain("Open body");
    expect(testState.sensitiveCalls).toEqual([]);
  });

  it("previews with exact captured revisions and blocks apply when settings:write is revoked", async () => {
    testState.writable = true;
    testState.observedOnly = false;
    await render();

    expect(text()).toContain("Reassign identity");
    const nameInput = renderer!.root
      .findAllByType("input")
      .find((input) => input.props.value === "Observed Ada");
    expect(nameInput).toBeDefined();
    await act(() => nameInput!.props.onChange({ currentTarget: { value: "Grace Admin" } }));

    const previewButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Preview");
    expect(previewButton).toBeDefined();
    await act(async () => {
      previewButton!.props.onClick();
      await Promise.resolve();
    });

    expect(testState.citizenCalls).toHaveLength(1);
    expect(testState.citizenCalls[0]).toMatchObject({
      type: "reassignmentPreview",
      request: {
        threadId,
        projectId,
        expectedCitizenRevision: 3,
        expectedEnvironmentRevision: 7,
        expectedProjectRevision: 9,
        displayName: "Grace Admin",
      },
    });
    expect(text()).toContain("Grace Admin");

    testState.writable = false;
    const applyButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Apply preview");
    expect(applyButton).toBeDefined();
    await act(() => applyButton!.props.onClick());

    expect(testState.citizenCalls).toHaveLength(1);
    expect(text()).toContain("Permission changed before apply");
  });
});
