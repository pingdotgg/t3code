import { SurfaceVisibilityContext } from "@t3tools/extension-sdk/host";
import { type ClientUiKit, type UiTreeRowProps } from "@t3tools/extension-sdk/ui";
import { BROWSER_SURFACE_OVERLAY_ATTRIBUTE } from "@t3tools/extension-sdk/catalogue";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ExternalLink,
  Minus,
  Monitor,
  MoreVertical,
  MousePointerClick,
  Plus,
  RotateCcw,
} from "lucide-react";
import { useContext, useEffect } from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import {
  Menu,
  MenuGroupLabel,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ensurePierreIconSprite, resolvePierreIconForEntry } from "~/pierre-icons";

const icons = {
  back: ArrowLeft,
  forward: ArrowRight,
  refresh: RefreshIcon,
  more: MoreVertical,
  external: ExternalLink,
  camera: Camera,
  annotate: MousePointerClick,
  viewport: Monitor,
  minus: Minus,
  plus: Plus,
  reset: RotateCcw,
};

function Icon({ name, active, refreshing, recording }: React.ComponentProps<ClientUiKit["Icon"]>) {
  if (!Object.hasOwn(icons, name)) return null;
  const Component = icons[name];
  return (
    <>
      <Component
        aria-hidden
        className={
          name === "camera" && recording ? "text-destructive" : active ? "text-primary" : undefined
        }
        {...(name === "refresh" ? { refreshing } : {})}
      />
      {name === "camera" && recording && (
        <span
          aria-hidden
          data-t3-recording-indicator=""
          className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-destructive"
        />
      )}
    </>
  );
}

function KitMenu({ open, onOpenChange, children }: React.ComponentProps<ClientUiKit["Menu"]>) {
  const visible = useContext(SurfaceVisibilityContext);
  useEffect(() => {
    if (!visible && open) onOpenChange(false);
  }, [visible, open, onOpenChange]);
  return (
    <Menu open={open && visible} onOpenChange={(next) => onOpenChange(next && visible)}>
      {children}
    </Menu>
  );
}

function TreeRow({
  path,
  depth,
  directory,
  expanded,
  selected,
  label,
  className,
  style,
  ...props
}: UiTreeRowProps) {
  useEffect(ensurePierreIconSprite, []);
  const icon = resolvePierreIconForEntry(path, directory ? "directory" : "file");
  return (
    <button
      type="button"
      role="treeitem"
      data-slot="extension-tree-row"
      aria-level={depth + 1}
      aria-selected={selected === true}
      aria-expanded={directory ? expanded === true : undefined}
      className={`relative flex h-full w-full items-center overflow-hidden border-0 text-left text-xs text-foreground outline-none [--extension-tree-hover:color-mix(in_srgb,currentColor_7%,transparent)] hover:bg-(--extension-tree-hover) focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring [--extension-tree-selected:color-mix(in_srgb,currentColor_12%,transparent)] aria-selected:bg-(--extension-tree-selected) ${className ?? ""}`}
      style={{
        borderRadius: 5,
        padding: "0 6.4px",
        paddingLeft: 6.4 + depth * 19.2,
        gap: 4.8,
        lineHeight: "24px",
        ...style,
      }}
      {...props}
    >
      <svg
        aria-hidden
        className={`size-4 shrink-0 ${directory && !expanded ? "-rotate-90" : ""}`}
        viewBox="0 0 32 32"
      >
        <use href={`#${directory ? "file-tree-icon-chevron" : icon?.name}`} />
      </svg>
      <span className="truncate">{label ?? path.split("/").at(-1)}</span>
    </button>
  );
}

export const hostUiKit: ClientUiKit = {
  version: 1,
  Button,
  Input: ({ controlSize, size, ...props }) => (
    <InputGroupInput size={controlSize ?? "default"} render={<input size={size} />} {...props} />
  ),
  InputGroup: ({ controlSize, className, ...props }) => (
    <InputGroup
      className={`group/extension-input ${controlSize === "sm" ? "h-7" : ""} ${className ?? ""}`}
      {...props}
    />
  ),
  InputGroupAddon: ({ revealOnHover, children, ...props }) => (
    <InputGroupAddon {...props}>
      <span
        className={
          revealOnHover
            ? "pointer-events-none flex opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover/extension-input:pointer-events-auto group-hover/extension-input:opacity-100"
            : undefined
        }
      >
        {children}
      </span>
    </InputGroupAddon>
  ),
  Toolbar: ({ variant = "chrome", className, ...props }) => (
    <div
      className={`${variant === "group" ? "flex items-center gap-0.5" : "flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"} ${className ?? ""}`}
      {...(variant === "chrome" ? { "data-surface-subheader": "" } : {})}
      {...props}
    />
  ),
  Menu: KitMenu,
  MenuTrigger: ({ children, ...props }) => <MenuTrigger render={children} {...props} />,
  MenuPopup: (props) => <MenuPopup {...props} {...{ [BROWSER_SURFACE_OVERLAY_ATTRIBUTE]: "" }} />,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup: (props) => (
    <MenuSubPopup {...props} {...{ [BROWSER_SURFACE_OVERLAY_ATTRIBUTE]: "" }} />
  ),
  MenuGroup,
  MenuRow: ({ label, children, ...props }) => (
    <MenuItem
      closeOnClick={false}
      onClick={(event) => event.preventDefault()}
      className="justify-between"
      {...props}
    >
      <span>{label}</span>
      <span className="flex items-center gap-1">{children}</span>
    </MenuItem>
  ),
  MenuNote: ({ numeric, className, ...props }) => (
    <span
      role="note"
      className={`${numeric ? "min-w-12 text-center text-xs tabular-nums text-muted-foreground" : "block px-2 py-1 text-xs text-muted-foreground"} ${className ?? ""}`}
      {...props}
    />
  ),
  MenuItem,
  MenuSeparator,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  TreeRow,
  Icon,
};
