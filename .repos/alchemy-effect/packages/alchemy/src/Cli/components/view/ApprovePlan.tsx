/** @jsxImportSource react */
import { useMemo, useState, type JSX } from "react";
import {
  ChoiceGroup,
  Box,
  KeyBar,
  Text,
  useGlyphs,
  useKeyGlyphs,
  useTerminalInput,
} from "../ui/index.ts";
import { Screen, theme, type ScreenController } from "../../CliKit/index.ts";
import type { Plan as AlchemyPlan } from "../../../Plan.ts";
import { Plan, PlanTree } from "./PlanView.tsx";

export interface ApprovePlanProps {
  plan: AlchemyPlan;
  detailed?: boolean;
  controller: ScreenController<boolean>;
}

/**
 * Plan approval prompt: the plan tree followed by an operation-specific
 * action and Cancel. Escape cancels; Ctrl+C is handled centrally by the
 * screen runner.
 */
export function ApprovePlan(props: ApprovePlanProps): JSX.Element {
  const { plan, detailed = false, controller } = props;
  // Destruction is the risky path: require an explicit move to Destroy before
  // Enter can remove or orphan resources. Deploy approvals remain action-first.
  const [approved, setApproved] = useState(!plan.destroy);
  const action = plan.destroy ? "Destroy" : "Deploy";
  const glyphs = useGlyphs();
  const keys = useKeyGlyphs();
  const tree = useMemo(
    () =>
      new PlanTree(plan, {
        detailed,
        mode: "review",
        label: action,
      }),
    [plan, detailed, action],
  );
  const complete = (answer: boolean) => {
    const verdict = (
      <Text color={answer ? theme.color.success : theme.color.danger}>
        {answer ? glyphs.success : glyphs.error} {answer ? action : "Cancelled"}
      </Text>
    );
    // On approval the plan disappears — the apply progress that follows
    // shows every row again. A declined plan stays on screen (complete,
    // unscrolled) so the user can review what they just turned down.
    if (!answer) tree.setViewport("full");
    const summary = answer ? (
      verdict
    ) : (
      <Box flexDirection="column">
        <Plan tree={tree} />
        {verdict}
      </Box>
    );
    controller.submit(answer, summary);
  };

  useTerminalInput((input, key) => {
    if (key.enter) complete(approved);
    else if (key.escape) controller.cancel();
    else if (key.ctrl || key.meta) return;
    else if (input.toLowerCase() === "y") complete(true);
    else if (input.toLowerCase() === "n") complete(false);
  });

  const prompt = (
    <Box flexDirection="column">
      <Text bold>{action}?</Text>
      <ChoiceGroup
        value={approved}
        choices={[
          { value: true, label: action },
          { value: false, label: "Cancel" },
        ]}
        onChange={setApproved}
      />
      <KeyBar
        keys={[
          [keys.upDown, "scroll plan"],
          [keys.leftRight, "choose"],
          [keys.enter, "confirm"],
          [keys.escape, "cancel"],
        ]}
      />
    </Box>
  );

  return <Plan tree={tree} footer={prompt} />;
}

export const approvePlanScreen = (plan: AlchemyPlan, detailed = false) =>
  Screen.make<boolean>("plan approval", (controller) => (
    <ApprovePlan plan={plan} detailed={detailed} controller={controller} />
  ));
