import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { create } from "zustand";
import { useId, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { resolveProjectDefaultProviderModelSelection } from "../../providerInstances";
import { randomUUID } from "../../lib/utils";

type Request = {
  projectRef: ScopedProjectRef;
  modelSelection?: ModelSelection;
  runtimeMode?: RuntimeMode;
  interactionMode?: ProviderInteractionMode;
  source?: { threadId: string; excerpt: string };
};
const useLessonDialog = create<{ request: Request | null }>(() => ({ request: null }));
export function openNewLesson(request: Request) {
  useLessonDialog.setState({ request });
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
  const [goal, setGoal] = useState("");
  const [pending, setPending] = useState(false);
  const [commandId] = useState(() => CommandId.make(`lesson:${randomUUID()}`));
  const id = useId();
  const project = useProject(request.projectRef);
  const serverConfig = useServerConfigs().get(request.projectRef.environmentId);
  const providers = useEnvironmentProviders().get(request.projectRef.environmentId) ?? [];
  const projectSettings = resolveProjectSettings(
    serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
    request.projectRef.projectId,
    project ?? undefined,
  ).settings;
  const modelSelection =
    request.modelSelection ??
    projectSettings.defaultModelSelection ??
    resolveProjectDefaultProviderModelSelection(
      providers,
      serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
      request.projectRef.projectId,
    );
  const submit = async () => {
    const trimmed = topic.trim();
    if (!trimmed || modelSelection === null || pending) return;
    setPending(true);
    const result = await createLesson({
      environmentId: request.projectRef.environmentId,
      input: {
        commandId,
        projectId: request.projectRef.projectId,
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
        runtimeMode: request.runtimeMode ?? projectSettings.defaultRuntimeMode,
        interactionMode: request.interactionMode ?? "default",
      },
    });
    setPending(false);
    if (result._tag === "Success") {
      onClose();
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(
          scopeThreadRef(request.projectRef.environmentId, result.value.threadId),
        ),
      });
    }
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
