import { msg, T, useGT } from "gt-react";
import { m } from "../../i18n/messages";
import type { ProviderDriverKind } from "@t3tools/contracts";
import { memo } from "react";
import { UsersIcon } from "lucide-react";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { cn } from "~/lib/utils";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { useComposerMenuState } from "./useComposerMenuState";
import { ModelEsque, getTriggerDisplayModelName } from "./providerIconUtils";

/** Menu value standing in for "no override": subagents run the thread's model. */
const SUBAGENT_MODEL_INHERIT = "inherit";

export interface SubagentModelControlProps {
  /**
   * Models offered for the thread's own provider instance. Subagents run
   * inside that instance's process, so nothing else is reachable from here.
   */
  instanceModels: ReadonlyArray<ModelEsque>;
  driverKind: ProviderDriverKind;
  /** Selected subagent model slug, or null when subagents inherit. */
  value: string | null;
  /** Display name of the thread's model, shown as what "Inherit" resolves to. */
  threadModelLabel: string;
  onChange: (model: string | null) => void;
}

function subagentModelTriggerLabel(input: {
  value: string | null;
  instanceModels: ReadonlyArray<ModelEsque>;
  driverKind: ProviderDriverKind;
}): string {
  if (input.value === null) return m(msg("Subagents: inherit"));
  const match = input.instanceModels.find((option) => option.slug === input.value);
  return m(
    msg("Subagents: {value}", {
      value: match ? getTriggerDisplayModelName(match, input.driverKind) : input.value,
    }),
  );
}

/**
 * Menu body, shared by the composer's own trigger and the compact overflow
 * menu so both entry points offer the same choices.
 */
export const SubagentModelMenuContent = memo(function SubagentModelMenuContent(
  props: SubagentModelControlProps,
) {
  return (
    <MenuGroup>
      <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
        <T>Subagent model</T>
      </div>
      <MenuRadioGroup
        value={props.value ?? SUBAGENT_MODEL_INHERIT}
        onValueChange={(value) => {
          if (!value) return;
          props.onChange(value === SUBAGENT_MODEL_INHERIT ? null : value);
        }}
      >
        <MenuRadioItem value={SUBAGENT_MODEL_INHERIT} hideIndicator closeOnClick>
          <span className="flex w-full min-w-0 flex-col">
            <span className="min-w-0 truncate">
              <T>Inherit</T>
            </span>
            <span className="max-w-56 text-pretty text-muted-foreground/80 text-xs">
              <T>Same as the thread:</T> {props.threadModelLabel}
            </span>
          </span>
        </MenuRadioItem>
        {props.instanceModels.map((option) => (
          <MenuRadioItem key={option.slug} value={option.slug} hideIndicator closeOnClick>
            <span className="flex w-full min-w-0 items-center justify-between gap-3">
              <span className="min-w-0 truncate">
                {getTriggerDisplayModelName(option, props.driverKind)}
              </span>
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </MenuGroup>
  );
});

/**
 * Per-thread control for the model subagents run on. Both CLIs read that model
 * when a session opens, so a change lands from the next turn; an agent that
 * names a model on its own spawn call still overrides it.
 */
export const SubagentModelPicker = memo(function SubagentModelPicker(
  props: SubagentModelControlProps & {
    compact?: boolean;
    size?: ComposerControlSize;
    /**
     * The resting strip keeps this control mounted out of flow while every
     * block fits inline. Its portaled popup would outlive that transition, so
     * an open menu closes when its trigger hides.
     */
    hidden?: boolean;
    triggerClassName?: string;
  },
) {
  const gt = useGT();
  const size = props.size ?? "sm";
  const [isMenuOpen, setIsMenuOpen] = useComposerMenuState(props.hidden);
  const label = subagentModelTriggerLabel({
    value: props.value,
    instanceModels: props.instanceModels,
    driverKind: props.driverKind,
  });

  return (
    <Menu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            size={size}
            aria-label={gt("Subagent model")}
            data-chat-subagent-model-picker="true"
            className={cn(
              "min-w-0 shrink justify-start overflow-hidden whitespace-nowrap",
              props.compact ? "max-w-36" : "max-w-44 sm:max-w-52",
              props.triggerClassName,
            )}
          />
        }
      >
        <span className="flex w-full min-w-0 items-center gap-1.5 overflow-hidden">
          <ComposerControlIcon icon={UsersIcon} size={size} />
          <span className="min-w-0 truncate">{label}</span>
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        <SubagentModelMenuContent
          instanceModels={props.instanceModels}
          driverKind={props.driverKind}
          value={props.value}
          threadModelLabel={props.threadModelLabel}
          onChange={props.onChange}
        />
      </MenuPopup>
    </Menu>
  );
});
