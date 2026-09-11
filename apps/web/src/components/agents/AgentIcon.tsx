import {
  BotIcon,
  CodeIcon,
  PenIcon,
  SearchIcon,
  ShieldIcon,
  SparklesIcon,
  TerminalIcon,
} from "lucide-react";
import type { McpGatewayProfile } from "@t3tools/contracts";

export const agentColors = ["#f5b775", "#7bb5ff", "#b797ff", "#71d8bc", "#f293b7"];
export const agentIcons = {
  orb: "Orb",
  bot: "Robot",
  code: "Code",
  pen: "Pen",
  search: "Search",
  shield: "Shield",
  sparkles: "Sparkles",
  terminal: "Terminal",
};
const icons = {
  bot: BotIcon,
  code: CodeIcon,
  pen: PenIcon,
  search: SearchIcon,
  shield: ShieldIcon,
  sparkles: SparklesIcon,
  terminal: TerminalIcon,
};

export function AgentIcon({ icon }: { icon: McpGatewayProfile["icon"] }) {
  const Icon = icon && icon !== "orb" ? icons[icon] : null;
  return Icon ? (
    <span className="agent-custom-icon" aria-hidden="true">
      <Icon size={20} />
    </span>
  ) : (
    <span className="agent-orb" aria-hidden="true" />
  );
}
