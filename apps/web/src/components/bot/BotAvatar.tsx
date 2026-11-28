import {
  type BotAvatar as BotAvatarDefinition,
  botAvatarFor,
} from "@t3tools/client-runtime/state/bot-avatar";
import type { BotAvatarChoice } from "@t3tools/contracts";
import { renderAvatarSvg, type AvatarMood, type AvatarState } from "open-bot-avatar";
import { mountAvatar, type MountedAvatar } from "open-bot-avatar/dom";
import { useEffect, useRef, useSyncExternalStore } from "react";

// Clock times whose still poses read clearly, cycled slowly where a Bot sits in a list: the eyes
// glance and blink, the thinking dots hop, the working ribbons sweep. The first is the resting pose.
const STILL_TIMES: Record<AvatarState, ReadonlyArray<number>> = {
  idle: [1.2, 3, 4.5, 7.5, 6],
  thinking: [1.2, 2.25, 4.5, 6.75],
  working: [2, 2.25, 3],
  waiting: [1.2, 3, 7.5, 4.5],
  blocked: [1.2],
  done: [1.2],
};

// One timer for every ticking avatar; each new frame is one cached image swap, never a repaint loop.
const TICK_MS = 2500;
let tick = 0;
const tickListeners = new Set<() => void>();
let tickTimer: ReturnType<typeof setInterval> | null = null;
function subscribeTick(listener: () => void) {
  tickListeners.add(listener);
  if (tickTimer === null) {
    tickTimer = setInterval(() => {
      if (document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      tick += 1;
      for (const notify of tickListeners) notify();
    }, TICK_MS);
  }
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0 && tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };
}
const readTick = () => tick;
const noTick = () => () => {};
const restingTick = () => 0;

/** A stable per-Bot offset, so a list of Bots does not move in lockstep. */
function phaseOf(threadId: string): number {
  let hash = 0;
  for (let index = 0; index < threadId.length; index++) {
    hash = (hash * 31 + threadId.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

const stillFrames = new Map<string, string>();

function stillFrame(
  avatar: BotAvatarDefinition,
  state: AvatarState,
  mood: AvatarMood,
  time: number,
): string {
  const key = `${avatar.definition.id}:${avatar.color}:${state}:${mood}:${time}`;
  let frame = stillFrames.get(key);
  if (frame === undefined) {
    const svg = renderAvatarSvg(avatar.definition, {
      color: avatar.color,
      state,
      mood,
      time,
    });
    frame = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    stillFrames.set(key, frame);
  }
  return frame;
}

function LiveAvatar(props: {
  avatar: BotAvatarDefinition;
  state: AvatarState;
  mood: AvatarMood;
  size: number;
  followPointer: boolean;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const mountedRef = useRef<MountedAvatar | null>(null);
  const { avatar, state, mood, followPointer } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the package's DOM renderer and destroys it on unmount
  useEffect(() => {
    const mounted = mountAvatar(hostRef.current!, {
      definition: avatar.definition,
      color: avatar.color,
      state,
      mood,
      followPointer,
      label: "",
    });
    mountedRef.current = mounted;
    return () => {
      mounted.destroy();
      mountedRef.current = null;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- state goes through update() below, so poses ease instead of remounting
  }, [avatar, followPointer]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the state into the mounted renderer, which eases to the new pose
  useEffect(() => {
    mountedRef.current?.update({ state, mood });
  }, [state, mood]);
  return (
    <span
      ref={hostRef}
      aria-hidden
      className="block shrink-0"
      style={{ width: props.size, height: props.size }}
    />
  );
}

/** A Bot's avatar: a still pose for its state, or the animated avatar while `live`. */
export function BotAvatar(props: {
  threadId: string;
  /** The avatar the Bot chose; absent picks one from its thread id. */
  choice?: BotAvatarChoice | null | undefined;
  state: AvatarState;
  /** How the Bot feels; happy shows ^^ eyes. */
  mood?: AvatarMood;
  size: number;
  live?: boolean;
  followPointer?: boolean;
  /** Cycles a few still poses every few seconds, for avatars that sit in a list. */
  idleMotion?: boolean;
}) {
  const avatar = botAvatarFor(props.threadId, props.choice);
  const ticking = props.idleMotion === true && props.live !== true;
  const now = useSyncExternalStore(
    ticking ? subscribeTick : noTick,
    ticking ? readTick : restingTick,
    restingTick,
  );
  const times = STILL_TIMES[props.state];
  const time = times[(now + phaseOf(props.threadId)) % times.length]!;
  if (props.live === true) {
    return (
      <LiveAvatar
        avatar={avatar}
        state={props.state}
        mood={props.mood ?? "neutral"}
        size={props.size}
        followPointer={props.followPointer === true}
      />
    );
  }
  return (
    <img
      alt=""
      aria-hidden
      draggable={false}
      src={stillFrame(avatar, props.state, props.mood ?? "neutral", ticking ? time : times[0]!)}
      className="block shrink-0"
      width={props.size}
      height={props.size}
    />
  );
}
