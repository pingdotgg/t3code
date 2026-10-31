import {
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  REASONING_SELECT_DESCRIPTOR_IDS,
  selectableProviderOptionChoices,
} from "@t3tools/client-runtime/model-traits";
import type { ProviderOptionDescriptor, RuntimeMode } from "@t3tools/contracts";
import type { EffortDisplay } from "@t3tools/contracts/settings";
import { CheckIcon, ChevronUpIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, use, useRef } from "react";

import { cn } from "~/lib/utils";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerControlSize } from "./ComposerControl";
import { ComposerPermissionsSection, type RuntimeModeOption } from "./ComposerFooterControls";
import { composerFloatingLayerProps, focusCheckedPermission } from "./composerEventScope";
import { EffortGlyph, FastBolt, resolveEffortGlyph } from "./EffortGlyph";
import { DockedPickerContext } from "./ProviderModelPicker";
import {
  getTraitsSectionVisibility,
  type TraitsSelectionInput,
  ULTRATHINK_IN_BODY_NOTE,
  useTraitsSelection,
} from "./TraitsPicker";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
type BooleanDescriptor = Extract<ProviderOptionDescriptor, { type: "boolean" }>;

/** Codex service tiers and Claude's Fast mode share the footer's speed control. */
function splitSpeed(
  provider: TraitsSelectionInput["provider"],
  selects: ReadonlyArray<SelectDescriptor>,
  toggles: ReadonlyArray<BooleanDescriptor>,
) {
  const speedSelect =
    provider === "codex"
      ? (selects.find((descriptor) => descriptor.id === "serviceTier") ?? null)
      : null;
  const fastToggle = toggles.find((descriptor) => descriptor.id === "fastMode") ?? null;
  return {
    speedSelect,
    fastToggle,
    columnSelects: selects.filter((descriptor) => descriptor !== speedSelect),
    columnToggles: toggles.filter((descriptor) => descriptor !== fastToggle),
  };
}

type ColumnControl =
  | { kind: "select"; descriptor: SelectDescriptor }
  | { kind: "boolean"; descriptor: BooleanDescriptor };

/**
 * The column lists the model's reasoning control first, under the header that names it, then
 * its other options.
 */
function columnControls(
  provider: TraitsSelectionInput["provider"],
  selects: ReadonlyArray<SelectDescriptor>,
  toggles: ReadonlyArray<BooleanDescriptor>,
) {
  const { columnSelects, columnToggles } = splitSpeed(provider, selects, toggles);
  const controls: ReadonlyArray<ColumnControl> = [
    ...columnSelects.map((descriptor) => ({ kind: "select" as const, descriptor })),
    ...columnToggles.map((descriptor) => ({ kind: "boolean" as const, descriptor })),
  ];
  const effort =
    controls.find((control) => REASONING_SELECT_DESCRIPTOR_IDS.has(control.descriptor.id)) ?? null;
  return { effort, others: controls.filter((control) => control !== effort) };
}

/**
 * What the model trigger shows after the model name: the effort word (or bars, per the
 * Appearance setting), a bolt for Fast, and other traits such as a context window.
 */
export function describeComposerEffort(
  traits: TraitsSelectionInput | null,
  effortDisplay: EffortDisplay,
  size: ComposerControlSize,
): { suffix: ReactNode; detail: string | null } {
  if (!traits) return { suffix: null, detail: null };
  const visibility = getTraitsSectionVisibility(traits);
  if (!visibility.hasAnyControls) return { suffix: null, detail: null };
  const modelSelection =
    traits.instanceId && traits.model
      ? { instanceId: traits.instanceId, model: traits.model, options: traits.modelOptions ?? [] }
      : null;
  const primary = visibility.primarySelectDescriptor;
  const display = buildTraitsTriggerDisplay({
    provider: traits.provider,
    descriptors: visibility.descriptors,
    primarySelectDescriptorId: primary?.id ?? null,
    ultrathinkPromptControlled: visibility.ultrathinkPromptControlled,
    modelSelection,
    reportedModelSelection: traits.reportedModelSelection,
  });
  const glyph =
    primary && REASONING_SELECT_DESCRIPTOR_IDS.has(primary.id)
      ? resolveEffortGlyph(
          primary,
          visibility.ultrathinkPromptControlled
            ? "ultrathink"
            : getDescriptorStringValue(primary, modelSelection, traits.reportedModelSelection),
        )
      : null;
  // Without a reasoning select the whole label is the word; it already names speed and the rest.
  // Workflow levels such as Ultracode always show their name; the setting names every level.
  const word = glyph
    ? (glyph.special ?? (effortDisplay === "label" ? glyph.label : null))
    : display.label;
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
        {word !== null ? (
          <span data-composer-control-label>{word}</span>
        ) : glyph ? (
          <EffortGlyph count={glyph.count} filled={glyph.filled} size={size} />
        ) : null}
        {glyph && (display.speedLabel === "Fast" || display.speedLabel === "Ultrafast") ? (
          <FastBolt ultra={display.speedLabel === "Ultrafast"} />
        ) : null}
        {glyph && display.otherLabels.length > 0 ? (
          <span
            // A label, so icon-only footers drop it; compacted rows drop it before the model.
            data-composer-control-label
            data-composer-secondary-trait
            className="max-w-24 truncate text-xs"
          >
            {display.otherLabels.join(" · ")}
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
  isDefault?: boolean | undefined;
  disabled?: boolean;
  /** A level of the reasoning control, where focus lands after a model pick. */
  level: boolean;
  onPick: () => void;
}) {
  const rowProps = {
    type: "button",
    role: "radio",
    "aria-checked": props.selected,
    disabled: props.disabled,
    "data-effort-row": true,
    "data-effort-level": props.level || undefined,
    // The reasoning control holds the column's one tab stop; Up and Down move between rows.
    tabIndex: props.selected && props.level ? 0 : -1,
    className: COLUMN_ROW,
    onClick: props.onPick,
  } as const;
  const content = (
    <>
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.isDefault ? <span className="text-muted-foreground/70 text-xs">Default</span> : null}
      <CheckIcon aria-hidden="true" className={cn("size-3.5", !props.selected && "invisible")} />
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
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-effort-row]:not(:disabled)"),
  );
  const index = rows.findIndex((row) => row === document.activeElement);
  const next =
    rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
  if (!next) return;
  event.preventDefault();
  event.stopPropagation();
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}

