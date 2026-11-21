import type {
  CanvasAnimatableProperty,
  CanvasAnimation,
  CanvasNode,
  CanvasOp,
  CanvasShadow,
} from "@t3tools/contracts";
import { makeCanvasNodeId } from "@t3tools/shared/canvasOps";
import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react";
import { Minus, Plus } from "lucide-react";
import { type ReactNode, useSyncExternalStore } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { definePluginComponent } from "~/plugins/features";
import { canvasEnvironment } from "~/state/canvas";

import type { CanvasDocumentController } from "./canvasDocumentStore";
import { firstSolidColor, measureCanvasText } from "./canvasNodes";

const FONT_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
const ANIMATABLE: ReadonlyArray<Exclude<CanvasAnimatableProperty, "fill">> = [
  "x",
  "y",
  "width",
  "height",
  "rotation",
  "opacity",
  "scale",
  "cornerRadius",
];
const DEFAULT_SHADOW: CanvasShadow = { x: 0, y: 4, blur: 12, spread: 0, color: "#00000040" };

export const CanvasInspector = definePluginComponent(
  "component:components/canvas/CanvasInspector",
  PluginOriginalCanvasInspector,
);

/** Compact properties for the single selected node, or the document name. */
function PluginOriginalCanvasInspector(props: {
  readonly controller: CanvasDocumentController;
  readonly selection: ReadonlyArray<string>;
}) {
  const { controller, selection } = props;
  const gt = useGT();
  const canEdit = useAtomValue(canvasEnvironment.applyOps.permissionAtom(controller.environmentId));
  // Select only what is shown, from committed state: drag frames, the hidden
  // text-edit preview, and agent batches elsewhere skip this tree.
  const docName = useSyncExternalStore(
    controller.subscribe,
    () => controller.getCommittedDocument()?.name ?? null,
  );
  const node = useSyncExternalStore(controller.subscribe, () =>
    selection.length === 1 ? controller.getCommittedDocument()?.nodes[selection[0]!] : undefined,
  );

  const update = (patch: Record<string, unknown>) => {
    if (!node) return;
    controller.commit([{ op: "update", id: node.id, patch }]);
  };

  return (
    <aside
      aria-label={gt("Inspector")}
      className="flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border/60 bg-background px-3 py-3 text-xs"
    >
      <fieldset disabled={!canEdit} className="contents">
        {docName === null ? null : selection.length > 1 ? (
          <p className="text-muted-foreground">
            {gt("{count, plural, one {{count} layers selected} other {{count} layers selected}}", {
              count: selection.length,
            })}
          </p>
        ) : !node ? (
          <Section title={gt("Canvas")}>
            <TextField
              label={gt("Name")}
              value={docName}
              onCommit={(name) => {
                if (name.trim() && name !== docName) {
                  controller.commit([{ op: "rename", name: name.trim() } satisfies CanvasOp]);
                }
              }}
            />
            <p className="text-muted-foreground">{gt("Select a layer to edit it.")}</p>
          </Section>
        ) : (
          <>
            <Section title={node.name ?? node.type}>
              <Row>
                <NumberField label="X" value={node.x} onCommit={(x) => update({ x })} />
                <NumberField label="Y" value={node.y} onCommit={(y) => update({ y })} />
              </Row>
              <Row>
                <NumberField
                  label="W"
                  value={node.width}
                  min={1}
                  onCommit={(width) => update(textSizing(node, { width }))}
                />
                <NumberField
                  label="H"
                  value={node.height}
                  min={1}
                  onCommit={(height) => update({ height })}
                />
              </Row>
              <Row>
                <NumberField
                  label="°"
                  value={node.rotation ?? 0}
                  onCommit={(rotation) => update({ rotation: rotation === 0 ? null : rotation })}
                />
                <NumberField
                  label="R"
                  value={
                    Array.isArray(node.cornerRadius)
                      ? node.cornerRadius[0]
                      : (node.cornerRadius ?? 0)
                  }
                  min={0}
                  onCommit={(radius) => update({ cornerRadius: radius === 0 ? null : radius })}
                />
              </Row>
              <NumberField
                label="%"
                value={Math.round((node.opacity ?? 1) * 100)}
                min={0}
                max={100}
                onCommit={(percent) =>
                  update({ opacity: percent >= 100 ? null : Math.max(0, percent) / 100 })
                }
              />
            </Section>
            {node.type === "text" && node.text ? (
              <TextSection node={node} update={update} />
            ) : (
              <FillSection node={node} update={update} />
            )}
            <ShadowSection node={node} update={update} />
            <AnimationSection node={node} update={update} />
          </>
        )}
      </fieldset>
    </aside>
  );
}

