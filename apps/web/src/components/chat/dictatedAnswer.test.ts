import { expect, it, vi } from "vite-plus/test";

import { submitDictatedAnswer } from "./dictatedAnswer";

it.each([
  { label: "an answer", transcript: "use the cache", sideChatUsable: true, side: null },
  {
    label: "a /side the transcript introduced",
    transcript: "/side explain this approach",
    sideChatUsable: true,
    side: "/side explain this approach",
  },
  {
    label: "a /side where side chats are unavailable",
    transcript: "/side explain this approach",
    sideChatUsable: false,
    side: undefined,
  },
])("routes $label on the completed transcript", async ({ transcript, sideChatUsable, side }) => {
  let finish: (text: string) => void = () => {};
  const submit = vi.fn();
  const sideChats: Array<Promise<string | null>> = [];
  submitDictatedAnswer({
    answer: { draft: { unchanged: () => true, commit: () => {} }, submit },
    submitAfterDictation: (onText) => {
      finish = onText;
    },
    sideChatUsable,
    sendSideChat: (pending) => sideChats.push(pending),
    onSubmitted: () => {},
  });
  finish(transcript);

  expect(submit).toHaveBeenCalledTimes(side ? 0 : 1);
  if (side === undefined) expect(sideChats).toEqual([]);
  else expect(await sideChats[0]).toBe(side);
});
