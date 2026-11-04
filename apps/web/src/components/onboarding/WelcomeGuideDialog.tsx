import { useAtomValue } from "@effect/atom-react";
import { supportsLessonSideChats } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import {
  ArrowUpIcon,
  BookOpenIcon,
  ChevronRightIcon,
  MessageCircleIcon,
  MessageCircleQuestionIcon,
  QuoteIcon,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { create } from "zustand";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useClientSettings } from "~/hooks/useSettings";
import { shortcutLabelForCommand } from "~/keybindings";
import { cn } from "~/lib/utils";
import { environmentPresentations } from "~/state/presentation";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { T3LearnWordmark } from "../T3LearnWordmark";
import { Button } from "../ui/button";
import { Dialog, DialogDescription } from "../ui/dialog";
import { Kbd } from "../ui/kbd";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../ui/wizard";

export const WELCOME_GUIDE_SEEN_STORAGE_KEY = "t3learn:welcome-guide-seen:v1";
const WelcomeGuideSeenSchema = Schema.NullOr(Schema.String);

const useWelcomeGuideRequest = create<{ requested: boolean }>(() => ({ requested: false }));

/** Opens the side-chat guide, whether or not this device has seen it. */
export function openWelcomeGuide() {
  useWelcomeGuideRequest.setState({ requested: true });
}

// Subscribed on import rather than by the host: a Help menu click that has to open a window
// delivers the action on load, long before the auth and first-run gates mount the host, and
// Electron drops a message nobody listens for. The store holds the request until the host mounts.
if (typeof window !== "undefined") {
  window.desktopBridge?.onMenuAction((action) => {
    if (action === "open-welcome-guide") openWelcomeGuide();
  });
}

// The host sits at the app root, so it reads one boolean instead of every environment's config.
const sideChatsAvailableAtom = Atom.make((get) => {
  for (const config of get(environmentPresentations.serverConfigsAtom).values()) {
    if (supportsLessonSideChats(config.environment)) return true;
  }
  return false;
}).pipe(Atom.withLabel("web-welcome-guide-side-chats-available"));

export function WelcomeGuideHost({ hostedStatic }: { readonly hostedStatic: boolean }) {
  const requested = useWelcomeGuideRequest((state) => state.requested);
  const [seenAt, setSeenAt] = useLocalStorage(
    WELCOME_GUIDE_SEEN_STORAGE_KEY,
    null,
    WelcomeGuideSeenSchema,
  );
  // Hosted static never records onboarding, and has no setup wizard to wait for.
  const setupDone = useClientSettings((settings) => settings.onboardingCompletedAt !== null);
  const sideChatsAvailable = useAtomValue(sideChatsAvailableAtom);
  // Keeps a dismissal for the session even when storage refuses the write.
  const [dismissed, setDismissed] = useState(false);

  const autoOpen =
    seenAt === null && !dismissed && (hostedStatic || setupDone) && sideChatsAvailable;
  if (!requested && !autoOpen) return null;

  const close = () => {
    useWelcomeGuideRequest.setState({ requested: false });
    setDismissed(true);
    setSeenAt((current) => current ?? new Date().toISOString());
  };
  return <WelcomeGuideDialog onClose={close} />;
}