function EffortLevels(props: { traits: TraitsSelectionInput }) {
  const traits = useTraitsSelection(props.traits);
  const { effort, others } = columnControls(
    props.traits.provider,
    traits.selectDescriptors,
    traits.booleanDescriptors,
  );
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
  const renderControl = (control: ColumnControl) => {
    const isEffort = control === effort;
    const { descriptor } = control;
    if (control.kind === "boolean") {
      return (
        <div
          key={descriptor.id}
          role="radiogroup"
          aria-label={descriptor.label}
          className="flex flex-col gap-0.5"
        >
          {isEffort ? null : <div className={COLUMN_LABEL}>{descriptor.label}</div>}
          {([true, false] as const).map((value) => (
            <ColumnRow
              key={String(value)}
              label={value ? "On" : "Off"}
              selected={(control.descriptor.currentValue === true) === value}
              level={isEffort}
              onPick={() => traits.changeBoolean(descriptor.id, value)}
            />
          ))}
        </div>
      );
    }
    const locked =
      descriptor.id === traits.primarySelectDescriptor?.id && traits.ultrathinkInBodyText;
    const value = traits.selectValue(control.descriptor);
    return (
      <div
        key={descriptor.id}
        role="radiogroup"
        aria-label={descriptor.label}
        className="flex flex-col gap-0.5"
      >
        {isEffort ? null : <div className={COLUMN_LABEL}>{descriptor.label}</div>}
        {locked ? (
          <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
            {ULTRATHINK_IN_BODY_NOTE}
          </div>
        ) : null}
        {selectableProviderOptionChoices(control.descriptor).map((option) => (
          <ColumnRow
            key={option.id}
            label={option.label}
            selected={option.id === value}
            description={option.description}
            isDefault={option.isDefault}
            disabled={locked}
            level={isEffort}
            onPick={() => traits.changeSelect(control.descriptor, option.id)}
          />
        ))}
      </div>
    );
  };
  return (
    <>
      {effort ? renderControl(effort) : null}
      {others.map(renderControl)}
    </>
  );
}

function NoEffortRow() {
  return (
    <div className="flex h-8 items-center px-2 text-muted-foreground text-sm">No effort levels</div>
  );
}

/** The model picker's effort column: the selected model's levels and its other options. */
export function ComposerEffortColumn(props: { traits: TraitsSelectionInput | null }) {
  const picker = use(DockedPickerContext);
  const visibility = props.traits ? getTraitsSectionVisibility(props.traits) : null;
  const effort =
    props.traits && visibility
      ? columnControls(
          props.traits.provider,
          visibility.selectDescriptors,
          visibility.booleanDescriptors,
        ).effort
      : null;
  return (
    <>
      {/* Matches the search row's box, so one rule runs across the top of the popup. */}
      <div className="shrink-0 px-3 pt-2.5">
        <div className="flex h-8.25 -translate-y-px items-center gap-2 border-b border-border/70 pb-1.5 text-sm">
          <span className="text-muted-foreground">{effort?.descriptor.label ?? "Effort"}</span>
          <span className="ms-auto min-w-0 truncate text-muted-foreground text-xs">
            {picker.modelLabel}
          </span>
        </div>
      </div>
      {/* pt-2.5 puts the first level on the same line as the first model. */}
      <div
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 pt-2.5 pb-1.5"
        onKeyDown={moveBetweenRows}
      >
        {props.traits ? <EffortLevels traits={props.traits} /> : <NoEffortRow />}
      </div>
    </>
  );
}

const FOOTER_SEGMENT =
  "flex h-6 cursor-pointer items-center justify-center gap-1 px-2 text-muted-foreground text-xs outline-none first:rounded-l-md last:rounded-r-md hover:text-foreground data-checked:bg-input/72 data-checked:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

function SpeedSegment(props: {
  checked: boolean;
  label: string;
  description?: string | undefined;
  onPick: () => void;
}) {
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
      {props.label === "Fast" || props.label === "Ultrafast" ? (
        <FastBolt ultra={props.label === "Ultrafast"} />
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
  const traits = useTraitsSelection(props.traits);
  const { speedSelect, fastToggle } = splitSpeed(
    props.traits.provider,
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
                label={value ? "Fast" : "Standard"}
                onPick={() => traits.changeBoolean(fastToggle.id, value)}
              />
            ))
          : null}
    </div>
  );
}

/** Permissions change rarely, so the footer names the mode and nests the choice in a menu. */
function PermissionsMenu(props: {
  runtimeMode: RuntimeMode;
  options: ReadonlyArray<RuntimeModeOption>;
  onChange: (mode: RuntimeMode) => void;
}) {
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
            aria-label={`Permissions: ${current.label}`}
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
      <PermissionsMenu
        runtimeMode={props.runtimeMode}
        options={props.runtimeModeOptions}
        onChange={props.onRuntimeModeChange}
      />
    </div>
  );
}
