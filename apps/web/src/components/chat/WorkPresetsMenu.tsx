import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { BookmarkIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import {
  Menu,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import {
  getWorkPresetsForEnvironment,
  useWorkPresetsStore,
  type WorkPreset,
} from "../../workPresetsStore";

export function WorkPresetsMenu(props: {
  environmentId: EnvironmentId;
  modelSelection: ModelSelection;
  size: ComposerControlSize;
  disabled?: boolean;
  onApply: (preset: WorkPreset) => void;
}) {
  const [open, setOpen] = useState(false);
  const presets = useWorkPresetsStore((state) =>
    getWorkPresetsForEnvironment(state, props.environmentId),
  );
  const save = useWorkPresetsStore((state) => state.save);
  const remove = useWorkPresetsStore((state) => state.remove);
  const composerFloatingLayerProps = useComposerMenuProps();

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            size={props.size}
            disabled={props.disabled}
            aria-label="Work presets"
            className={cn("shrink-0", open && "bg-accent text-foreground")}
          />
        }
      >
        <ComposerControlIcon icon={BookmarkIcon} size={props.size} />
        {props.size === "xs" ? null : (
          <span data-composer-control-label className="max-w-20 truncate">
            Presets
          </span>
        )}
      </MenuTrigger>
      <MenuPopup align="start" width="content" {...composerFloatingLayerProps}>
        <div className="px-2 pt-1 pb-1.5 font-medium text-muted-foreground text-xs">
          Work presets
        </div>
        {presets.length === 0 ? (
          <div className="px-2 py-2 text-muted-foreground text-xs">
            Save the current model and reasoning settings here.
          </div>
        ) : (
          presets.map((preset) => (
            <MenuSub key={preset.id}>
              <MenuSubTrigger>
                <BookmarkIcon />
                <MenuItemLabel title={preset.name}>{preset.name}</MenuItemLabel>
              </MenuSubTrigger>
              <MenuSubPopup>
                <MenuItem
                  onClick={() => {
                    props.onApply(preset);
                    setOpen(false);
                  }}
                >
                  <PlayIcon />
                  <MenuItemLabel>Apply preset</MenuItemLabel>
                </MenuItem>
                <MenuItem
                  variant="destructive"
                  onClick={() => remove(props.environmentId, preset.id)}
                >
                  <Trash2Icon />
                  <MenuItemLabel>Delete preset</MenuItemLabel>
                </MenuItem>
              </MenuSubPopup>
            </MenuSub>
          ))
        )}
        <MenuSeparator />
        <MenuItem
          disabled={props.disabled}
          onClick={() => {
            save(props.environmentId, props.modelSelection);
            setOpen(false);
          }}
        >
          <PlusIcon />
          <MenuItemLabel>Save current settings</MenuItemLabel>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
