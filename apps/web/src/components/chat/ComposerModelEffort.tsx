import {
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  isReasoningControl,
  selectableProviderOptionChoices,
} from "@t3tools/client-runtime/model-traits";
import type { ProviderOptionDescriptor, RuntimeMode } from "@t3tools/contracts";
import type { EffortDisplay } from "@t3tools/contracts/settings";
import { getProviderOptionCurrentLabel } from "@t3tools/shared/model";
import { msg, T, useGT, useMessages } from "gt-react";
import { CheckIcon, ChevronRightIcon, ChevronUpIcon, WorkflowIcon } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, type ReactNode, useRef, useState } from "react";

import { m, type MessageResolver } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerControlSize } from "./ComposerControl";
import { ComposerPermissionsSection, type RuntimeModeOption } from "./ComposerFooterControls";
import { composerFloatingLayerProps, focusCheckedPermission } from "./composerEventScope";
import { EffortGlyph, FastBolt, resolveEffortGlyph } from "./EffortGlyph";
import {
  getTraitsSectionVisibility,
  type TraitsSelectionInput,
  ULTRATHINK_IN_BODY_NOTE,
  useTraitsSelection,
} from "./TraitsPicker";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
type BooleanDescriptor = Extract<ProviderOptionDescriptor, { type: "boolean" }>;

/** Service tiers, Claude's Fast mode, and Ultracode sit in the footer, not the column. */
function splitSpeed(
  selects: ReadonlyArray<SelectDescriptor>,
  toggles: ReadonlyArray<BooleanDescriptor>,
) {
  const speedSelect = selects.find((descriptor) => descriptor.id === "serviceTier") ?? null;
  const fastToggle = toggles.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const ultracodeToggle = toggles.find((descriptor) => descriptor.id === "ultracode") ?? null;
  return {
    speedSelect,
    fastToggle,
    ultracodeToggle,
    columnSelects: selects.filter((descriptor) => descriptor !== speedSelect),
    columnToggles: toggles.filter(
      (descriptor) => descriptor !== fastToggle && descriptor !== ultracodeToggle,
    ),
  };
}

type ColumnControl =
  | { kind: "select"; descriptor: SelectDescriptor }
  | { kind: "boolean"; descriptor: BooleanDescriptor };

/**
 * The column lists the model's reasoning levels under the header that names it. Other options,
 * such as an agent's session mode, sit below as one row each.
 */
function columnControls(
  selects: ReadonlyArray<SelectDescriptor>,
  toggles: ReadonlyArray<BooleanDescriptor>,
) {
  const { columnSelects, columnToggles } = splitSpeed(selects, toggles);
  const controls: ReadonlyArray<ColumnControl> = [
    ...columnSelects.map((descriptor) => ({ kind: "select" as const, descriptor })),
    ...columnToggles.map((descriptor) => ({ kind: "boolean" as const, descriptor })),
  ];
  const effort = controls.find((control) => isReasoningControl(control.descriptor)) ?? null;
  return { effort, others: controls.filter((control) => control !== effort) };
}

/**
 * What the model trigger shows after the model name: the effort word (or bars, per the
 * Appearance setting), a bolt for Fast, a workflow icon for Ultracode, and other traits such as a
 * context window.
 */
