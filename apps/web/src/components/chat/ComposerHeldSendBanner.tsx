import { msg, useGT } from "gt-react";

import { composerTargetKey, type ComposerThreadTarget } from "../../composerDraftStore";
import { m, type MessageResolver } from "../../i18n/messages";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { usePreparingComposerImages } from "./preparingComposerImages";

export const HELD_COMPOSER_SEND_BANNER_ID = "held-composer-send";

function HeldComposerSendStatus({ draftTarget }: { readonly draftTarget: ComposerThreadTarget }) {
  const gt = useGT();
  const preparingCount = usePreparingComposerImages(composerTargetKey(draftTarget)).length;
  const label =
    preparingCount > 0
      ? gt(
          "{count, plural, one {Sending once image is ready} other {Sending once {count} images are ready}}",
          { count: preparingCount },
        )
      : gt("Sending message");
  return <span aria-live="polite">{label}</span>;
}

/** Shown while a send waits for pasted or dropped images to finish compressing. */
export function heldComposerSendBannerItem(
  input: {
    readonly draftTarget: ComposerThreadTarget;
    readonly onCancel: () => void;
  },
  resolve: MessageResolver = m,
): ComposerBannerStackItem {
  return {
    id: HELD_COMPOSER_SEND_BANNER_ID,
    variant: "info",
    icon: <Spinner size="xs" aria-hidden="true" />,
    title: <HeldComposerSendStatus draftTarget={input.draftTarget} />,
    description: resolve(msg("Edit or press Esc to cancel")),
    actions: (
      <Button
        size="xs"
        variant="ghost-muted"
        onPointerDown={(event) => event.preventDefault()}
        onClick={input.onCancel}
      >
        {resolve(msg("Cancel"))}
      </Button>
    ),
  };
}
