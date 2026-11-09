import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  MessageId,
  type EnvironmentId,
  type PlanId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  buildPlanImplementationPrompt,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "@t3tools/shared/proposedPlanText";
import type { MenuAction } from "@react-native-menu/menu";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { uuidv4 } from "../../lib/uuid";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useQuietThreadStructure } from "../../state/use-thread-detail";

export function ProposedPlanCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly planId: PlanId;
  readonly workspaceRoot: string | null | undefined;
  readonly markdown: string;
  readonly renderMarkdown: (text: string) => ReactNode;
}) {
  const canWrite = useAtomValue(projectEnvironment.writeFile.permissionAtom(props.environmentId));
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const thread = useAtomValue(environmentThreadShells.threadShellAtom(threadRef));
  const structure = useQuietThreadStructure(threadRef);
  const plan = structure?.projection.plans.find((entry) => entry.id === props.planId);
  const planIsActive = plan?.kind === "proposed_plan" ? plan.status === "active" : true;
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const setInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const [building, setBuilding] = useState(false);
  const [lastPath, setLastPath] = useState("plan.md");
  const contents = `${props.markdown.trimEnd()}\n`;
  const canBuild =
    canOperate && thread !== null && !threadRuntimeIsActive(thread.runtime) && planIsActive;
  const canSave = canWrite && Boolean(props.workspaceRoot) && !saving && !building;
  const menuActions = useMemo((): MenuAction[] => {
    const actions: MenuAction[] = [
      { id: "copy", title: "Copy to clipboard", image: "doc.on.doc" },
      {
        id: "save",
        title: saving ? "Saving..." : "Save to workspace",
        image: "square.and.arrow.down",
        attributes: { disabled: !canSave },
      },
    ];
    if (canOperate) {
      actions.push({
        id: "build",
        title: building ? "Building..." : "Build",
        image: "hammer",
        attributes: { disabled: !canBuild || saving || building },
      });
    }
    return actions;
  }, [building, canBuild, canOperate, canSave, saving]);

  const save = async (path: string) => {
    const relativePath = path.trim();
    if (!canWrite || !props.workspaceRoot || inFlight.current) return;
    if (!relativePath) {
      Dialog.alert("Enter a workspace path");
      return;
    }
    inFlight.current = true;
    setSaving(true);
    const result = await writeFile({
      environmentId: props.environmentId,
      input: { cwd: props.workspaceRoot, relativePath, contents },
    }).finally(() => {
      inFlight.current = false;
      setSaving(false);
    });
    if (result._tag === "Success") {
      Dialog.alert("Plan saved to workspace", result.value.relativePath);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert("Could not save plan", error instanceof Error ? error.message : String(error));
    }
  };

  const openSave = () => {
    if (!canSave) return;
    Dialog.prompt({
      title: "Save plan to workspace",
      // The write replaces an existing file, and the RPC has no create-only mode.
      message:
        "Enter a path relative to the thread's workspace. A file already at that path is replaced.",
      initialValue: lastPath,
      confirmText: "Save",
      onConfirm: (path) => {
        setLastPath(path);
        void save(path);
      },
    });
  };

  const build = async () => {
    if (!canBuild || thread === null || inFlight.current) return;
    inFlight.current = true;
    setBuilding(true);
    const createdAt = new Date().toISOString();
    const run = async () => {
      if (thread.interactionMode !== "default") {
        const modeResult = await setInteractionMode({
          environmentId: props.environmentId,
          input: {
            threadId: props.threadId,
            interactionMode: "default",
            createdAt,
          },
        });
        if (modeResult._tag === "Failure") {
          if (!isAtomCommandInterrupted(modeResult)) {
            const error = squashAtomCommandFailure(modeResult);
            Dialog.alert(
              "Could not start build",
              error instanceof Error ? error.message : String(error),
            );
          }
          return;
        }
      }
      const turnResult = await startTurn({
        environmentId: props.environmentId,
        input: {
          threadId: props.threadId,
          message: {
            messageId: MessageId.make(uuidv4()),
            role: "user",
            text: buildPlanImplementationPrompt(props.markdown),
            attachments: [],
          },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: props.threadId,
            planId: props.planId,
          },
          createdAt,
          creationSource: "mobile",
        },
      });
      if (turnResult._tag === "Failure" && !isAtomCommandInterrupted(turnResult)) {
        const error = squashAtomCommandFailure(turnResult);
        Dialog.alert(
          "Could not start build",
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    await run().finally(() => {
      inFlight.current = false;
      setBuilding(false);
    });
  };

  const copy = async () => {
    if (!(await tryCopyTextWithHaptic(contents))) {
      Dialog.alert("Could not copy", "Try again.");
    }
  };

  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="flex-row items-center gap-2">
        <Text accessibilityRole="header" className="flex-1 font-t3-bold text-base text-foreground">
          {proposedPlanTitle(props.markdown) ?? "Proposed plan"}
        </Text>
        <Menu
          accessible
          accessibilityLabel="Plan actions"
          accessibilityRole="button"
          actions={menuActions}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "copy") void copy();
            else if (nativeEvent.event === "save") openSave();
            else if (nativeEvent.event === "build") void build();
          }}
        >
          <Pressable
            accessibilityLabel="Plan actions"
            accessibilityRole="button"
            hitSlop={8}
            className="size-[30px] items-center justify-center rounded-[9px] border border-border active:opacity-70"
          >
            <SymbolView
              name={{ ios: "ellipsis", android: "more_vert" }}
              size={16}
              tintColorClassName="accent-foreground"
              type="monochrome"
            />
          </Pressable>
        </Menu>
      </View>
      {props.renderMarkdown(stripDisplayedPlanMarkdown(props.markdown))}
    </View>
  );
}