export function describeComposerEffort(
  traits: TraitsSelectionInput | null,
  effortDisplay: EffortDisplay,
  size: ComposerControlSize,
  resolve: MessageResolver = m,
): { suffix: ReactNode; detail: string | null } {
  if (!traits) return { suffix: null, detail: null };
  const visibility = getTraitsSectionVisibility({ ...traits, resolve });
  if (!visibility.hasAnyControls) return { suffix: null, detail: null };
  const modelSelection =
    traits.instanceId && traits.model
      ? { instanceId: traits.instanceId, model: traits.model, options: traits.modelOptions ?? [] }
      : null;
  const primary = visibility.primarySelectDescriptor;
  const display = buildTraitsTriggerDisplay(
    {
      descriptors: visibility.descriptors,
      primarySelectDescriptorId: primary?.id ?? null,
      ultrathinkPromptControlled: visibility.ultrathinkPromptControlled,
      modelSelection,
      reportedModelSelection: traits.reportedModelSelection,
    },
    resolve,
  );
  // The same reasoning control the column lists, wherever the agent put it among its options.
  const reasoning =
    columnControls(visibility.selectDescriptors, visibility.booleanDescriptors).effort
      ?.descriptor ?? null;
  const ultrathink = visibility.ultrathinkPromptControlled && reasoning === primary;
  const glyph =
    reasoning?.type === "select"
      ? resolveEffortGlyph(
          reasoning,
          ultrathink
            ? "ultrathink"
            : getDescriptorStringValue(reasoning, modelSelection, traits.reportedModelSelection),
        )
      : null;
  // Workflow levels such as Ultracode always show their name; the setting names every level.
  const word = glyph
    ? (glyph.special ?? (effortDisplay === "label" ? glyph.label : null))
    : !reasoning
      ? null
      : reasoning.type === "boolean"
        ? reasoning.currentValue === true
          ? resolve(msg("{option} On", { option: reasoning.label }))
          : resolve(msg("{option} Off", { option: reasoning.label }))
        : ultrathink
          ? "Ultrathink"
          : (getProviderOptionCurrentLabel(
              reasoning,
              modelSelection,
              traits.reportedModelSelection,
            ) ?? (reasoning.id === "thinking" ? reasoning.label : null));
  const fast = display.speedLabel === "Fast" || display.speedLabel === "Ultrafast";
  // Agent options such as modes live in the picker; the trigger adds only the context window.
  const contextWindow =
    visibility.contextWindowDescriptor &&
    getProviderOptionCurrentLabel(
      visibility.contextWindowDescriptor,
      modelSelection,
      traits.reportedModelSelection,
    );
  if (!word && !glyph && !fast && !display.ultracode && !contextWindow)
    return { suffix: null, detail: display.label };
  return {
    detail: display.label,
    suffix: (
      <span
        className={cn(
          "flex shrink-0 items-center gap-1.5 text-muted-foreground group-hover/model-trigger:text-foreground group-data-pressed/model-trigger:text-foreground group-data-popup-open/model-trigger:text-foreground",
          // A word space after the model name: the regular trigger's gap is wider than one.
          size === "sm" && "-ms-0.5",
        )}
      >
        {word ? (
          <span data-composer-control-label className="max-w-24 truncate">
            {word}
          </span>
        ) : glyph ? (
          <EffortGlyph count={glyph.count} filled={glyph.filled} size={size} />
        ) : null}
        {fast ? <FastBolt ultra={display.speedLabel === "Ultrafast"} /> : null}
        {display.ultracode ? (
          <WorkflowIcon aria-hidden="true" data-composer-control-icon className="size-3" />
        ) : null}
        {contextWindow ? (
          <span
            // A label, so icon-only footers drop it; compacted rows drop it before the model.
            data-composer-control-label
            data-composer-secondary-trait
            className="max-w-24 truncate text-xs"
          >
            {contextWindow}
          </span>
        ) : null}
      </span>
    ),
  };
}

const COLUMN_ROW =
  "flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-sm text-foreground outline-none hover:bg-foreground/[0.09] focus-visible:bg-foreground/[0.09] disabled:cursor-not-allowed disabled:opacity-64";
const COLUMN_LABEL = "px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs";