/** Typing a width into an auto-width text box makes it wrap there. */
function textSizing(node: CanvasNode, patch: Record<string, unknown>) {
  if (node.text && (node.text.sizing ?? "auto-width") === "auto-width") {
    return { ...patch, text: { ...node.text, sizing: "auto-height" } };
  }
  return patch;
}

function FillSection(props: {
  node: CanvasNode;
  update: (patch: Record<string, unknown>) => void;
}) {
  const gt = useGT();
  const color = firstSolidColor(props.node);
  const fills = props.node.fills ?? [];
  const index = fills.findIndex((paint) => paint.type === "solid");
  return (
    <Section
      title={gt("Fill", { $context: "inspector section for the layer's paint" })}
      action={
        color === null ? (
          <IconAction
            label={gt("Add fill")}
            onClick={() => props.update({ fills: [...fills, { type: "solid", color: "#d9d9d9" }] })}
          >
            <Plus />
          </IconAction>
        ) : (
          <IconAction
            label={gt("Remove fill")}
            onClick={() => {
              const next = fills.filter((_, i) => i !== index);
              props.update({ fills: next.length > 0 ? next : null });
            }}
          >
            <Minus />
          </IconAction>
        )
      }
    >
      {color !== null ? (
        <ColorField
          value={color}
          onCommit={(next) =>
            props.update({
              fills: fills.map((paint, i) =>
                i === index ? { type: "solid", color: next } : paint,
              ),
            })
          }
        />
      ) : fills.length > 0 ? (
        <p className="text-muted-foreground">{fills[0]!.type} fill</p>
      ) : null}
    </Section>
  );
}

