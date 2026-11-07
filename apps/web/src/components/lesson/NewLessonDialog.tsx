import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  ModelSelection,
  type ScopedProjectRef,
  supportsLessonProjects,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { create } from "zustand";
import { useId, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { useProject, useServerConfigs } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  deriveProviderInstanceEntries,
  providerInstanceEntriesFor,
  resolveProjectDefaultProviderModelSelection,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import { randomUUID } from "../../lib/utils";

type Request = {
  projectRef: ScopedProjectRef;
  source?: { threadId: string; excerpt: string };
};
const useLessonDialog = create<{ request: Request | null }>(() => ({ request: null }));
export function openNewLesson(request: Request) {
  useLessonDialog.setState({ request });
}

const LESSON_MODEL = "claude-sonnet-5-5";
const nullOr = Schema.NullOr;
const LESSON_MODEL_SCHEMA = nullOr(ModelSelection);

/** @public Used by the lesson model picker and its defaulting tests. */
export function lessonModelSelection(
  providers: Parameters<typeof deriveProviderInstanceEntries>[0],
  remembered: ModelSelection | null,
  fallback: ModelSelection | null,
): ModelSelection | null {
  const entries = deriveProviderInstanceEntries(providers);
  if (remembered && entries.some((entry) => entry.instanceId === remembered.instanceId)) {
    return remembered;
  }
  const preferred =
    entries.find(
      (entry) =>
        entry.instanceId === "claude-public-pool" &&
        entry.models.some((model) => model.slug === LESSON_MODEL),
    ) ??
    entries.find(
      (entry) =>
        entry.driverKind === "claudeAgent" &&
        entry.models.some((model) => model.slug === LESSON_MODEL),
    );
  return preferred
    ? createModelSelection(preferred.instanceId, LESSON_MODEL, [{ id: "effort", value: "high" }])
    : fallback;
}

const depthOptions = [
  ["overview", "Big picture", "the main ideas and how they fit together"],
  ["working", "Working knowledge", "enough to use it confidently"],
  ["deep", "Deep detail", "the mechanics, edge cases and why it works"],
] as const;
const purposeOptions = [
  ["outcome", "Toward an outcome", "I want to do or build something"],
  ["prerequisite", "Building prerequisites", "Groundwork for something I'll learn next"],
] as const;

export function NewLessonDialogHost() {
  const request = useLessonDialog((state) => state.request);
  const close = () => useLessonDialog.setState({ request: null });
  if (request === null) return null;
  return <NewLessonDialog request={request} onClose={close} />;
}

function NewLessonDialog({ request, onClose }: { request: Request; onClose: () => void }) {
  const navigate = useNavigate();
  const createLesson = useAtomCommand(serverEnvironment.createLesson, { reportFailure: true });
  const [topic, setTopic] = useState(request.source?.excerpt ?? "");
  const [depth, setDepth] = useState<"overview" | "working" | "deep">("working");
  const [purpose, setPurpose] = useState<"outcome" | "prerequisite">("outcome");
  const [location, setLocation] = useState<"project" | "new">(
    request.source === undefined ? "new" : "project",
  );
  const [goal, setGoal] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commandId] = useState(() => CommandId.make(`lesson:${randomUUID()}`));
  const id = useId();
  const project = useProject(request.projectRef);
  const serverConfig = useServerConfigs().get(request.projectRef.environmentId);
  const lessonProjectsSupported =
    serverConfig !== undefined && supportsLessonProjects(serverConfig.environment);
  const providers = useEnvironmentProviders().get(request.projectRef.environmentId) ?? [];
  const [rememberedModel, setRememberedModel] = useLocalStorage(
    `ominax:lesson-model:${request.projectRef.environmentId}`,
    null,
    LESSON_MODEL_SCHEMA,
  );
  const projectSettings = resolveProjectSettings(
    serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
    request.projectRef.projectId,
    project ?? undefined,
  ).settings;
  const modelSelection = lessonModelSelection(
    providers,
    rememberedModel,
    projectSettings.defaultModelSelection ??
      resolveProjectDefaultProviderModelSelection(
        providers,
        serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
        request.projectRef.projectId,
      ),
  );
  const pickerSettings = serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
  const pickerEntries = providerInstanceEntriesFor(providers, pickerSettings, null);
  const active = modelSelection
    ? pickerEntries.find((entry) => entry.instanceId === modelSelection.instanceId)
    : undefined;
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    pickerSettings as Parameters<typeof getCustomModelOptionsByInstance>[0],
    providers,
    modelSelection?.instanceId,
    modelSelection?.model,
  );
  const submit = async () => {
    const trimmed = topic.trim();
    if (!trimmed || modelSelection === null || pending) return;
    setPending(true);
    setError(null);
    const result = await createLesson({
      environmentId: request.projectRef.environmentId,
      input: {
        commandId,
        ...(lessonProjectsSupported && location === "new"
          ? {}
          : { projectId: request.projectRef.projectId }),
        lesson: {
          topic: trimmed,
          depth,
          purpose,
          ...(goal.trim() ? { goal: goal.trim() } : {}),
          ...(request.source
            ? { source: { ...request.source, threadId: ThreadId.make(request.source.threadId) } }
            : {}),
        },
        modelSelection,
        runtimeMode: "auto",
        interactionMode: "default",
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Couldn't start the lesson.");
      }
      return;
    }
    onClose();
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(request.projectRef.environmentId, result.value.threadId),
      ),
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New lesson</DialogTitle>
            <DialogDescription>What you want to learn, how deep, and why.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-5">
              {lessonProjectsSupported ? (
                <ChoiceGroup
                  label="Where?"
                  value={location}
                  options={[
                    [
                      "project",
                      `In ${project?.title ?? "this project"}`,
                      "Keep it with this project's chats",
                    ],
                    ["new", "A new, unrelated lesson", "Gets its own project"],
                  ]}
                  onChange={setLocation}
                />
              ) : null}
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-topic`}>What do you want to learn?</Label>
                <Textarea
                  id={`${id}-topic`}
                  required
                  autoFocus
                  value={topic}
                  maxLength={4000}
                  onChange={(event) => setTopic(event.target.value)}
                  rows={4}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label>Model</Label>
                <div className="flex flex-wrap items-center gap-1.5">
                  {modelSelection && active ? (
                    <ProviderModelPicker
                      environmentId={request.projectRef.environmentId}
                      activeInstanceId={modelSelection.instanceId}
                      model={modelSelection.model}
                      lockedProvider={null}
                      instanceEntries={pickerEntries}
                      modelOptionsByInstance={modelOptionsByInstance}
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      triggerAriaLabel="Lesson model"
                      onInstanceModelChange={(instanceId, model) =>
                        setRememberedModel(createModelSelection(instanceId, model))
                      }
                    />
                  ) : null}
                  {modelSelection && active ? (
                    <TraitsPicker
                      provider={active.driverKind}
                      models={active.models}
                      model={modelSelection.model}
                      modelOptions={modelSelection.options ?? []}
                      allowPromptInjectedEffort={false}
                      planModeEnabled={false}
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      onModelOptionsChange={(options) =>
                        setRememberedModel(
                          createModelSelection(
                            modelSelection.instanceId,
                            modelSelection.model,
                            options,
                          ),
                        )
                      }
                    />
                  ) : null}
                </div>
              </div>
              <ChoiceGroup
                label="How deep?"
                value={depth}
                options={depthOptions}
                onChange={setDepth}
              />
              <ChoiceGroup
                label="Why?"
                value={purpose}
                options={purposeOptions}
                onChange={setPurpose}
              />
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-goal`}>What for?</Label>
                <Input
                  id={`${id}-goal`}
                  value={goal}
                  maxLength={500}
                  onChange={(event) => setGoal(event.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>
            {error ? (
              <p role="alert" className="mt-4 text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!topic.trim() || modelSelection === null || pending}>
              Start lesson
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function ChoiceGroup<T extends string>(props: {
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, string, string]>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{props.label}</span>
      <RadioGroup
        aria-label={props.label}
        value={props.value}
        onValueChange={(value) => props.onChange(value as T)}
      >
        {props.options.map(([value, label, description]) => (
          <label key={value} className="flex cursor-pointer items-start gap-2 text-sm">
            <Radio value={value} className="mt-0.5" />
            <span>
              <span className="font-medium">{label}</span>
              <span className="block text-muted-foreground">{description}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
    </div>
  );
}