function ColumnRow(props: {
  label: string;
  /** Shown on hover; the column is too narrow to print it under the label. */
  description?: string | undefined;
  selected: boolean;
  /** The column's one tab stop: the selected level, else the first when none shows as selected. */
  tabStop: boolean;
  isDefault?: boolean | undefined;
  disabled?: boolean;
  onPick: () => void;
}) {
  const gt = useGT();
  const rowProps = {
    type: "button",
    role: "radio",
    "aria-checked": props.selected,
    disabled: props.disabled,
    "data-effort-row": true,
    // Focus lands on a level after a model pick, and a typed letter finds one by its label.
    "data-effort-level": props.label,
    // Up and Down move between rows.
    tabIndex: props.tabStop ? 0 : -1,
    className: COLUMN_ROW,
    onClick: props.onPick,
  } as const;
  const content = (
    <>
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.selected ? (
        <>
          {props.isDefault ? (
            <span className="sr-only">
              {gt("Default", { $context: "marks the default option" })}
            </span>
          ) : null}
          <CheckIcon aria-hidden="true" className="size-3.5" />
        </>
      ) : props.isDefault ? (
        <span className="text-muted-foreground/70 text-xs">
          {gt("Default", { $context: "marks the default option" })}
        </span>
      ) : null}
    </>
  );
  if (!props.description) return <button {...rowProps}>{content}</button>;
  return (
    <Tooltip>
      <TooltipTrigger render={<button {...rowProps} />}>{content}</TooltipTrigger>
      <TooltipPopup side="right" className="max-w-56">
        {props.description}
      </TooltipPopup>
    </Tooltip>
  );
}

function moveBetweenRows(event: KeyboardEvent<HTMLElement>) {
  const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";
  if (
    !arrow &&
    (event.key.length !== 1 ||
      event.key.trim() === "" ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.nativeEvent.isComposing)
  )
    return;
  // An option's side menu is a React child here, but it moves through its own items.
  if (!event.currentTarget.contains(event.target as Node)) return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-effort-row]:not(:disabled)"),
  );
  const index = rows.findIndex((row) => row === document.activeElement);
  const next = arrow
    ? rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))]
    : [...rows.slice(index + 1), ...rows.slice(0, index + 1)].find((row) =>
        row.dataset.effortLevel?.toLowerCase().startsWith(event.key.toLowerCase()),
      );
  if (!next) return;
  event.preventDefault();
  event.stopPropagation();
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}

function EffortLevels(props: { traits: TraitsSelectionInput }) {
  const traits = useTraitsSelection(props.traits);
  const { effort, others } = columnControls(traits.selectDescriptors, traits.booleanDescriptors);
  if (traits.modelIsUnavailable) {
    return (
      <>
        {traits.descriptors.map((descriptor) => {
          const value = traits.currentLabel(descriptor);
          return value ? (
            <div key={descriptor.id}>
              <div className={COLUMN_LABEL}>{descriptor.label}</div>
              <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">{value}</div>
            </div>
          ) : null;
        })}
      </>
    );
  }
  if (!effort && others.length === 0) return <NoEffortRow />;
  // Ultrathink in the prompt locks the levels; the first option then holds the tab stop.
  const locked =
    effort?.descriptor.id === traits.primarySelectDescriptor?.id && traits.ultrathinkInBodyText;
  return (
    <>
      {effort ? <EffortRows control={effort} traits={traits} locked={locked} /> : null}
      {others.length > 0 ? (
        <div
          className={cn("flex flex-col gap-0.5", effort && "mt-1 border-t border-border/70 pt-1")}
        >
          {others.map((control, index) =>
            control.kind === "boolean" ? (
              <OptionSwitchRow
                key={control.descriptor.id}
                descriptor={control.descriptor}
                traits={traits}
                tabStop={(!effort || locked) && index === 0}
              />
            ) : (
              <OptionMenuRow
                key={control.descriptor.id}
                descriptor={control.descriptor}
                traits={traits}
                tabStop={(!effort || locked) && index === 0}
              />
            ),
          )}
        </div>
      ) : null}
    </>
  );
}

const EFFORT_STARS = [
  { left: "8%", top: "30%", size: 2.5, duration: "2.6s", delay: "0s" },
  { left: "14%", top: "62%", size: 3.5, duration: "3.1s", delay: "-0.8s" },
  { left: "22%", top: "24%", size: 2, duration: "2.4s", delay: "-1.4s" },
  { left: "31%", top: "70%", size: 2.5, duration: "2.9s", delay: "-0.4s" },
  { left: "40%", top: "40%", size: 3, duration: "3.3s", delay: "-1.9s" },
  { left: "48%", top: "66%", size: 2, duration: "2.5s", delay: "-1.1s" },
  { left: "56%", top: "26%", size: 3.5, duration: "3.0s", delay: "-0.6s" },
  { left: "63%", top: "54%", size: 2.5, duration: "2.7s", delay: "-2.1s" },
  { left: "71%", top: "32%", size: 3, duration: "3.2s", delay: "-1.5s" },
  { left: "78%", top: "68%", size: 2, duration: "2.6s", delay: "-0.3s" },
  { left: "85%", top: "42%", size: 2.5, duration: "2.9s", delay: "-1.7s" },
  { left: "92%", top: "58%", size: 2, duration: "2.4s", delay: "-0.9s" },
] as const;