function WelcomeGuideDialog({ onClose }: { readonly onClose: () => void }) {
  const [step, setStep] = useState(0);
  const nextRef = useRef<HTMLButtonElement>(null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const steps = guideSteps(
    shortcutLabelForCommand(keybindings, "sideChat.askSelection"),
    shortcutLabelForCommand(keybindings, "sideChat.toggleMap"),
  );
  const last = step === steps.length - 1;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <WizardPopup size="wide" initialFocus={nextRef}>
        <WizardHeader
          title="Welcome guide"
          identity={
            <div className="flex items-baseline gap-1.5" role="img" aria-label="T3 Learn">
              <T3LearnWordmark className="h-4 w-auto shrink-0" aria-hidden />
              <span className="text-2xl font-medium tracking-tight text-muted-foreground">
                Learn
              </span>
            </div>
          }
        >
          <WizardSteps
            label="Guide progress"
            steps={steps.map((item) => item.label)}
            currentStep={step}
            onStepChange={setStep}
          />
        </WizardHeader>
        <WizardPanel>
          <div className="space-y-4">
            {steps[step]?.illustration}
            {/* Every step's text shares one cell, so the panel keeps the tallest step's height at
                any width. Focus opens on Next, so the description is how a screen reader hears
                the first step, and the live region how it hears the rest. */}
            <DialogDescription render={<div />} aria-live="polite" className="grid">
              {steps.map((item, index) => (
                <div
                  key={item.label}
                  className={cn(
                    "col-start-1 row-start-1 space-y-1.5",
                    index !== step && "invisible",
                  )}
                >
                  <h3 className="text-lg font-semibold tracking-tight text-foreground">
                    {item.title}
                  </h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{item.body}</p>
                  {item.footnote ? (
                    <p className="pt-1 text-xs text-muted-foreground">{item.footnote}</p>
                  ) : null}
                </div>
              ))}
            </DialogDescription>
          </div>
        </WizardPanel>
        {/* Hidden rather than removed at either end, so the footer keeps its size. */}
        <WizardFooter
          leading={
            <Button variant="ghost" className={last ? "invisible" : undefined} onClick={onClose}>
              Skip
            </Button>
          }
        >
          <Button
            variant="outline"
            className={step === 0 ? "invisible" : undefined}
            onClick={() => {
              // Back hides on the first step and would drop keyboard focus onto the popup.
              if (step === 1) nextRef.current?.focus();
              setStep(step - 1);
            }}
          >
            Back
          </Button>
          <Button ref={nextRef} onClick={last ? onClose : () => setStep(step + 1)}>
            {last ? "Start learning" : "Next"}
          </Button>
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}

function guideSteps(askShortcut: string | null, mapShortcut: string | null) {
  return [
    {
      label: "Welcome",
      illustration: <LessonMock />,
      title: "Welcome to T3 Learn",
      body: "Every chat is a lesson. When a reply uses something you don't know yet, you can dig into it on the side while the lesson stays on track.",
    },
    {
      label: "Highlight",
      illustration: <SelectionMock askShortcut={askShortcut} />,
      title: "Highlight what you don't get",
      body: (
        <>
          Select any words in a reply, then choose Ask in side chat
          {askShortcut === null ? null : (
            <>
              {" "}
              or press <Kbd>{askShortcut}</Kbd>
            </>
          )}
          .
        </>
      ),
    },
    {
      label: "Ask",
      illustration: <SidePanelMock />,
      title: "Ask your own question",
      body: "A side chat opens next to the lesson. It already knows what you highlighted and what the lesson is about. Ask anything, and highlight inside it to go deeper.",
    },
    {
      label: "Done",
      illustration: <NoteMock />,
      title: "Press Done when it clicks",
      body: "The AI writes a short note about where you got stuck. It goes with your next lesson message so the lesson can adjust, and the side chat itself stays out of the lesson.",
    },
    {
      label: "Map",
      illustration: <MapMock />,
      title: "See it all on the Map",
      body: (
        <>
          The side-chat header's map toggle shows every side chat in the lesson.
          {mapShortcut === null ? null : (
            <>
              {" "}
              Press <Kbd>{mapShortcut}</Kbd> to open it, then click one to pick it back up or move
              around with the arrow keys.
            </>
          )}
          {mapShortcut === null
            ? " Click one to pick it back up, or move around with the arrow keys."
            : null}
        </>
      ),
      footnote: "You can open this guide again from Settings.",
    },
  ];
}

// Static pictures of the real UI, all one height so changing steps never resizes the panel.
function Illustration({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      role="img"
      aria-label={label}
      className="flex h-44 flex-col justify-center gap-2.5 overflow-hidden rounded-lg border bg-muted/40 p-4 text-xs text-foreground select-none"
    >
      {children}
    </div>
  );
}

function UserBubble() {
  return (
    <div className="max-w-4/5 self-end rounded-xl border bg-card px-3 py-1.5">
      How do noise-cancelling headphones work?
    </div>
  );
}

function ReplyText({ highlight }: { readonly highlight: ReactNode }) {
  return (
    <p className="min-w-0 flex-1 leading-relaxed">
      A mic on each ear cup hears the noise outside, and the speaker plays the same wave flipped
      over. The two cancel out through {highlight}, so you hear far less.
    </p>
  );
}

function LessonMock() {
  return (
    <Illustration label="A lesson reply with an asked phrase underlined and a side chat tag beside it">
      <UserBubble />
      <div className="flex items-end gap-2">
        <ReplyText
          highlight={
            <span className="rounded-sm bg-primary/10 underline decoration-primary/70 decoration-dotted decoration-2 underline-offset-2">
              destructive interference
            </span>
          }
        />
        <span className="mb-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-primary bg-background text-primary">
          <MessageCircleIcon className="size-2.5" />
        </span>
      </div>
    </Illustration>
  );
}

function SelectionMock({ askShortcut }: { readonly askShortcut: string | null }) {
  return (
    <Illustration label="Selected words in a reply with Cite and Ask in side chat buttons above them">
      <div className="flex items-center gap-1 self-center">
        <span className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-1 font-medium shadow-xs">
          <QuoteIcon className="size-3.5 text-muted-foreground" />
          Cite
        </span>
        <span className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-1 font-medium shadow-xs">
          <MessageCircleQuestionIcon className="size-3.5 text-muted-foreground" />
          Ask in side chat
          {askShortcut === null ? null : <Kbd>{askShortcut}</Kbd>}
        </span>
      </div>
      <ReplyText
        highlight={
          <span className="rounded-sm bg-primary/25 ring-1 ring-primary/40">
            destructive interference
          </span>
        }
      />
    </Illustration>
  );
}

function SideChatPath() {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      <span className="shrink-0 px-1 text-muted-foreground">Lesson</span>
      <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate px-1 font-medium">destructive interference</span>
    </div>
  );
}

