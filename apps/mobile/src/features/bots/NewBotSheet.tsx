import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { DEFAULT_RUNTIME_MODE, type ModelSelection } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { FitSheet } from "../../components/ui/FitSheet";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import {
  resolveProviderOptionDescriptors,
  withImplicitFastModeSelection,
} from "../../lib/providerOptions";
import { botFilesEnvironment } from "../../state/botFiles";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { scheduledTaskDefaultModel } from "../settings/scheduledTaskDraft";
import { ThreadSettingsPickerScreen } from "../threads/ThreadSettingsSheet";
import { updateNewBotDraft, useBotMachines, useNewBotDraft } from "./new-bot";

/** The draft's model, or the machine's default until one is picked. */
function useNewBotModel() {
  const draft = useNewBotDraft();
  const config = useEnvironmentServerConfig(draft?.environmentId ?? null);
  const selection = draft?.modelSelection ?? scheduledTaskDefaultModel(config, null);
  const options = buildModelOptions(config, selection, undefined, null);
  const option =
    selection === null
      ? undefined
      : options.find(
          (entry) =>
            entry.selection.instanceId === selection.instanceId &&
            entry.selection.model === selection.model,
        );
  return { draft, config, selection, options, option };
}

const setModel = (modelSelection: ModelSelection) =>
  updateNewBotDraft((draft) => ({ ...draft, modelSelection }));

/** Starts a Bot: where it runs and its model. It greets the user and sets itself up in chat. */
export function NewBotRouteScreen() {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const machines = useBotMachines();
  const { draft, config, selection, options, option } = useNewBotModel();
  const environmentId = draft?.environmentId ?? null;
  const canCreate = useAtomValue(botFilesEnvironment.create.permissionAtom(environmentId));
  const create = useAtomCommand(botFilesEnvironment.create, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = canCreate && !pending && selection !== null;

  const submit = async () => {
    if (!ready || environmentId === null || selection === null) return;
    setPending(true);
    setError(null);
    const result = await create({
      environmentId,
      // The Bot names itself once it knows its job.
      input: {
        title: gt("New Bot"),
        instructions: "",
        modelSelection: withImplicitFastModeSelection(selection, config?.providers ?? []),
      },
    });
    setPending(false);
    if (result._tag === "Success") {
      selectDetail({
        name: "Thread",
        params: { environmentId: String(environmentId), threadId: String(result.value.threadId) },
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setError(
        errorDisplayMessage(squashAtomCommandFailure(result), m) ?? gt("An error occurred."),
      );
    }
  };

  return (
    <FitSheet
      header={
        <SheetHeader
          title={gt("New Bot")}
          onCancel={() => navigation.goBack()}
          dismissDisabled={pending}
          confirm={{
            label: gt("Create", { $context: "verb, creates a Bot" }),
            onPress: () => void submit(),
            disabled: !ready,
            loading: pending,
          }}
        />
      }
    >
      <View className="gap-6">
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {gt(
            "A Bot coordinates other threads for you. Pick where it runs and its model, then tell it in the chat what to look after.",
          )}
        </Text>
        {machines.length > 1 ? (
          <ListSection title={gt("Machine")}>
            {machines.map((machine, index) => (
              <ListChoiceRow
                key={machine.environmentId}
                label={machine.label}
                leading={
                  <EnvironmentMachineSymbol
                    kind={machine.machine}
                    size={18}
                    tintColorClassName="accent-icon"
                  />
                }
                selected={machine.environmentId === environmentId}
                separated={index > 0}
                disabled={pending}
                onPress={() =>
                  // Each machine has its own providers, so its default model applies.
                  updateNewBotDraft((current) =>
                    current.environmentId === machine.environmentId
                      ? current
                      : { environmentId: machine.environmentId, modelSelection: null },
                  )
                }
              />
            ))}
          </ListSection>
        ) : null}
        <ListSection title={gt("Model")}>
          <ListRow
            label={
              option?.label ??
              selection?.model ??
              (options.length > 0 ? gt("Choose model") : gt("No models available"))
            }
            {...(option ? { description: option.providerLabel } : {})}
            disabled={pending || options.length === 0}
            onPress={() => navigation.navigate("NewBotModel")}
          />
        </ListSection>
        {error === null ? null : <ErrorBanner message={error} />}
      </View>
    </FitSheet>
  );
}

/** The model picker the New Bot sheet opens; a Bot has no runtime mode to pick. */
export function NewBotModelRouteScreen() {
  const navigation = useNavigation();
  const { draft, selection, options, option } = useNewBotModel();
  return (
    <ThreadSettingsPickerScreen
      environmentId={draft?.environmentId ?? null}
      projectId={null}
      cwd={null}
      providerGroups={groupByProvider(options)}
      selectedModel={selection}
      prompt=""
      onPromptChange={() => undefined}
      onSelectModel={(picked) => setModel(picked.selection)}
      optionDescriptors={resolveProviderOptionDescriptors({
        capabilities: option?.capabilities,
        selections: selection?.options,
      })}
      onUpdateOptionSelections={(selections) => {
        if (selection !== null) setModel({ ...selection, options: selections });
      }}
      runtimeMode={DEFAULT_RUNTIME_MODE}
      onClose={() => navigation.goBack()}
    />
  );
}
