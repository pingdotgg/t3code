import type { EnvironmentId, GitStackManageInput } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
import { Alert, Linking, Pressable, View } from "react-native";
import { getStackBranchSwitchDisabledReason } from "@t3tools/client-runtime/state/vcs";
import { gitEnvironment } from "../../../state/git";
import { useEnvironmentQuery } from "../../../state/query";
import { useAtomCommand } from "../../../state/use-atom-command";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { StackBranchPicker } from "./StackBranchPicker";
import { ThemedSwitch } from "../../../components/ui/ThemedSwitch";

export function BranchStackControl({
  environmentId,
  cwd,
  busy,
  onStart,
  canSwitch,
  hasWorkingTreeChanges,
  onSwitchBranch,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly busy: boolean;
  readonly onStart: () => void;
  readonly canSwitch: boolean;
  readonly hasWorkingTreeChanges: boolean | null;
  readonly onSwitchBranch: (branch: string) => void;
}) {
  const query = useEnvironmentQuery(gitEnvironment.stackStatus({ environmentId, input: { cwd } }));
  const manage = useAtomCommand(gitEnvironment.manageStack, { reportFailure: true });
  const permitted = useAtomValue(gitEnvironment.manageStack.permissionAtom(environmentId));
  const [adopting, setAdopting] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [base, setBase] = useState("");
  const [includeLatestBase, setIncludeLatestBase] = useState(false);
  const workflow = useEnvironmentQuery(
    gitEnvironment.workflowProgress({ environmentId, input: { cwd } }),
  ).data;
  const workflowState = workflow?.state;
  const workflowStartedAt = workflow?.startedAtMs;
  const refreshStack = query.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes server recovery controls when a workflow on any client settles.
  useEffect(() => {
    if (workflowStartedAt !== undefined && workflowState && workflowState !== "running")
      refreshStack();
  }, [workflowState, workflowStartedAt, refreshStack]);
  const status = query.data;
  const run = (action: GitStackManageInput["action"]) => {
    if (action !== "edit" && action !== "adopt") onStart();
    void manage({
      environmentId,
      input: {
        cwd,
        action,
        expectedBranch: status?.layers.find((layer) => layer.current)?.branch ?? null,
        ...(action === "adopt" || action === "edit"
          ? {
              base: base.trim(),
              branches,
            }
          : {}),
        ...(action === "update" ? { includeLatestBase } : {}),
      },
    }).then((result) => {
      if (result._tag === "Success") {
        setAdopting(false);
        query.refresh();
      }
    });
  };
  if (
    !status ||
    status.layers.length === 0 ||
    (!status.managed && status.layers[0]?.branch === status.base)
  )
    return null;
  return (
    <View className="gap-3 rounded-xl bg-card p-4">
      <Text className="font-t3-medium text-foreground">Branch stack</Text>
      {!status.baseIsDefault ? (
        <Text className="text-xs text-foreground-secondary">Base: {status.base}</Text>
      ) : null}
      {status.layers.map((layer) => {
        const disabledReason = getStackBranchSwitchDisabledReason({
          layer,
          hasWorkingTreeChanges,
          canSwitch,
          busy,
          paused: status.operation !== null,
        });
        return (
          <View key={layer.branch} className="gap-1 border-l border-subtle-strong pl-3">
            <View className="min-w-0 flex-row items-baseline gap-2">
              <Pressable
                className="min-w-0 flex-1"
                accessibilityRole="button"
                accessibilityLabel={`Switch to ${layer.branch}`}
                accessibilityState={{ disabled: disabledReason !== null }}
                accessibilityHint={disabledReason ?? "Switch to this branch"}
                onPress={() => {
                  if (disabledReason) Alert.alert("Branch unavailable", disabledReason);
                  else onSwitchBranch(layer.branch);
                }}
              >
                <Text
                  numberOfLines={1}
                  className={
                    layer.current ? "font-t3-medium text-foreground" : "text-foreground-secondary"
                  }
                >
                  {layer.branch}
                </Text>
              </Pressable>
              {layer.pullRequest ? (
                <Text
                  accessibilityRole="link"
                  onPress={() => {
                    if (layer.pullRequest) void Linking.openURL(layer.pullRequest.url);
                  }}
                  className="shrink-0 text-primary-text"
                >
                  #{layer.pullRequest.number}
                </Text>
              ) : null}
            </View>
            {layer.hasChanges ? (
              <Text className="text-xs text-foreground-secondary">Uncommitted changes</Text>
            ) : null}
            {layer.needsRestack ? (
              <Text className="text-xs text-warning-foreground">Needs restacking</Text>
            ) : null}
          </View>
        );
      })}
      {status.managed && !adopting ? (
        <>
          {status.operation ? (
            <>
              <Text className="text-warning-foreground">
                Stack update paused at {status.operation.branch} ({status.operation.phase}).
                {status.operation.phase === "rebase"
                  ? ` Resolve and stage conflicts in ${status.operation.cwd}, then continue.`
                  : status.operation.phase === "hooks"
                    ? " Continue retries unfinished post-push hooks. The branches are already published."
                    : " Continue retries publishing. Abort restores local branches; completed remote pushes remain."}
              </Text>
              <View className="flex-row flex-wrap gap-2">
                <Button
                  size="compact"
                  label="Continue"
                  disabled={busy || !permitted}
                  onPress={() => run("continue")}
                />
                <Button
                  size="compact"
                  label="Abort"
                  disabled={busy || !permitted}
                  onPress={() => run("abort")}
                />
              </View>
            </>
          ) : (
            <>
              <View className="flex-row items-center justify-between gap-2">
                <Text className="text-foreground-secondary">Include latest {status.base}</Text>
                <ThemedSwitch
                  value={includeLatestBase}
                  onValueChange={setIncludeLatestBase}
                  disabled={busy}
                  accessibilityLabel={`Include latest ${status.base}`}
                />
              </View>
              <View className="flex-row flex-wrap gap-2">
                <Button
                  size="compact"
                  label="Update stack"
                  disabled={busy || !permitted}
                  onPress={() => run("update")}
                />
                <Button
                  size="compact"
                  label="Edit layers"
                  tone="text"
                  disabled={busy || !permitted}
                  onPress={() => {
                    setBranches(status.layers.map((layer) => layer.branch));
                    setBase(status.base);
                    setAdopting(true);
                  }}
                />
                <Button
                  size="compact"
                  label="Untrack"
                  tone="text"
                  disabled={busy || !permitted}
                  onPress={() => run("untrack")}
                />
              </View>
            </>
          )}
        </>
      ) : adopting ? (
        <>
          <Text className="font-t3-medium text-foreground">
            {status.managed ? "Edit stack layers" : "Adopt branch stack"}
          </Text>
          <Text className="text-foreground-secondary">Base branch</Text>
          <StackBranchPicker
            environmentId={environmentId}
            cwd={cwd}
            value={base}
            excluded={branches}
            label="Base branch"
            onChange={setBase}
          />
          <View className="gap-3 border-l border-subtle-strong pl-3">
            {branches.map((branch, index) => (
              <View key={branch} className="gap-2">
                <Text className="text-xs text-foreground-secondary">
                  Layer {index + 1}
                  {index === branches.length - 1 ? " · tip" : ""}
                </Text>
                <StackBranchPicker
                  environmentId={environmentId}
                  cwd={cwd}
                  value={branch}
                  excluded={[base, ...branches.filter((_, i) => i !== index)]}
                  label={`Branch for layer ${index + 1}`}
                  onChange={(name) =>
                    setBranches(branches.map((value, i) => (i === index ? name : value)))
                  }
                />
                <View className="flex-row flex-wrap gap-2">
                  <Button
                    label="Move up"
                    size="compact"
                    tone="text"
                    disabled={index === 0}
                    onPress={() => {
                      const next = [...branches];
                      next.splice(index - 1, 2, branch, branches[index - 1]!);
                      setBranches(next);
                    }}
                  />
                  <Button
                    label="Move down"
                    size="compact"
                    tone="text"
                    disabled={index === branches.length - 1}
                    onPress={() => {
                      const next = [...branches];
                      next.splice(index, 2, branches[index + 1]!, branch);
                      setBranches(next);
                    }}
                  />
                  <Button
                    label="Remove"
                    size="compact"
                    tone="text"
                    onPress={() => setBranches(branches.filter((_, i) => i !== index))}
                  />
                </View>
              </View>
            ))}
          </View>
          <Button
            label="Add branch"
            tone="text"
            disabled={branches.includes("")}
            onPress={() => setBranches([...branches, ""])}
          />
          <Text className="text-xs text-foreground-secondary">
            Push destination: {status.remote}. T3 will maintain this stack instead of another stack
            manager. Adoption preserves commits.
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <Button
              size="compact"
              label={status.managed ? "Save layers" : "Adopt"}
              disabled={
                busy ||
                !permitted ||
                !base.trim() ||
                branches.length === 0 ||
                branches.some((branch) => !branch)
              }
              onPress={() => run(status.managed ? "edit" : "adopt")}
            />
            <Button size="compact" label="Cancel" tone="text" onPress={() => setAdopting(false)} />
          </View>
        </>
      ) : (
        <Button
          size="compact"
          label="Adopt branch stack"
          tone="text"
          disabled={busy || !permitted}
          onPress={() => {
            setBase(status.base);
            setBranches(status.layers.map((layer) => layer.branch));
            setAdopting(true);
          }}
        />
      )}
    </View>
  );
}
