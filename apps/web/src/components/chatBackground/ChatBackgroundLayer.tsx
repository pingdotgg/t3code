import type { ChatBackgroundEffect } from "@t3tools/contracts";

import { useChatBackgroundUrl } from "./chatBackgroundStore";

// Fade curves from monocode: the artwork reads at the top and is gone before the composer.
const EMPTY_MASK =
  "linear-gradient(to bottom, #000 0 19%, rgb(0 0 0 / 79%) 30%, rgb(0 0 0 / 50%) 42%, rgb(0 0 0 / 20%) 54%, rgb(0 0 0 / 5%) 64%, transparent 72%)";
const THREAD_MASK =
  "linear-gradient(to bottom, #000 0 18%, rgb(0 0 0 / 61%) 32%, rgb(0 0 0 / 32%) 47%, rgb(0 0 0 / 11%) 62%, transparent 72%)";

// Under messages the artwork recedes, as monocode's session view does (its 24% to our default 60%).
const THREAD_OPACITY_SCALE = 0.4;

export function ChatBackgroundLayer({
  effect,
  light,
  opacity,
  empty,
}: {
  effect: ChatBackgroundEffect;
  light: boolean;
  opacity: number;
  empty: boolean;
}) {
  const url = useChatBackgroundUrl(effect, light);
  if (!url) return null;
  const mask = empty ? EMPTY_MASK : THREAD_MASK;
  return (
    <div
      aria-hidden
      data-chat-background-active={empty ? "empty" : "thread"}
      className="pointer-events-none absolute inset-0 -z-10 bg-cover bg-center bg-no-repeat"
      style={{
        backgroundImage: `url(${JSON.stringify(url)})`,
        maskImage: mask,
        WebkitMaskImage: mask,
        opacity: (opacity / 100) * (empty ? 1 : THREAD_OPACITY_SCALE),
      }}
    />
  );
}
