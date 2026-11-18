import {
  CheckIcon,
  ClipboardIcon,
  LinkIcon,
  MessageSquarePlusIcon,
  MoreHorizontalIcon,
  TextIcon,
  ExternalLinkIcon,
} from "lucide-react";
import { T, msg, useGT } from "gt-react";
import { m } from "~/i18n/messages";
import { readLocalApi } from "~/localApi";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";

export function PullRequestCommentActions({
  body,
  url,
  onEdit,
  onOpen,
  resolution,
  onCopyLink,
  disabled,
  onAddToComposer,
}: {
  body: string;
  onOpen?: ((url: string) => void) | undefined;
  url: string | null;
  onCopyLink?: (() => Promise<string | null>) | undefined;
  disabled?: boolean | undefined;
  onAddToComposer?: (() => void) | undefined;
  onEdit?: (() => void) | undefined;
  resolution?:
    | {
        resolved: boolean;
        pending: boolean;
        onToggle: () => void;
      }
    | undefined;
}) {
  const gt = useGT();
  const { copyToClipboard } = useCopyToClipboard({
    target: {
      target: "comment",
      unavailableMessage: msg("Clipboard API is unavailable while copying the comment."),
      failureMessage: msg("Failed to copy the comment to the clipboard."),
    },
    onError: () => toastManager.add({ type: "error", title: m(msg("Could not copy the comment")) }),
  });
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-xs" variant="ghost-muted" />}
        aria-label={gt("Comment actions")}
        disabled={disabled}
      >
        <MoreHorizontalIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        {resolution ? (
          <>
            <MenuItem disabled={resolution.pending} onClick={resolution.onToggle}>
              <CheckIcon />
              {resolution.resolved ? gt("Unresolve thread") : gt("Resolve thread")}
            </MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        {url ? (
          <MenuItem
            onClick={() => (onOpen ? onOpen(url) : void readLocalApi()?.shell.openExternal(url))}
          >
            <ExternalLinkIcon />
            <T>Open on host</T>
          </MenuItem>
        ) : null}
        {onEdit ? (
          <MenuItem onClick={onEdit}>
            <T>Edit comment</T>
          </MenuItem>
        ) : null}
        <MenuSub>
          <MenuSubTrigger>
            <ClipboardIcon />
            <T>Copy</T>
          </MenuSubTrigger>
          <MenuSubPopup>
            <MenuItem
              disabled={!url && !onCopyLink}
              onClick={() =>
                void (async () => {
                  const link = onCopyLink ? await onCopyLink() : url;
                  if (link) await copyToClipboard(link, undefined);
                })()
              }
            >
              <LinkIcon />
              <T>Link to comment</T>
            </MenuItem>
            <MenuItem disabled={body.length === 0} onClick={() => copyToClipboard(body, undefined)}>
              <TextIcon />
              <T>Copy as Markdown</T>
            </MenuItem>
          </MenuSubPopup>
        </MenuSub>
        {onAddToComposer ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={onAddToComposer}>
              <MessageSquarePlusIcon />
              <T>Add to composer</T>
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