function SidePanelMock() {
  return (
    <Illustration label="A side chat open next to the lesson, waiting for your question">
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex w-1/4 flex-col justify-center gap-2" aria-hidden>
          <span className="h-1.5 w-full rounded-full bg-muted-foreground/20" />
          <span className="h-1.5 w-4/5 rounded-full bg-muted-foreground/20" />
          <span className="h-1.5 w-full rounded-full bg-muted-foreground/20" />
          <span className="h-1.5 w-3/5 rounded-full bg-muted-foreground/20" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border bg-card">
          <div className="flex items-center border-b px-1.5 py-1.5">
            <SideChatPath />
          </div>
          <p className="flex flex-1 items-center justify-center px-3 text-center text-muted-foreground">
            What do you want to know about “destructive interference”?
          </p>
          <div className="m-2 flex items-center gap-2 rounded-md border bg-background py-1 pr-1 pl-2">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              Ask your own question…
            </span>
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <ArrowUpIcon className="size-3" />
            </span>
          </div>
        </div>
      </div>
    </Illustration>
  );
}

function NoteMock() {
  return (
    <Illustration label="A finished side chat's note waiting to go with the next lesson message">
      <div className="overflow-hidden rounded-md border bg-card">
        {/* After Done: the real panel drops the button and shows where the note goes. */}
        <div className="flex items-center border-b px-1.5 py-1.5">
          <SideChatPath />
        </div>
        <p className="px-3 py-2 leading-relaxed text-muted-foreground">
          Goes with your next lesson message: The learner didn&apos;t know what destructive
          interference is; explain it before building on it.
        </p>
      </div>
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        Side-chat notes included
        <span className="h-px flex-1 bg-border" />
      </div>
    </Illustration>
  );
}

type MapNodeStatus = "lesson" | "open" | "done";

function MapNode({
  label,
  status,
  current = false,
}: {
  readonly label: string;
  readonly status: MapNodeStatus;
  readonly current?: boolean;
}) {
  const Icon = status === "lesson" ? BookOpenIcon : MessageCircleIcon;
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-md border bg-card px-1.5 py-1",
        current && "border-primary ring-1 ring-primary",
        status === "lesson" && "shrink-0 font-semibold",
      )}
    >
      <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span
          className={cn(
            "absolute -right-1 -bottom-1 size-2 rounded-full border-2 border-card",
            status === "open"
              ? "bg-info"
              : status === "done"
                ? "bg-success"
                : "bg-muted-foreground/45",
          )}
        />
      </span>
      {/* A phone-width Map has no room for the word, and the icon already says lesson. */}
      <span className={cn("truncate", status === "lesson" && "@max-sm:hidden")}>{label}</span>
    </span>
  );
}

/** Children joined to their parent by a bracket: a stub into each child, a spine between them. */
function MapBranch({
  node,
  leaves = false,
  children,
}: {
  readonly node: ReactNode;
  // Short leaf labels keep their width on a narrow screen; the parent's long label truncates.
  readonly leaves?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center">
      {node}
      <span className="h-px w-3 shrink-0 bg-muted-foreground/40" />
      <div className={cn("flex flex-col", leaves ? "shrink-0" : "min-w-0")}>{children}</div>
    </div>
  );
}

function MapChild({ children }: { readonly children: ReactNode }) {
  return (
    <div className="relative flex min-w-0 items-center py-1 pl-3 before:absolute before:top-1/2 before:left-0 before:h-px before:w-3 before:bg-muted-foreground/40 after:absolute after:inset-y-0 after:left-0 after:w-px after:bg-muted-foreground/40 first:after:top-1/2 last:after:bottom-1/2">
      {children}
    </div>
  );
}

function MapMock() {
  return (
    <Illustration label="The Map: the lesson with its side chats branching to the right">
      <div className="@container">
        <MapBranch node={<MapNode label="Lesson" status="lesson" />}>
          <MapChild>
            <MapBranch
              node={<MapNode label="destructive interference" status="open" current />}
              leaves
            >
              <MapChild>
                <MapNode label="phase" status="done" />
              </MapChild>
              <MapChild>
                <MapNode label="wavelength" status="open" />
              </MapChild>
            </MapBranch>
          </MapChild>
          <MapChild>
            <MapNode label="feedforward mic" status="done" />
          </MapChild>
        </MapBranch>
      </div>
    </Illustration>
  );
}
