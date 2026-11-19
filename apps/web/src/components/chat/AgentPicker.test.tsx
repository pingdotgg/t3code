import { isValidElement, type ReactElement } from "react";
import { AgentId, type AgentSummary } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { AgentPickerMenuContent } from "./AgentPicker";

const sampleAgents: ReadonlyArray<AgentSummary> = [
  {
    id: AgentId.make("code-reviewer"),
    name: "Code Reviewer",
    description: "Reviews pull requests and provides detailed feedback",
    tier: "reasoning",
  },
  {
    id: AgentId.make("doc-writer"),
    name: "Documentation Writer",
    description: "Generates clear and concise documentation",
    tier: "economy",
  },
];

function elementsIn(root: unknown): ReadonlyArray<ReactElement<Record<string, unknown>>> {
  const elements: Array<ReactElement<Record<string, unknown>>> = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isValidElement(node)) return;
    const element = node as ReactElement<Record<string, unknown>>;
    elements.push(element);
    visit(element.props.children);
  };
  visit(root);
  return elements;
}

function radioGroup(input: {
  readonly selectedAgentId: AgentId | null | undefined;
  readonly agents?: ReadonlyArray<AgentSummary>;
}) {
  const tree = AgentPickerMenuContent({
    agents: input.agents ?? sampleAgents,
    selectedAgentId: input.selectedAgentId,
    defaultAgentId: AgentId.make("code-reviewer"),
    onSelectAgent: () => {},
    allowNone: true,
  });
  return elementsIn(tree).find(
    (element) =>
      typeof element.props.value === "string" && typeof element.props.onValueChange === "function",
  )!;
}

it("distinguishes inheriting the project default from explicitly choosing no agent", () => {
  const inherited = radioGroup({ selectedAgentId: undefined });
  expect(inherited.props.value).toBe("control:default");

  const optedOut = radioGroup({ selectedAgentId: null });
  expect(optedOut.props.value).toBe("control:none");
});

it("keeps agent ids named default and none separate from control options", () => {
  const agents: ReadonlyArray<AgentSummary> = [
    { id: AgentId.make("default"), name: "Default Named Agent", description: "Default" },
    { id: AgentId.make("none"), name: "None Named Agent", description: "None" },
  ];
  const group = radioGroup({ selectedAgentId: AgentId.make("default"), agents });
  const values = elementsIn(group.props.children)
    .filter(
      (element) =>
        typeof element.props.value === "string" &&
        typeof element.props.onValueChange !== "function",
    )
    .map((element) => element.props.value);

  expect(group.props.value).toBe("agent:default");
  expect(values).toContain("control:default");
  expect(values).toContain("control:none");
  expect(values).toContain("agent:default");
  expect(values).toContain("agent:none");
});
