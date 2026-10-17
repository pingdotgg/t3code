import {
  CivilizationDefaultConfig,
  EnvironmentId,
  ProjectId,
  type CivilizationEffectiveConfig,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ writable: true }));

vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => state.writable,
}));

vi.mock("../../state/civilization", () => ({
  civilizationConfigExpectedRevision: (
    effective: CivilizationEffectiveConfig,
    projectId: string | null,
  ) => (projectId === null ? effective.environmentRevision : effective.projectRevision),
}));

vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));

vi.mock("../ui/textarea", () => ({
  Textarea: (props: Record<string, unknown>) => <textarea {...props} />,
}));

vi.mock("../ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

import {
  CivilizationNamePoolEditorDialog,
  CivilizationProfilePoolEditorDialog,
} from "./CivilizationPoolEditorDialogs";

const EFFECTIVE = {
  config: CivilizationDefaultConfig,
  environmentRevision: 7,
  projectRevision: 4,
  provenance: [],
  selectedNameProbabilities: [{ id: "ada", weight: 6, totalWeight: 10, probability: 0.6 }],
  selectedProfileProbabilities: [],
} satisfies CivilizationEffectiveConfig;

let renderer: ReactTestRenderer | undefined;

const text = () => JSON.stringify(renderer?.toJSON());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.writable = true;
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("Civilization pool editor validation", () => {
  it.each([
    "invalid_pool_reference",
    "duplicate_id",
    "unsafe_weight_total",
    "invalid_limit",
  ] as const)("surfaces the typed %s reason from server validation", async (reason) => {
    const runConfigAction = vi.fn().mockRejectedValue({
      _tag: "CivilizationConfigInvalidError",
      code: "civilization_invalid_config",
      reason,
      message: `Rejected ${reason}.`,
    });

    await act(() => {
      renderer = create(
        <CivilizationNamePoolEditorDialog
          open
          onOpenChange={vi.fn()}
          environmentId={EnvironmentId.make("environment-pools")}
          projectId={ProjectId.make("project-pools")}
          targetLabel="Pool machine"
          effective={EFFECTIVE}
          runConfigAction={runConfigAction}
          refresh={vi.fn()}
          maxPools={16}
          maxEntries={10_000}
          maxWeight={1_000_000}
        />,
      );
    });
    const preview = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Validate & preview");
    await act(async () => {
      preview!.props.onClick();
      await Promise.resolve();
    });

    expect(runConfigAction).toHaveBeenCalledTimes(1);
    expect(text()).toContain(reason);
    expect(text()).toContain(`Rejected ${reason}.`);
  });

  it("requires validate and diff before an exact-revision pool save", async () => {
    const environmentId = EnvironmentId.make("environment-pools");
    const projectId = ProjectId.make("project-pools");
    const onOpenChange = vi.fn();
    const refresh = vi.fn();
    const runConfigAction = vi
      .fn()
      .mockResolvedValueOnce({ valid: true, effective: EFFECTIVE })
      .mockResolvedValueOnce({ changes: [{ path: "names.pools" }], effective: EFFECTIVE })
      .mockResolvedValueOnce({ revision: 5, effective: { ...EFFECTIVE, projectRevision: 5 } });

    await act(() => {
      renderer = create(
        <CivilizationNamePoolEditorDialog
          open
          onOpenChange={onOpenChange}
          environmentId={environmentId}
          projectId={projectId}
          targetLabel="Pool machine"
          effective={EFFECTIVE}
          runConfigAction={runConfigAction}
          refresh={refresh}
          maxPools={16}
          maxEntries={10_000}
          maxWeight={1_000_000}
        />,
      );
    });
    const preview = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Validate & preview");
    await act(async () => {
      preview!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    const save = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Save pools");
    await act(async () => {
      save!.props.onClick();
      await Promise.resolve();
    });

    expect(runConfigAction.mock.calls.map(([input]) => input.type)).toEqual([
      "validate",
      "diff",
      "set",
    ]);
    expect(runConfigAction.mock.calls[2]?.[0]).toMatchObject({
      environmentId,
      projectId,
      expectedRevision: 4,
      type: "set",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps one stable profile entry paired with complete mild and rich variants", async () => {
    const environmentId = EnvironmentId.make("environment-profile-pools");
    const projectId = ProjectId.make("project-profile-pools");
    const runConfigAction = vi
      .fn()
      .mockResolvedValueOnce({ valid: true, effective: EFFECTIVE })
      .mockResolvedValueOnce({ changes: [{ path: "personalities.pools" }], effective: EFFECTIVE });

    await act(() => {
      renderer = create(
        <CivilizationProfilePoolEditorDialog
          open
          onOpenChange={vi.fn()}
          environmentId={environmentId}
          projectId={projectId}
          targetLabel="Profile machine"
          effective={EFFECTIVE}
          runConfigAction={runConfigAction}
          refresh={vi.fn()}
          maxPools={16}
          maxEntries={100}
          maxWeight={1_000_000}
        />,
      );
    });

    expect(text()).toContain("Stoic Architect");
    expect(text()).toContain("Rendering strength changes expression only");

    const mildStyle = renderer!.root.findByProps({ "aria-label": "Profile entry 1 style text" });
    const richAxiom = renderer!.root.findByProps({ "aria-label": "Profile entry 1 rich axiom" });
    await act(() => mildStyle.props.onChange({ currentTarget: { value: "Mild edited." } }));
    await act(() => richAxiom.props.onChange({ currentTarget: { value: "Rich edited axiom." } }));

    const preview = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Validate & preview");
    await act(async () => {
      preview!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    const firstOverride = runConfigAction.mock.calls[0]?.[0].override;
    const firstEntry = firstOverride.personalities.pools[0].entries[0];
    expect(firstEntry.id).toBe("calm");
    expect(firstEntry.styleText).toBe("Mild edited.");
    expect(firstEntry.rich).toMatchObject({
      label: "Stoic Architect",
      axiom: "Rich edited axiom.",
    });
    expect(firstEntry.rich.traits).toEqual(["deliberate", "composed", "structural"]);
  });

  it("creates a new profile with a complete rich variant before validation", async () => {
    const runConfigAction = vi.fn().mockRejectedValue({
      _tag: "CivilizationConfigInvalidError",
      code: "civilization_invalid_config",
      reason: "invalid_profile",
      message: "New profile is incomplete.",
    });

    await act(() => {
      renderer = create(
        <CivilizationProfilePoolEditorDialog
          open
          onOpenChange={vi.fn()}
          environmentId={EnvironmentId.make("environment-profile-add")}
          projectId={ProjectId.make("project-profile-add")}
          targetLabel="Profile add machine"
          effective={EFFECTIVE}
          runConfigAction={runConfigAction}
          refresh={vi.fn()}
          maxPools={16}
          maxEntries={100}
          maxWeight={1_000_000}
        />,
      );
    });

    const add = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Add profile");
    await act(() => add!.props.onClick());

    const preview = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Validate & preview");
    await act(async () => {
      preview!.props.onClick();
      await Promise.resolve();
    });

    const override = runConfigAction.mock.calls[0]?.[0].override;
    const added = override.personalities.pools[0].entries.at(-1);
    expect(added).toMatchObject({
      label: "",
      traits: [],
      styleText: "",
      rich: { label: "", traits: [], axiom: "", voice: "", styleText: "" },
      weight: 1,
    });
  });
});
