import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function TriageSettingsRow({ environmentId }: { environmentId: EnvironmentId | null }) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, openScratchProject } = useScratchProject();
  const handleNewThread = useNewThreadHandler();
  const prepareTriage = useAtomCommand(serverEnvironment.prepareTriage, { reportFailure: false });
  const [pending, setPending] = useState(false);

  const targetEnvironmentId = scratchEnvironmentId(environmentId ?? primaryEnvironmentId);
  const allowed = useAtomValue(serverEnvironment.prepareTriage.permissionAtom(targetEnvironmentId));
  const supported =
    environments.find((entry) => entry.environmentId === targetEnvironmentId)?.serverConfig
      ?.environment.capabilities.triage === true;
  if (targetEnvironmentId === null || !supported) return null;

  const start = async () => {
    const prepared = await prepareTriage({ environmentId: targetEnvironmentId, input: {} });
    if (prepared._tag === "Failure") {
      if (!isAtomCommandInterrupted(prepared)) {
        const error = squashAtomCommandFailure(prepared);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start triage",
            description: error instanceof Error ? error.message : "Something went wrong.",
          }),
        );
      }
      return;
    }
    const project = await openScratchProject(targetEnvironmentId, "Could not start triage");
    if (project === null) return;
    const opened = await handleNewThread(scopeProjectRef(project.environmentId, project.id));
    if (opened === null) return;
    const drafts = useComposerDraftStore.getState();
    const existing = drafts.getComposerDraft(opened.draftId)?.prompt ?? "";
    if (existing.trim().length === 0) {
      drafts.setPrompt(opened.draftId, prepared.value.prompt);
      return;
    }
    const id = toastManager.add({
      type: "info",
      title: "Triage prompt ready",
      description: "This thread already has a draft. Replace it with the triage prompt?",
      timeout: 0,
      actionProps: {
        children: "Replace draft",
        onClick: () => {
          toastManager.close(id);
          useComposerDraftStore.getState().setPrompt(opened.draftId, prepared.value.prompt);
        },
      },
    });
  };

  return (
    <SettingsRow
      {...searchableSetting("triage")}
      description="Start a thread to triage a problem you're having with T3 Code."
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={!allowed || pending}
          onClick={() => {
            setPending(true);
            void start()
              .catch((error: unknown) => {
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: "Could not start triage",
                    description: error instanceof Error ? error.message : "Something went wrong.",
                  }),
                );
              })
              .finally(() => setPending(false));
          }}
        >
          Triage
        </Button>
      }
    />
  );
}