function EffortSpectrumSlider(props: {
  readonly label: string;
  readonly choices: ReturnType<typeof selectableProviderOptionChoices>;
  readonly value: string | undefined;
  readonly shown: boolean;
  readonly currentIndex: number;
  readonly disabled: boolean;
  readonly onSelectIndex: (index: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const count = props.choices.length;
  const safeIndex = Math.max(0, Math.min(count - 1, props.currentIndex));
  const fillPercent = count <= 1 ? 100 : 22 + (safeIndex / (count - 1)) * 78;
  const currentChoice = props.choices[safeIndex];

  const pickFromClientX = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || count <= 1) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const nextIndex = Math.round(ratio * (count - 1));
    if (nextIndex !== safeIndex) {
      props.onSelectIndex(nextIndex);
    }
  };

  return (
    <div className="mb-2 flex flex-col gap-1.5 px-1.5 pt-0.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{props.label}</span>
        <span className="font-medium text-foreground">{currentChoice?.label ?? ""}</span>
      </div>
      <div
        ref={trackRef}
        className={cn(
          "relative h-7 w-full select-none rounded-full bg-muted/80 shadow-inner outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-inset",
          props.disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer",
        )}
        onPointerDown={(event) => {
          if (props.disabled) return;
          draggingRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          pickFromClientX(event.clientX);
        }}
        onPointerMove={(event) => {
          if (!draggingRef.current || props.disabled) return;
          pickFromClientX(event.clientX);
        }}
        onPointerUp={(event) => {
          if (!draggingRef.current) return;
          draggingRef.current = false;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={() => {
          draggingRef.current = false;
        }}
      >
        <div
          className="pointer-events-none absolute inset-y-0 left-0 overflow-hidden rounded-full transition-[width] duration-300 ease-out"
          style={{ width: `${fillPercent}%` }}
        >
          <div
            className="effort-spectrum-fill absolute inset-y-0 left-0"
            style={{ width: `${(100 / fillPercent) * 100}%` }}
          />
          <div className="effort-spectrum-sheen absolute inset-y-0 left-0 w-1/2" />
          {EFFORT_STARS.map((star) => (
            <span
              key={`${star.left}-${star.top}`}
              aria-hidden="true"
              className="effort-spectrum-star absolute rounded-full"
              style={
                {
                  left: star.left,
                  top: star.top,
                  width: `${star.size}px`,
                  height: `${star.size}px`,
                  "--star-duration": star.duration,
                  "--star-delay": star.delay,
                } as CSSProperties
              }
            />
          ))}
        </div>

        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 size-6 -translate-y-1/2 rounded-full bg-white shadow-md transition-[left] duration-300 ease-out"
          style={{ left: `calc(${fillPercent}% - 1.625rem)` }}
        />

        <div
          className="absolute inset-0 grid"
          style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
        >
          {props.choices.map((option, index) => {
            const selected = option.id === props.value;
            const tabStop = props.shown ? selected : index === 0;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-label={option.label}
                aria-checked={selected}
                disabled={props.disabled}
                data-effort-row={true}
                data-effort-level={option.label}
                tabIndex={tabStop ? 0 : -1}
                className="h-full w-full cursor-pointer bg-transparent opacity-0 outline-none disabled:cursor-not-allowed"
                onClick={() => props.onSelectIndex(index)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

type TraitsSelection = ReturnType<typeof useTraitsSelection>;

function EffortRows(props: { control: ColumnControl; traits: TraitsSelection; locked: boolean }) {
  const gt = useGT();
  const messages = useMessages();
  const { control, traits } = props;
  const { descriptor } = control;
  if (control.kind === "boolean") {
    return (
      <div role="radiogroup" aria-label={descriptor.label} className="flex flex-col gap-0.5">
        {([true, false] as const).map((value) => (
          <ColumnRow
            key={String(value)}
            label={
              value
                ? gt("On", { $context: "option state" })
                : gt("Off", { $context: "option state" })
            }
            selected={(control.descriptor.currentValue === true) === value}
            tabStop={(control.descriptor.currentValue === true) === value}
            onPick={() => traits.changeBoolean(descriptor.id, value)}
          />
        ))}
      </div>
    );
  }
  const { locked } = props;
  const value = traits.selectValue(control.descriptor);
  const choices = selectableProviderOptionChoices(control.descriptor);
  // An "Ultrathink:" prefix selects a level the column does not offer.
  const shown = choices.some((option) => option.id === value);
  const currentIndex = Math.max(
    0,
    choices.findIndex((option) => option.id === value),
  );
  return (
    <div role="radiogroup" aria-label={descriptor.label} className="flex flex-col gap-0.5">
      {locked ? (
        <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
          {messages(ULTRATHINK_IN_BODY_NOTE)}
        </div>
      ) : null}
      {choices.length > 1 ? (
        <EffortSpectrumSlider
          label={descriptor.label}
          choices={choices}
          value={value}
          shown={shown}
          currentIndex={currentIndex}
          disabled={locked}
          onSelectIndex={(index) => {
            const target = choices[index];
            if (target) traits.changeSelect(control.descriptor, target.id);
          }}
        />
      ) : (
        choices.map((option, index) => (
          <ColumnRow
            key={option.id}
            label={option.label}
            selected={option.id === value}
            tabStop={shown ? option.id === value : index === 0}
            description={option.description}
            isDefault={option.isDefault}
            disabled={locked}
            onPick={() => traits.changeSelect(control.descriptor, option.id)}
          />
        ))
      )}
    </div>
  );
}

const OPTION_ROW = cn(COLUMN_ROW, "h-auto py-1");

/** An option's name over its current value. */
function OptionRowText(props: { label: string; value: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-muted-foreground text-xs">{props.label}</span>
      <span className="truncate">{props.value}</span>
    </span>
  );
}

/**
 * One select besides reasoning, such as an agent's session mode. It names the current choice and
 * opens the rest beside the column, so any number of options leaves the levels in place.
 */
function OptionMenuRow(props: {
  descriptor: SelectDescriptor;
  traits: TraitsSelection;
  /** Holds the column's tab stop when the model has no levels. */
  tabStop: boolean;
}) {
  const gt = useGT();
  const { descriptor, traits } = props;
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const choices = selectableProviderOptionChoices(descriptor);
  const value = traits.selectValue(descriptor);
  const current = choices.find((choice) => choice.id === value)?.label ?? "";
  return (
    <Menu
      open={open}
      // A modal menu would cover the picker, so the next click there would only close it.
      modal={false}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) return;
        const checked = popupRef.current?.querySelector<HTMLElement>(
          '[role="menuitemradio"][aria-checked="true"]',
        );
        checked?.focus({ preventScroll: true });
        checked?.scrollIntoView({ block: "nearest" });
      }}
    >
      {/* No hover opening: an opened menu takes focus, which would steal typing from search. */}
      <MenuTrigger
        render={
          <button
            type="button"
            data-effort-row
            tabIndex={props.tabStop ? 0 : -1}
            aria-label={`${descriptor.label}: ${current}`}
            className={cn(OPTION_ROW, "data-popup-open:bg-foreground/[0.09]")}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight") return;
              event.preventDefault();
              event.stopPropagation();
              setOpen(true);
            }}
          />
        }
      >
        <OptionRowText label={descriptor.label} value={current} />
        <ChevronRightIcon
          aria-hidden="true"
          className="-me-1 size-3.5 shrink-0 text-muted-foreground"
        />
      </MenuTrigger>
      <MenuPopup
        ref={popupRef}
        side="right"
        align="start"
        sideOffset={6}
        // A full-width column on phones leaves no room beside it, so fall below or above.
        collisionAvoidance={{ fallbackAxisSide: "end" }}
        className="max-w-72"
        data-model-picker-option-menu
        {...composerFloatingLayerProps}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft") return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }}
      >
        <MenuRadioGroup
          aria-label={descriptor.label}
          value={value}
          onValueChange={(next: string) => {
            if (next !== value) traits.changeSelect(descriptor, next);
          }}
        >
          {choices.map((choice) => (
            <MenuRadioItem key={choice.id} value={choice.id} closeOnClick>
              <span className="flex items-center gap-3">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{choice.label}</span>
                  {choice.description ? (
                    <span className="line-clamp-2 text-muted-foreground text-xs">
                      {choice.description}
                    </span>
                  ) : null}
                </span>
                {choice.isDefault ? (
                  <span className="text-muted-foreground/70 text-xs">
                    {gt("Default", { $context: "marks the default option" })}
                  </span>
                ) : null}
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/** A two-state option toggles in place; a menu would add a click for nothing. */
function OptionSwitchRow(props: {
  descriptor: BooleanDescriptor;
  traits: TraitsSelection;
  tabStop: boolean;
}) {
  const gt = useGT();
  const { descriptor, traits } = props;
  const checked = descriptor.currentValue === true;
  return (
    <label className={cn(OPTION_ROW, "has-focus-visible:bg-foreground/[0.09]")}>
      <OptionRowText
        label={descriptor.label}
        value={
          checked ? gt("On", { $context: "option state" }) : gt("Off", { $context: "option state" })
        }
      />
      <Switch
        size="sm"
        checked={checked}
        onCheckedChange={(next) => traits.changeBoolean(descriptor.id, next)}
        aria-label={descriptor.label}
        data-effort-row
        tabIndex={props.tabStop ? 0 : -1}
      />
    </label>
  );
}

function NoEffortRow() {
  return (
    <div className="flex h-8 items-center px-2 text-muted-foreground text-sm">
      <T>No effort levels</T>
    </div>
  );
}

/** The model picker's effort column: the selected model's levels and its other options. */
export function ComposerEffortColumn(props: { traits: TraitsSelectionInput | null }) {
  return (
    <div className="flex flex-col gap-1 px-2.5 py-2" onKeyDownCapture={moveBetweenRows}>
      {props.traits ? <EffortLevels traits={props.traits} /> : <NoEffortRow />}
    </div>
  );
}

const FOOTER_SEGMENT =
  "flex h-6 cursor-pointer items-center justify-center gap-1 px-2 text-muted-foreground text-xs outline-none first:rounded-l-md last:rounded-r-md hover:text-foreground data-checked:bg-input/72 data-checked:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

function SpeedSegment(props: {
  checked: boolean;
  label: string;
  /** The untranslated speed name that picks the bolt, when `label` is translated. */
  speed?: string;
  description?: string | undefined;
  onPick: () => void;
}) {
  const speed = props.speed ?? props.label;
  const buttonProps = {
    type: "button",
    role: "radio",
    "aria-checked": props.checked,
    "data-checked": props.checked || undefined,
    className: FOOTER_SEGMENT,
    onClick: props.onPick,
  } as const;
  const content = (
    <>
      {speed === "Fast" || speed === "Ultrafast" ? (
        <FastBolt ultra={speed === "Ultrafast"} />
      ) : null}
      {props.label}
    </>
  );
  if (!props.description) return <button {...buttonProps}>{content}</button>;
  return (
    <Tooltip>
      <TooltipTrigger render={<button {...buttonProps} />}>{content}</TooltipTrigger>
      <TooltipPopup side="top">{props.description}</TooltipPopup>
    </Tooltip>
  );
}

function SpeedControl(props: { traits: TraitsSelectionInput }) {
  const gt = useGT();
  const traits = useTraitsSelection(props.traits);
  const { speedSelect, fastToggle } = splitSpeed(
    traits.selectDescriptors,
    traits.booleanDescriptors,
  );
  if (traits.modelIsUnavailable || (!speedSelect && !fastToggle)) return null;
  return (
    <div
      role="radiogroup"
      aria-label={speedSelect?.label ?? fastToggle?.label}
      className="flex rounded-lg bg-input/40 p-0.5"
    >
      {speedSelect
        ? selectableProviderOptionChoices(speedSelect).map((option) => (
            <SpeedSegment
              key={option.id}
              checked={option.id === traits.selectValue(speedSelect)}
              label={option.label}
              description={option.description}
              onPick={() => traits.changeSelect(speedSelect, option.id)}
            />
          ))
        : fastToggle
          ? ([false, true] as const).map((value) => (
              <SpeedSegment
                key={String(value)}
                checked={(fastToggle.currentValue === true) === value}
                speed={value ? "Fast" : "Standard"}
                label={
                  value
                    ? gt("Fast", { $context: "response speed" })
                    : gt("Standard", { $context: "response speed" })
                }
                onPick={() => traits.changeBoolean(fastToggle.id, value)}
              />
            ))
          : null}
    </div>
  );
}

function UltracodeControl(props: { traits: TraitsSelectionInput }) {
  const traits = useTraitsSelection(props.traits);
  const { ultracodeToggle } = splitSpeed(traits.selectDescriptors, traits.booleanDescriptors);
  if (traits.modelIsUnavailable || !ultracodeToggle) return null;
  const on = ultracodeToggle.currentValue === true;
  return (
    <div className="flex rounded-lg bg-input/40 p-0.5">
      <button
        type="button"
        aria-pressed={on}
        data-checked={on || undefined}
        className={FOOTER_SEGMENT}
        onClick={() => traits.changeBoolean(ultracodeToggle.id, !on)}
      >
        <WorkflowIcon aria-hidden="true" className="size-3" />
        {ultracodeToggle.label}
      </button>
    </div>
  );
}

/** Permissions change rarely, so the footer names the mode and nests the choice in a menu. */
function PermissionsMenu(props: {
  runtimeMode: RuntimeMode;
  options: ReadonlyArray<RuntimeModeOption>;
  onChange: (mode: RuntimeMode) => void;
}) {
  const gt = useGT();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = props.options.find((option) => option.mode === props.runtimeMode);
  if (!current) return null;
  const CurrentIcon = current.icon;
  return (
    <Menu
      onOpenChangeComplete={(open) => {
        if (open) focusCheckedPermission(triggerRef.current);
      }}
    >
      <MenuTrigger
        render={
          <button
            ref={triggerRef}
            type="button"
            data-composer-permissions-trigger
            aria-label={gt("Permissions: {mode}", { mode: current.label })}
            className="ms-auto flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-muted-foreground text-xs outline-none hover:bg-foreground/[0.09] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:bg-foreground/[0.09] data-popup-open:text-foreground"
          />
        }
      >
        <CurrentIcon aria-hidden="true" className="size-3.5" />
        {current.label}
        <ChevronUpIcon aria-hidden="true" className="size-3" />
      </MenuTrigger>
      <MenuPopup side="top" align="end" {...composerFloatingLayerProps}>
        <ComposerPermissionsSection
          runtimeMode={props.runtimeMode}
          runtimeModeOptions={props.options}
          onRuntimeModeChange={props.onChange}
        />
      </MenuPopup>
    </Menu>
  );
}

/** The model picker's footer: speed stays one click away, permissions sit one menu deeper. */
export function ComposerPickerFooter(props: {
  traits: TraitsSelectionInput | null;
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border/70 bg-muted/40 px-3 py-2">
      {props.traits ? <SpeedControl traits={props.traits} /> : null}
      {props.traits ? <UltracodeControl traits={props.traits} /> : null}
      <PermissionsMenu
        runtimeMode={props.runtimeMode}
        options={props.runtimeModeOptions}
        onChange={props.onRuntimeModeChange}
      />
    </div>
  );
}
