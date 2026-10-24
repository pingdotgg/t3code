import {
  CODEX_MICRO_STATUS_COLORS,
  type CodexMicroAction,
  type CodexMicroControlId,
} from "@t3tools/contracts";
import {
  AppWindowIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CheckCheckIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  CommandIcon,
  GitCompareIcon,
  KeyboardIcon,
  PanelLeftIcon,
  SquareIcon,
  SquarePenIcon,
  TerminalIcon,
  XCircleIcon,
} from "lucide-react";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import type { CodexMicroSlot } from "../../codexMicro/codexMicroSlots";
import { describeCodexMicroAction } from "../../codexMicro/codexMicroActions";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const COMMAND_ICONS: Partial<Record<string, (className: string) => ReactNode>> = {
  "chat.new": (className) => <SquarePenIcon className={className} />,
  "chat.newLocal": (className) => <SquarePenIcon className={className} />,
  "terminal.toggle": (className) => <TerminalIcon className={className} />,
  "diff.toggle": (className) => <GitCompareIcon className={className} />,
  "commandPalette.toggle": (className) => <CommandIcon className={className} />,
  "thread.previous": (className) => <ArrowUpIcon className={className} />,
  "thread.next": (className) => <ArrowDownIcon className={className} />,
  "navigation.back": (className) => <ChevronLeftIcon className={className} />,
  "navigation.forward": (className) => <ChevronRightIcon className={className} />,
  "sidebar.toggle": (className) => <PanelLeftIcon className={className} />,
};

export function CodexMicroActionIcon(props: {
  readonly action: CodexMicroAction;
  readonly className?: string;
}) {
  const className = props.className ?? "size-4";
  switch (props.action.type) {
    case "approve":
      return <CheckCircle2Icon className={className} />;
    case "approveForSession":
      return <CheckCheckIcon className={className} />;
    case "decline":
      return <XCircleIcon className={className} />;
    case "stop":
      return <SquareIcon className={className} />;
    case "nextSlot":
      return <ArrowRightIcon className={className} />;
    case "previousSlot":
      return <ArrowLeftIcon className={className} />;
    case "focusApp":
      return <AppWindowIcon className={className} />;
    case "none":
      return <CircleSlashIcon className={className} />;
    case "command":
      return (
        COMMAND_ICONS[props.action.command]?.(className) ?? <KeyboardIcon className={className} />
      );
  }
}

const hex = (color: number) => `#${color.toString(16).padStart(6, "0")}`;

const KEY_BASE =
  "relative z-10 aspect-square w-full cursor-pointer rounded-xl outline-none transition-transform duration-150 focus-visible:ring-2 focus-visible:ring-micro-glow focus-visible:ring-inset";
const CAP =
  "absolute inset-0 flex items-center justify-center rounded-xl border border-white/90 bg-micro-cap text-foreground shadow-micro-cap dark:border-white/15";

