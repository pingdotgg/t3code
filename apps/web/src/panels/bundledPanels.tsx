import { FileDiff, Globe2 } from "lucide-react";
import { Suspense, type ComponentType } from "react";

import { createPanelRegistry, type PanelMetadata, type PanelProps } from "./panelRegistry";

const bundledPanels = createPanelRegistry([
  {
    id: "diff",
    title: "Diff",
    icon: FileDiff,
    launcherKey: "D",
    unavailableHint: "Available for Git repositories.",
    unavailableReason: "Diff is only available for server threads in Git repositories.",
    load: () => import("./diff/DiffSidePanel"),
  },
  {
    id: "preview",
    title: "Browser",
    icon: Globe2,
    launcherKey: "B",
    unavailableHint: "Only available in the desktop app.",
    unavailableReason: "Browser previews are only available in the T3 Code desktop app.",
    load: () => import("./preview/PreviewSidePanel"),
  },
]);

export type SidePanelId = (typeof bundledPanels.definitions)[number]["id"];

/** Metadata for launchers and tabs; reading it never loads a panel body. */
export function getSidePanelMetadata(id: SidePanelId): PanelMetadata {
  return bundledPanels.get(id);
}

type SidePanel = ReturnType<typeof bundledPanels.get>;
type SidePanelPropKey = SidePanel extends infer Panel
  ? Panel extends SidePanel
    ? keyof PanelProps<Panel>
    : never
  : never;

/**
 * One member per registered id. Other panels' prop keys are forbidden on each
 * member, so a widened id cannot carry props the selected panel does not take.
 */
type RegisteredSidePanelProps = SidePanel extends infer Panel
  ? Panel extends SidePanel
    ? { id: Panel["id"] } & PanelProps<Panel> & {
          [Key in Exclude<SidePanelPropKey, keyof PanelProps<Panel>>]?: never;
        }
    : never
  : never;

export function RegisteredSidePanel({ id, ...props }: RegisteredSidePanelProps) {
  const panel = bundledPanels.get(id);
  // The union caller already paired id with its props; destructuring loses that correlation.
  const Component = panel.Component as ComponentType<typeof props>;
  return (
    <Suspense fallback={null}>
      <Component {...props} />
    </Suspense>
  );
}
