/** @jsxImportSource react */
import { useMemo, useState, type JSX } from "react";
import type { Plan } from "../../../Plan.ts";
import {
  PromptFrame,
  ChoiceGroup,
  useKeyGlyphs,
  useTerminalInput,
} from "../ui/index.ts";
import { Screen, type ScreenController } from "../../CliKit/index.ts";
import { Plan as PlanComponent, PlanTree } from "./PlanView.tsx";
import type { PlanTreeData } from "./PlanTree.ts";

export interface PlanDecisionChoice<Value> {
  readonly value: Value;
  readonly label: string;
}

function PlanDecision<Value>(props: {
  readonly plan: Plan | PlanTreeData;
  readonly label?: string;
  readonly message: string;
  readonly choices: ReadonlyArray<PlanDecisionChoice<Value>>;
  readonly initialValue: Value;
  readonly controller: ScreenController<Value>;
}): JSX.Element {
  const {
    plan,
    label = "Plan",
    message,
    choices,
    initialValue,
    controller,
  } = props;
  const tree = useMemo(
    () => new PlanTree(plan, { mode: "review", label }),
    [plan, label],
  );
  const [selected, setSelected] = useState(initialValue);
  const keys = useKeyGlyphs();

  useTerminalInput((_input, key) => {
    if (key.enter) controller.submit(selected);
    else if (key.escape) controller.cancel();
  });

  return (
    <PlanComponent
      tree={tree}
      footer={
        <PromptFrame
          message={message}
          keys={[
            [keys.upDown, "scroll plan"],
            [keys.leftRight, "choose"],
            [keys.enter, "confirm"],
            [keys.escape, "cancel"],
          ]}
        >
          <ChoiceGroup
            choices={choices}
            value={selected}
            onChange={setSelected}
          />
        </PromptFrame>
      }
    />
  );
}

export const planDecisionScreen = <Value,>(options: {
  readonly plan: Plan | PlanTreeData;
  readonly label?: string;
  readonly message: string;
  readonly choices: ReadonlyArray<PlanDecisionChoice<Value>>;
  readonly initialValue: Value;
}) =>
  Screen.make<Value>("plan decision", (controller) => (
    <PlanDecision {...options} controller={controller} />
  ));
