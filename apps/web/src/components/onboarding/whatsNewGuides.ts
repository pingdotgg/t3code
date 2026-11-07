export type WhatsNewGuide = {
  readonly id:
    | "new-lesson"
    | "side-chats"
    | "what-you-know"
    | "quiz-cards"
    | "question-cards"
    | "answer-types"
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
    id: "question-cards",
    version: "0.1.7",
    title: "Explain your thinking, out loud",
    benefit:
      "Lesson questions pop up as cards you answer by typing or speaking, so you think it through.",
    actionLabel: "Try question cards",
  },
  {
    id: "answer-types",
    version: "0.1.7",
    title: "More ways to answer",
    benefit: "Answer in your own words, fill in blanks, or give a number.",
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
  legacySeen,
  legacyInstall,
  chatSyncAvailable,
}: {
  readonly seen: readonly string[] | null;
  readonly legacySeen: readonly string[] | null;
  readonly legacyInstall: boolean;
  readonly chatSyncAvailable: boolean;
}) {
  // v1 records were seeded as "all seen" on any install without the v1 welcome key; only trust
  // them where that key proves the install predates What's new.
  const record = seen ?? (legacyInstall ? legacySeen : null);
  const available = whatsNewGuides.filter((guide) => guide.id !== "chat-sync" || chatSyncAvailable);
  return {
    available,
    guides: available.filter((guide) => !record?.includes(guide.id)),
    seen: record,
  };
}
