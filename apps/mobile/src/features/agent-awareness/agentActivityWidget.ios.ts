import AgentActivityWidget, {
  type AgentActivityWidgetProps,
} from "../../widgets/AgentActivityWidget";

export function updateAgentActivityWidget(props: AgentActivityWidgetProps): void {
  AgentActivityWidget.updateSnapshot(props);
}
