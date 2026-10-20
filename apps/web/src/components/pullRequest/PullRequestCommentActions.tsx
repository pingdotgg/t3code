import {
  CheckIcon,
  ClipboardIcon,
  LinkIcon,
  MessageSquarePlusIcon,
  MoreHorizontalIcon,
  TextIcon,
  ExternalLinkIcon,
} from "lucide-react";
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
  const { copyToClipboard } = useCopyToClipboard({
    target: "comment",
    onError: () => toastManager.add({ type: "error", title: "Could not copy the comment" }),
  });
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-xs" variant="ghost-muted" />}
        aria-label="Comment actions"
        disabled={disabled}
      >
        <MoreHorizontalIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        {resolution ? (
          <>
            <MenuItem disabled={resolution.pending} onClick={resolution.onToggle}>
              <CheckIcon />
              {resolution.resolved ? "Unresolve thread" : "Resolve thread"}
            </MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        {url ? (
          <MenuItem
            onClick={() => (onOpen ? onOpen(url) : void readLocalApi()?.shell.openExternal(url))}
          >
            <ExternalLinkIcon />
            Open on host
          </MenuItem>
        ) : null}
        {onEdit ? <MenuItem onClick={onEdit}>Edit comment</MenuItem> : null}
        <MenuSub>
          <MenuSubTrigger>
            <ClipboardIcon />
            Copy
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
              Link to comment
            </MenuItem>
            <MenuItem disabled={body.length === 0} onClick={() => copyToClipboard(body, undefined)}>
              <TextIcon />
              Copy as Markdown
            </MenuItem>
          </MenuSubPopup>
        </MenuSub>
        {onAddToComposer ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={onAddToComposer}>
              <MessageSquarePlusIcon />
              Add to composer
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
