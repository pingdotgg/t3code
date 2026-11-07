export type WhatsNewGuide = {
  readonly id:
    | "new-lesson"
    | "side-chats"
    | "what-you-know"
    | "quiz-cards"
    | "courses"
    | "chat-sync";
  readonly version: string;
  readonly title: string;
  readonly benefit: string;
  readonly actionLabel: string;
};

export const whatsNewGuides: readonly WhatsNewGuide[] = [
  {
    id: "new-lesson",
    version: "0.1.7",
    title: "New lesson",
    benefit:
      "Say what you want to learn, how deep to go and why, and the lesson starts at your level.",
    actionLabel: "Try New lesson",
  },
  {
    id: "side-chats",
    version: "0.1.7",
    title: "Side chats, sorted by section",
    benefit:
      "Highlight anything you don't follow to ask about it on the side, and the map files each side chat under the lesson section it came from.",
    actionLabel: "Try side chats",
  },
  {
    id: "what-you-know",
    version: "0.1.7",
    title: "What you know, and practice",
    benefit:
      'Explain a topic back and, once it holds, it joins your map, ready for "practice what I know".',
    actionLabel: "Try What you know",
  },
  {
    id: "quiz-cards",
    version: "0.1.7",
    title: "Quiz cards",
    benefit:
      "Lessons check you with quick questions, and your answer, how sure you were and your thinking all go back to the lesson.",
    actionLabel: "Try a lesson",
  },
  {
    id: "courses",
    version: "0.1.7",
    title: "Follow a course",
    benefit:
      "Paste an MIT OpenCourseWare or YouTube course link into New lesson, and the lesson posts the outline and gets the next units ready.",
    actionLabel: "Try a course",
  },
  {
    id: "chat-sync",
    version: "0.1.7",
    title: "Sync from T3 Code",
    benefit: "Bring over the T3 Code chats OminaX doesn't have yet, in one click.",
    actionLabel: "Try Sync",
  },
];

export function resolveWhatsNewGuides({
  seen,
  existingInstall,
  chatSyncAvailable,
}: {
  readonly seen: readonly string[] | null;
  readonly existingInstall: boolean;
  readonly chatSyncAvailable: boolean;
}) {
  const available = whatsNewGuides.filter((guide) => guide.id !== "chat-sync" || chatSyncAvailable);
  if (seen === null) {
    return {
      available,
      guides: existingInstall ? available : [],
      seed: existingInstall ? null : whatsNewGuides.map((guide) => guide.id),
    };
  }
  return {
    available,
    guides: available.filter((guide) => !seen.includes(guide.id)),
    seed: null,
  };
}
