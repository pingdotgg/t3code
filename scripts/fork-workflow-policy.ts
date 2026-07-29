// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const approvedRunnerLabels = new Set(["macos-15", "ubuntu-24.04"]);
const approvedCredentialReferences = new Set(["secrets.GITHUB_TOKEN"]);
const credentialReferencePattern = /\b(?:secrets|vars)\.[A-Za-z0-9_]+\b/g;
const runnerLabelPattern = /^\s*runs-on:\s*([^\s#]+)\s*(?:#.*)?$/gm;

export function findActiveWorkflowViolations(
  workflowName: string,
  workflow: string,
): ReadonlyArray<string> {
  const runnerViolations = Array.from(workflow.matchAll(runnerLabelPattern)).flatMap((match) => {
    const runnerLabel = match[1];
    return runnerLabel !== undefined && !approvedRunnerLabels.has(runnerLabel)
      ? [`${workflowName}: runner '${runnerLabel}' is not approved for this fork`]
      : [];
  });
  const credentialViolations = Array.from(
    new Set(workflow.match(credentialReferencePattern) ?? []),
  ).flatMap((reference) =>
    approvedCredentialReferences.has(reference)
      ? []
      : [`${workflowName}: credential '${reference}' has no approved fork owner`],
  );

  return [...runnerViolations, ...credentialViolations];
}

export function findForkWorkflowPolicyViolations(repositoryRoot: string): ReadonlyArray<string> {
  const workflowsDirectory = NodePath.join(repositoryRoot, ".github", "workflows");
  const workflowNames = NodeFS.readdirSync(workflowsDirectory).filter(
    (name) => name.endsWith(".yml") || name.endsWith(".yaml"),
  );

  return workflowNames.flatMap((name) => {
    const workflow = NodeFS.readFileSync(NodePath.join(workflowsDirectory, name), "utf8");
    return findActiveWorkflowViolations(name, workflow);
  });
}
