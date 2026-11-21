import { JiraIcon } from "../../issues/JiraIcon";
import { IntegrationCard } from "./IntegrationCard";

export function JiraCard() {
  return (
    <IntegrationCard
      id="jira"
      icon={<JiraIcon className="size-5" />}
      name="Jira"
      description="The engine has no Jira connection, so there is nothing to connect here."
      status={{ label: "Not offered", tone: "neutral" }}
    />
  );
}
