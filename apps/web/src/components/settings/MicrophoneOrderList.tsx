import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDownIcon, ArrowUpIcon, GripVerticalIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { type BrowserMicrophone, updateMicrophoneOrder } from "../../speech/browserMicrophones";
import {
  type MicrophoneEntry,
  forgetMicrophone,
  microphoneEntryKey,
  moveMicrophone,
  preferredMicrophone,
} from "../../speech/microphoneOrder";
import { Button } from "../ui/button";

/** The saved microphone order. Keyboard users reorder with the step buttons. */
export function MicrophoneOrderList(props: {
  readonly order: ReadonlyArray<MicrophoneEntry>;
  readonly devices: ReadonlyArray<BrowserMicrophone>;
}) {
  const { order, devices } = props;
  const keys = order.map(microphoneEntryKey);
  const inUse = microphoneEntryKey(preferredMicrophone(order, devices));
  // Device ids stay hidden until microphone permission, so connection is unknown before it.
  const devicesKnown = devices.some((device) => device.deviceId);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const move = (key: string, steps: number) =>
    updateMicrophoneOrder((current) => moveMicrophone(current, key, steps));
  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id) return;
    const from = keys.indexOf(String(event.active.id));
    const to = keys.indexOf(String(event.over.id));
    if (from !== -1 && to !== -1) move(String(event.active.id), to - from);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={keys} strategy={verticalListSortingStrategy}>
        <ol
          aria-label="Microphones, preferred first"
          className="divide-y divide-border/60 rounded-lg border border-border/60"
        >
          {order.map((entry, index) => {
            const key = microphoneEntryKey(entry);
            const device =
              entry.kind === "device"
                ? devices.find((candidate) => candidate.deviceId === entry.deviceId)
                : undefined;
            return (
              <MicrophoneRow
                key={key}
                id={key}
                name={
                  entry.kind === "default"
                    ? "System default"
                    : entry.label || device?.label || "Saved microphone"
                }
                position={index + 1}
                count={order.length}
                inUse={key === inUse}
                notConnected={entry.kind === "device" && devicesKnown && !device}
                onMove={(steps) => move(key, steps)}
                onForget={
                  entry.kind === "device"
                    ? () => updateMicrophoneOrder((current) => forgetMicrophone(current, key))
                    : undefined
                }
              />
            );
          })}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

function MicrophoneRow(props: {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly count: number;
  readonly inUse: boolean;
  readonly notConnected: boolean;
  readonly onMove: (steps: number) => void;
  readonly onForget: (() => void) | undefined;
}) {
  const { name } = props;
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        // Phones put the marker and controls on a second line so names stay readable.
        "grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 py-1.5 ps-3 pe-1.5 @min-[32rem]/settings-row:grid-cols-[1rem_auto_minmax(0,1fr)_auto_auto]",
        isDragging && "relative z-10 rounded-lg bg-background shadow-md",
      )}
    >
      <span className="text-meta tabular-nums text-muted-foreground">{props.position}</span>
      <span className="col-span-2 text-body break-words @min-[32rem]/settings-row:col-span-1">
        {name}
      </span>
      <span className="col-start-2 flex @min-[32rem]/settings-row:col-start-auto">
        {props.inUse ? (
          <span className="rounded-sm bg-success/12 px-1 text-caption text-success-foreground">
            In use
          </span>
        ) : props.notConnected ? (
          <span className="text-caption text-muted-foreground">Not connected</span>
        ) : null}
      </span>
      <span
        ref={setActivatorNodeRef}
        {...listeners}
        aria-hidden
        className="hidden size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 hover:text-foreground active:cursor-grabbing @min-[32rem]/settings-row:flex"
      >
        <GripVerticalIcon className="size-3.5" />
      </span>
      <span className="flex items-center gap-0.5">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          disabled={props.position === 1}
          aria-label={`Move ${name} up`}
          onClick={() => props.onMove(-1)}
        >
          <ArrowUpIcon />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost-muted"
          disabled={props.position === props.count}
          aria-label={`Move ${name} down`}
          onClick={() => props.onMove(1)}
        >
          <ArrowDownIcon />
        </Button>
        {props.onForget ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Forget ${name}`}
            onClick={props.onForget}
          >
            <XIcon />
          </Button>
        ) : (
          <span aria-hidden className="size-7 sm:size-6" />
        )}
      </span>
    </li>
  );
}
