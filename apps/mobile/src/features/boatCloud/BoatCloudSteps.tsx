import type { BoatCloudStartStep, BoatCloudStepProgress } from "@t3tools/contracts";
import { View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { cn } from "../../lib/cn";

export type StepState = BoatCloudStepProgress["state"];

// Static glyphs: a VM takes seconds to minutes, and a spinner would repaint the whole time.
const STEP_ICONS: Record<StepState, { readonly name: AppSymbolName; readonly tint: string }> = {
  done: { name: "checkmark.circle.fill", tint: "accent-success-foreground" },
  failed: { name: "xmark.circle.fill", tint: "accent-danger-foreground" },
  active: { name: "circle.inset.filled", tint: "accent-primary-text" },
  pending: { name: "circle.dashed", tint: "accent-icon-muted" },
};

export function StepGlyph(props: { readonly state: StepState }) {
  const icon = STEP_ICONS[props.state];
  return <SymbolView name={icon.name} size={20} tintColorClassName={icon.tint} />;
}

const START_STEP_LABELS: Record<BoatCloudStartStep, string> = {
  machine: "Find a VM",
  server: "Start T3 Code",
  repository: "Clone or update the repository",
  connect: "Connect",
  project: "Open the project",
  thread: "Move the draft",
};

/** Each step of starting on Boat cloud, as the holder and this app report it. */
export function BoatCloudStartSteps(props: {
  readonly steps: ReadonlyArray<BoatCloudStepProgress>;
}) {
  return (
    <View>
      {props.steps.map((entry, index) => (
        <View
          key={entry.step}
          className={cn(index > 0 && "border-t border-border-subtle")}
          accessibilityLabel={`${START_STEP_LABELS[entry.step]}, ${entry.state}`}
        >
          <ListRowLayout
            leading={<StepGlyph state={entry.state} />}
            label={START_STEP_LABELS[entry.step]}
            description={entry.detail ?? undefined}
          />
        </View>
      ))}
    </View>
  );
}
