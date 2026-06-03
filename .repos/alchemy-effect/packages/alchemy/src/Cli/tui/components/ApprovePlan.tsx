/** @jsxImportSource react */
import { useState, type JSX } from "react";

import { Box, Text, useApp, useInput } from "ink";
import type { Plan as AlchemyPlan } from "../../../Plan.ts";

import { Plan } from "./Plan.tsx";

export interface ApprovePlanProps {
  plan: AlchemyPlan;
  approve: (result: boolean) => void;
}

export function ApprovePlan(props: ApprovePlanProps): JSX.Element {
  const { plan, approve } = props;
  const [selected, setSelected] = useState(0);
  const { exit } = useApp();

  useInput((_input, key) => {
    if (key.leftArrow || key.rightArrow) {
      setSelected((prev) => (prev === 0 ? 1 : 0));
    } else if (key.return) {
      approve(selected === 0);
      exit();
    }
  });

  return (
    <Box flexDirection="column">
      <Plan plan={plan} />
      <Box marginTop={1}>
        <Text>Proceed?</Text>
      </Box>
      <Box gap={1}>
        <Text color={selected === 0 ? "green" : "gray"}>
          {selected === 0 ? "◉" : "○"} Yes
        </Text>
        <Text color={selected === 1 ? "red" : "gray"}>
          {selected === 1 ? "◉" : "○"} No
        </Text>
      </Box>
    </Box>
  );
}
