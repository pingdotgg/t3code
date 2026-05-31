import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { T3workWorkflowCardBody } from "~/t3work/chat/t3work-messageExtViews";
import type { PendingT3workInlineWorkflowPrompt } from "~/t3work/t3work-inlineRecipeLaunchLocal";
import type { T3workInlineRecipeLaunchOutcome } from "~/t3work/t3work-inlineRecipeLaunch";

export function T3workInlineWorkflowPromptDialog(props: {
  readonly prompt: PendingT3workInlineWorkflowPrompt | null;
  readonly onResolve: (outcome: T3workInlineRecipeLaunchOutcome | null) => void;
}) {
  const { prompt, onResolve } = props;
  const [submitting, setSubmitting] = useState(false);
  if (!prompt) {
    return null;
  }

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) {
          onResolve({ applied: false });
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader className="sr-only">
          <AlertDialogTitle>{prompt.title}</AlertDialogTitle>
          <AlertDialogDescription>{prompt.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="px-6 py-6">
          <T3workWorkflowCardBody
            workflowCard={prompt.workflowCard}
            onSubmitRecipeCardAction={async () => {
              setSubmitting(true);
              try {
                const outcome = await prompt.submitApprovedAction();
                setSubmitting(false);
                onResolve(outcome);
              } catch (error) {
                setSubmitting(false);
                throw error;
              }
            }}
          />
        </div>
        <AlertDialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => onResolve({ applied: false })}
          >
            Cancel
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
