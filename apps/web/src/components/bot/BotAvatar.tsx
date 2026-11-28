import {
  type BotAvatar as BotAvatarDefinition,
  botAvatarFor,
} from "@t3tools/client-runtime/state/bot-avatar";
import type { BotAvatarChoice } from "@t3tools/contracts";
import { renderAvatarSvg, type AvatarState } from "open-bot-avatar";
import { mountAvatar, type MountedAvatar } from "open-bot-avatar/dom";
import { useEffect, useRef } from "react";

// Times at which each state's still pose reads clearly; working shows its ribbons at 2s.
const STILL_TIME: Record<AvatarState, number> = {
  idle: 1.2,
  thinking: 1.2,
  working: 2,
  waiting: 1.2,
  blocked: 1.2,
  done: 1.2,
};

const stillFrames = new Map<string, string>();

function stillFrame(avatar: BotAvatarDefinition, state: AvatarState): string {
  const key = `${avatar.definition.id}:${avatar.color}:${state}`;
  let frame = stillFrames.get(key);
  if (frame === undefined) {
    const svg = renderAvatarSvg(avatar.definition, {
      color: avatar.color,
      state,
      time: STILL_TIME[state],
    });
    frame = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    stillFrames.set(key, frame);
  }
  return frame;
}

function LiveAvatar(props: {
  avatar: BotAvatarDefinition;
  state: AvatarState;
  size: number;
  followPointer: boolean;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const mountedRef = useRef<MountedAvatar | null>(null);
  const { avatar, state, followPointer } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the package's DOM renderer and destroys it on unmount
  useEffect(() => {
    const mounted = mountAvatar(hostRef.current!, {
      definition: avatar.definition,
      color: avatar.color,
      state,
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
    mountedRef.current?.update({ state });
  }, [state]);
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
  size: number;
  live?: boolean;
  followPointer?: boolean;
}) {
  const avatar = botAvatarFor(props.threadId, props.choice);
  if (props.live === true) {
    return (
      <LiveAvatar
        avatar={avatar}
        state={props.state}
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
      src={stillFrame(avatar, props.state)}
      className="block shrink-0"
      width={props.size}
      height={props.size}
    />
  );
}
