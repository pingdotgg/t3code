import {
  type BotAvatar as BotAvatarDefinition,
  botAvatarFor,
  botAvatarStillSvg,
} from "@t3tools/client-runtime/state/bot-avatar";
import type { BotAvatarChoice } from "@t3tools/contracts";
import type { AvatarMood, AvatarState } from "open-bot-avatar";
import { mountAvatar, type MountedAvatar } from "open-bot-avatar/dom";
import { useEffect, useRef } from "react";

const stillFrames = new Map<string, string>();

function stillFrame(avatar: BotAvatarDefinition, state: AvatarState, mood: AvatarMood): string {
  const key = `${avatar.definition.id}:${avatar.color}:${state}:${mood}`;
  let frame = stillFrames.get(key);
  if (frame === undefined) {
    frame = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(botAvatarStillSvg(avatar, state, mood))}`;
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
}) {
  const avatar = botAvatarFor(props.threadId, props.choice);
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
      src={stillFrame(avatar, props.state, props.mood ?? "neutral")}
      className="block shrink-0"
      width={props.size}
      height={props.size}
    />
  );
}