function Key(props: {
  readonly label: string;
  readonly className?: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            className={cn(KEY_BASE, props.className)}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

interface PreviewProps {
  readonly slots: ReadonlyArray<CodexMicroSlot>;
  readonly selectedSlot: number | null;
  readonly pinnedThreads: ReadonlyArray<string | null>;
  readonly pressedKeys: ReadonlySet<string>;
  readonly joystick: { readonly angle: number; readonly distance: number };
  readonly separateMicrophoneKeys: boolean;
  readonly actionFor: (control: CodexMicroControlId) => CodexMicroAction;
  readonly onAgentKey: (index: number) => void;
  readonly onControl: (control: CodexMicroControlId) => void;
}

/** Interactive picture of the device, styled after Codex's own preview. */
export function CodexMicroDevicePreview(props: PreviewProps) {
  const commandKey = (control: CodexMicroControlId, wide = false) => {
    const action = props.actionFor(control);
    const pressed = props.pressedKeys.has(control) || (wide && props.pressedKeys.has("ACT11"));
    return (
      <Key
        key={control}
        label={describeCodexMicroAction(action)}
        className={cn(wide && "col-span-2 aspect-auto", pressed && "translate-y-px scale-[0.985]")}
        onClick={() => props.onControl(control)}
      >
        <span className={CAP}>
          <CodexMicroActionIcon action={action} className="size-5" />
        </span>
      </Key>
    );
  };

  const agentKey = (index: number) => {
    const slot = props.slots[index];
    const status = slot?.status ?? "off";
    const selected = props.selectedSlot === index;
    const pressed = props.pressedKeys.has(`AG0${index}`);
    const color = status === "off" ? "transparent" : hex(CODEX_MICRO_STATUS_COLORS[status]);
    const glow: CSSProperties = {
      backgroundColor: color,
      opacity: status === "off" ? 0 : pressed ? 0.45 : selected ? 0.4 : 0.25,
    };
    const tint: CSSProperties = {
      backgroundColor: color,
      opacity: status === "off" ? 0 : pressed ? 0.65 : selected ? 0.55 : 0.4,
    };
    return (
      <Key
        key={`AG0${index}`}
        label={slot?.threadId ? (slot.title ?? "Untitled thread") : `Agent key ${index + 1}`}
        className={cn(pressed && "translate-y-px scale-[0.985]")}
        onClick={() => props.onAgentKey(index)}
      >
        <span
          className="pointer-events-none absolute -inset-[5%] rounded-xl blur-sm transition-[background-color,opacity] duration-200"
          style={glow}
        />
        <span className="absolute inset-0 overflow-hidden rounded-xl border border-white/80 bg-white/45 shadow-micro-agent dark:border-white/15 dark:bg-white/10">
          <span
            className="absolute inset-0 transition-[background-color,opacity] duration-200"
            style={tint}
          />
          <span className="absolute inset-0 bg-gradient-to-br from-white/40 via-white/10 to-transparent dark:from-white/15 dark:via-white/5" />
          <span
            className={cn(
              "absolute top-1/2 left-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-micro-dot shadow-micro-dot transition-transform",
              pressed && "scale-110",
            )}
          />
          {props.pinnedThreads[index] ? (
            <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-foreground/50" />
          ) : null}
        </span>
      </Key>
    );
  };

  const knobPressed = [...props.pressedKeys].some((key) => key.startsWith("ENC"));
  const angle = props.joystick.angle * Math.PI * 2;
  const offset = Math.min(props.joystick.distance, 1) * 9;
  const stickStyle: CSSProperties = {
    transform: `translate(${Math.cos(angle) * offset}px, ${Math.sin(angle) * offset}px)`,
  };

  return (
    <div className="relative grid aspect-square w-full max-w-68 grid-cols-4 grid-rows-4 gap-1 rounded-xl border border-white/80 bg-micro-body p-2.5 shadow-micro-body dark:border-white/10">
      <div className="pointer-events-none absolute top-13 right-2.5 left-14 h-22 rounded-full bg-micro-glow/30 blur-2xl" />
      <Key label="Knob" className="rounded-full" onClick={() => props.onControl("ENC")}>
        <span
          className={cn(
            "pointer-events-none absolute -inset-0.5 rounded-full border border-transparent transition-[border-color,box-shadow]",
            knobPressed && "border-micro-glow/70 shadow-micro-ring",
          )}
        />
        <span className="absolute inset-[4%] overflow-hidden rounded-full bg-micro-knob shadow-micro-knob">
          <span className="absolute -top-4 left-3 h-24 w-12 rotate-45 bg-white/50 dark:bg-white/10" />
        </span>
      </Key>
      {agentKey(0)}
      {agentKey(1)}
      <Key label="Analog stick" onClick={() => props.onControl("JOY_UP")}>
        <span className="absolute inset-0 flex items-center justify-center rounded-xl border border-white/80 bg-micro-stick-housing shadow-micro-cap dark:border-white/10">
          <span
            className="size-[72%] rounded-full bg-micro-stick shadow-micro-stick transition-transform duration-75"
            style={stickStyle}
          />
        </span>
      </Key>
      {agentKey(2)}
      {agentKey(3)}
      {agentKey(4)}
      {agentKey(5)}
      {commandKey("ACT06")}
      {commandKey("ACT07")}
      {commandKey("ACT08")}
      {commandKey("ACT09")}
      <div
        aria-hidden
        className="relative z-10 flex aspect-square items-center justify-center gap-1"
      >
        <div className="flex flex-col gap-0.5">
          <span className="size-1 rounded-full bg-micro-led-active" />
          <span className="size-1 rounded-full bg-micro-led" />
          <span className="size-1 rounded-full bg-micro-led" />
        </div>
        <div className="size-[58%] rounded-full bg-micro-touch shadow-micro-cap" />
      </div>
      {props.separateMicrophoneKeys
        ? [commandKey("ACT10"), commandKey("ACT11")]
        : commandKey("ACT10", true)}
      {commandKey("ACT12")}
    </div>
  );
}