function TextSection(props: {
  node: CanvasNode;
  update: (patch: Record<string, unknown>) => void;
}) {
  const gt = useGT();
  const text = props.node.text!;
  const commitText = (patch: Partial<typeof text>) => {
    const next = { ...text, ...patch };
    const size = measureCanvasText(next);
    const sizing = next.sizing ?? "auto-width";
    props.update(
      sizing === "auto-width"
        ? { text: next, width: size.width, height: size.height }
        : sizing === "auto-height"
          ? { text: next, height: size.height }
          : { text: next },
    );
  };
  return (
    <Section title={gt("Text", { $context: "inspector section for text properties" })}>
      <Row>
        <NumberField
          label={gt("Size", { $context: "font size" })}
          value={text.fontSize}
          min={1}
          onCommit={(fontSize) => commitText({ fontSize })}
        />
        <div className="min-w-0 flex-1">
          <Select
            value={String(text.fontWeight ?? 400)}
            onValueChange={(value) => commitText({ fontWeight: Number(value) })}
          >
            <SelectTrigger size="xs" className="min-w-0" aria-label={gt("Font weight")}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {FONT_WEIGHTS.map((weight) => (
                <SelectItem key={weight} value={String(weight)}>
                  {weight}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </Row>
      <ColorField value={text.color} onCommit={(color) => commitText({ color })} />
    </Section>
  );
}

function ShadowSection(props: {
  node: CanvasNode;
  update: (patch: Record<string, unknown>) => void;
}) {
  const gt = useGT();
  const shadows = props.node.shadows ?? [];
  const shadow = shadows[0];
  const set = (patch: Partial<CanvasShadow>) =>
    props.update({ shadows: [{ ...shadow!, ...patch }, ...shadows.slice(1)] });
  return (
    <Section
      title={gt("Shadow", { $context: "inspector section for drop shadows" })}
      action={
        shadow ? (
          <IconAction
            label={gt("Remove shadow")}
            onClick={() => props.update({ shadows: shadows.length > 1 ? shadows.slice(1) : null })}
          >
            <Minus />
          </IconAction>
        ) : (
          <IconAction
            label={gt("Add shadow")}
            onClick={() => props.update({ shadows: [DEFAULT_SHADOW] })}
          >
            <Plus />
          </IconAction>
        )
      }
    >
      {shadow ? (
        <>
          <Row>
            <NumberField label="X" value={shadow.x} onCommit={(x) => set({ x })} />
            <NumberField label="Y" value={shadow.y} onCommit={(y) => set({ y })} />
          </Row>
          <Row>
            <NumberField
              label={gt("Blur", { $context: "shadow blur radius" })}
              value={shadow.blur}
              min={0}
              onCommit={(blur) => set({ blur })}
            />
            <NumberField
              label={gt("Spread", { $context: "shadow spread distance" })}
              value={shadow.spread}
              onCommit={(spread) => set({ spread })}
            />
          </Row>
          <ColorField value={shadow.color} onCommit={(color) => set({ color })} />
        </>
      ) : null}
    </Section>
  );
}

function AnimationSection(props: {
  node: CanvasNode;
  update: (patch: Record<string, unknown>) => void;
}) {
  const gt = useGT();
  const animations = props.node.animations ?? [];
  const animation = animations[0];
  const set = (next: CanvasAnimation) =>
    props.update({ animations: [next, ...animations.slice(1)] });
  const simple =
    animation &&
    animation.property !== "fill" &&
    animation.keyframes.length === 2 &&
    typeof animation.keyframes[0]!.value === "number" &&
    typeof animation.keyframes[1]!.value === "number";
  const setKeyframe = (index: 0 | 1, value: number) => {
    if (!animation) return;
    set({
      ...animation,
      keyframes: animation.keyframes.map((keyframe, i) =>
        i === index ? { ...keyframe, value } : keyframe,
      ),
    });
  };
  return (
    <Section
      title={gt("Animation")}
      action={
        animation ? (
          <IconAction
            label={gt("Remove animation")}
            onClick={() =>
              props.update({ animations: animations.length > 1 ? animations.slice(1) : null })
            }
          >
            <Minus />
          </IconAction>
        ) : (
          <IconAction
            label={gt("Add animation")}
            onClick={() =>
              props.update({
                animations: [
                  {
                    id: makeCanvasNodeId(),
                    property: "opacity",
                    keyframes: [
                      { offset: 0, value: 0 },
                      { offset: 1, value: props.node.opacity ?? 1 },
                    ],
                    durationMs: 600,
                    loop: true,
                    alternate: true,
                  } satisfies CanvasAnimation,
                ],
              })
            }
          >
            <Plus />
          </IconAction>
        )
      }
    >
      {animation && !simple ? (
        <p className="text-muted-foreground">
          {gt(
            "{count, plural, one {{property} · {count} keyframes · {duration}ms} other {{property} · {count} keyframes · {duration}ms}}",
            {
              property: animation.property,
              count: animation.keyframes.length,
              duration: animation.durationMs,
            },
          )}
        </p>
      ) : animation ? (
        <>
          <Select
            value={animation.property}
            onValueChange={(property) =>
              set({ ...animation, property: property as CanvasAnimatableProperty })
            }
          >
            <SelectTrigger size="xs" className="min-w-0" aria-label={gt("Animated property")}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {ANIMATABLE.map((property) => (
                <SelectItem key={property} value={property}>
                  {property}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Row>
            <NumberField
              label={gt("From", { $context: "animation start value" })}
              value={animation.keyframes[0]!.value as number}
              onCommit={(value) => setKeyframe(0, value)}
            />
            <NumberField
              label={gt("To", { $context: "animation end value" })}
              value={animation.keyframes[1]!.value as number}
              onCommit={(value) => setKeyframe(1, value)}
            />
          </Row>
          <Row>
            <NumberField
              label="ms"
              value={animation.durationMs}
              min={1}
              onCommit={(durationMs) => set({ ...animation, durationMs })}
            />
            <label className="flex min-w-0 flex-1 items-center justify-end gap-2 text-muted-foreground">
              {gt("Loop", { $context: "repeat the animation" })}
              <Switch
                size="sm"
                checked={animation.loop === true}
                onCheckedChange={(loop) => set({ ...animation, loop })}
              />
            </label>
          </Row>
        </>
      ) : null}
    </Section>
  );
}

function Section(props: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex h-5 items-center justify-between gap-2">
        <h3 className="truncate font-medium text-foreground">{props.title}</h3>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}

function Row(props: { children: ReactNode }) {
  return <div className="flex gap-2">{props.children}</div>;
}

function IconAction(props: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Button variant="ghost-muted" size="icon-xs" aria-label={props.label} onClick={props.onClick}>
      {props.children}
    </Button>
  );
}

/** Commits on Enter or blur; Escape restores. Remounts when the value changes. */
function NumberField(props: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onCommit: (value: number) => void;
}) {
  const shown = Math.round(props.value * 100) / 100;
  return (
    <label className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="min-w-6 shrink-0 text-muted-foreground">{props.label}</span>
      <Input
        key={shown}
        size="compact"
        font="mono"
        nativeInput
        inputMode="decimal"
        defaultValue={String(shown)}
        onBlur={(event) => {
          const parsed = Number.parseFloat(event.currentTarget.value);
          if (!Number.isFinite(parsed)) {
            event.currentTarget.value = String(shown);
            return;
          }
          const clamped = Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, parsed));
          if (clamped !== shown) props.onCommit(clamped);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            event.currentTarget.value = String(shown);
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function TextField(props: { label: string; value: string; onCommit: (value: string) => void }) {
  return (
    <label className="flex min-w-0 items-center gap-1.5">
      <span className="w-10 shrink-0 text-muted-foreground">{props.label}</span>
      <Input
        key={props.value}
        size="compact"
        nativeInput
        defaultValue={props.value}
        onBlur={(event) => props.onCommit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            event.currentTarget.value = props.value;
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

/** A native swatch picker plus hex entry. Keeps an existing alpha suffix. */
function ColorField(props: { value: string; onCommit: (value: string) => void }) {
  const gt = useGT();
  const alpha = props.value.length === 9 ? props.value.slice(7) : "";
  const { onCommit } = props;
  // The native `change` event fires once the picker closes; React's onChange fires per drag step.
  // The ref callback reattaches the listener when onCommit changes.
  const attachSwatch = (swatch: HTMLInputElement | null) => {
    if (!swatch) return;
    const commit = () => onCommit(`${swatch.value}${alpha}`);
    swatch.addEventListener("change", commit);
    return () => swatch.removeEventListener("change", commit);
  };
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span
        className="relative size-6 shrink-0 overflow-hidden rounded-md border border-border"
        style={{ background: props.value }}
      >
        <input
          ref={attachSwatch}
          type="color"
          aria-label={gt("Pick color")}
          defaultValue={props.value.slice(0, 7)}
          key={props.value}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </span>
      <Input
        key={props.value}
        size="compact"
        font="mono"
        nativeInput
        defaultValue={props.value}
        onBlur={(event) => {
          const next = event.currentTarget.value.trim();
          const normalized = next.startsWith("#") ? next : `#${next}`;
          if (/^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(normalized) && normalized !== props.value) {
            props.onCommit(normalized.toLowerCase());
          } else {
            event.currentTarget.value = props.value;
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            event.currentTarget.value = props.value;
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}
