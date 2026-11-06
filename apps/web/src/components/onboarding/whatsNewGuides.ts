export type WhatsNewAction =
  | "new-lesson"
  | "side-chats"
  | "what-you-know"
  | "quiz-cards"
  | "courses"
  | "chat-sync";

export type WhatsNewGuide = {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly benefit: string;
  readonly actionLabel: string;
  readonly action: WhatsNewAction;
};

export const whatsNewGuides: readonly WhatsNewGuide[] = [
  {
    id: "new-lesson",
    version: "0.1.7",
    title: "Start a lesson",
    benefit: "Turn a question into a focused lesson that builds your understanding step by step.",
    actionLabel: "Try a new lesson",
    action: "new-lesson",
  },
  {
    id: "side-chats",
    version: "0.1.7",
    title: "Ask in a side chat",
    benefit: "Explore a tricky idea beside your lesson, then keep the useful note in context.",
    actionLabel: "Try side chats",
    action: "side-chats",
  },
  {
    id: "what-you-know",
    version: "0.1.7",
    title: "See what you know",
    benefit: "Your practice notes become a map of the topics you have explained back.",
    actionLabel: "Try What you know",
    action: "what-you-know",
  },
  {
    id: "quiz-cards",
    version: "0.1.7",
    title: "Check yourself with quiz cards",
    benefit: "Quick questions reveal what stuck and help your lesson adapt.",
    actionLabel: "Try quiz cards",
    action: "quiz-cards",
  },
  {
    id: "courses",
    version: "0.1.7",
    title: "Follow a course",
    benefit: "Keep a course plan, quizzes, and lesson progress together.",
    actionLabel: "Try courses",
    action: "courses",
  },
  {
    id: "chat-sync",
    version: "0.1.7",
    title: "Bring over your T3 Code chats",
    benefit: "Continue learning from chats you already made in T3 Code.",
    actionLabel: "Try chat sync",
    action: "chat-sync",
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
}): { readonly guides: readonly WhatsNewGuide[]; readonly seed: readonly string[] | null } {
  const available = whatsNewGuides.filter(
    (guide) => guide.action !== "chat-sync" || chatSyncAvailable,
  );
  if (seen === null) {
    return {
      guides: existingInstall ? available : [],
      seed: existingInstall ? null : whatsNewGuides.map((guide) => guide.id),
    };
  }
  return {
    guides: available.filter((guide) => !seen.includes(guide.id)),
    seed: null,
  };
}
