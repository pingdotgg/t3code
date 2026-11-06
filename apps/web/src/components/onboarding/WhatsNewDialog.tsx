import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useNavigate } from "@tanstack/react-router";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { openCommandPalette } from "~/commandPaletteBus";
import {
  openWelcomeGuide,
  sideChatsAvailableAtom,
  WELCOME_GUIDE_SEEN_STORAGE_KEY,
} from "./WelcomeGuideDialog";
import { environmentPresentations } from "~/state/presentation";
import { resolveWhatsNewGuides, type WhatsNewGuide } from "./whatsNewGuides";
import { useClientSettings } from "~/hooks/useSettings";
import { Button } from "../ui/button";
import { Dialog, DialogDescription } from "../ui/dialog";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../ui/wizard";

const WHATS_NEW_SEEN_STORAGE_KEY = "t3learn:whats-new-seen:v1";
const WhatsNewSeenSchema = Schema.NullOr(Schema.Array(Schema.String));
const nullableStringSchema = Schema.NullOr(Schema.String);
// Pinned to v1: the welcome key can be bumped, but only installs from before What's new have this one.
const LEGACY_WELCOME_GUIDE_SEEN_STORAGE_KEY = "t3learn:welcome-guide-seen:v1";
const useWhatsNewRequest = create<{ requested: boolean }>(() => ({ requested: false }));

export function openWhatsNew() {
  useWhatsNewRequest.setState({ requested: true });
}

if (typeof window !== "undefined") {
  window.desktopBridge?.onMenuAction((action) => {
    if (action === "open-whats-new") openWhatsNew();
  });
}

export function WhatsNewHost({ hostedStatic }: { readonly hostedStatic: boolean }) {
  const requested = useWhatsNewRequest((state) => state.requested);
  const [seen, setSeen] = useLocalStorage(WHATS_NEW_SEEN_STORAGE_KEY, null, WhatsNewSeenSchema);
  const [welcomeSeenAt] = useLocalStorage(
    WELCOME_GUIDE_SEEN_STORAGE_KEY,
    null,
    nullableStringSchema,
  );
  const [legacyWelcomeSeenAt] = useLocalStorage(
    LEGACY_WELCOME_GUIDE_SEEN_STORAGE_KEY,
    null,
    nullableStringSchema,
  );
  const setupDone = useClientSettings((settings) => settings.onboardingCompletedAt !== null);
  const sideChatsAvailable = useAtomValue(sideChatsAvailableAtom);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const chatSyncAvailable = [...presentations.values()].some(
    (presentation) =>
      presentation.connection.phase === "connected" &&
      presentation.serverConfig?.environment.capabilities.chatSync === true,
  );
  const [dismissed, setDismissed] = useState(false);
  const resolved = resolveWhatsNewGuides({
    seen,
    existingInstall: legacyWelcomeSeenAt !== null,
    chatSyncAvailable,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- seed the guide record once for new installs.
  useEffect(() => {
    if (seen === null && resolved.seed !== null) {
      // Seed new installs so the welcome tour remains their only first-run introduction.
      setSeen(resolved.seed.slice());
    }
  }, [resolved.seed, seen, setSeen]);

  const autoOpen =
    !requested &&
    !dismissed &&
    resolved.guides.length > 0 &&
    welcomeSeenAt !== null &&
    (hostedStatic || setupDone) &&
    sideChatsAvailable;
  const guides = requested
    ? resolveWhatsNewGuides({ seen: [], existingInstall: true, chatSyncAvailable }).guides
    : resolved.guides;
  if (!requested && !autoOpen) return null;
  if (guides.length === 0) return null;

  const close = () => {
    useWhatsNewRequest.setState({ requested: false });
    setDismissed(true);
    setSeen((current) => [...new Set([...(current ?? []), ...guides.map((guide) => guide.id)])]);
  };
  return <WhatsNewDialog guides={guides} onClose={close} />;
}

function WhatsNewDialog({
  guides,
  onClose,
}: {
  readonly guides: readonly WhatsNewGuide[];
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const nextRef = useRef<HTMLButtonElement>(null);
  // The chat-sync guide can drop out while open (its environment disconnects).
  const index = Math.min(step, guides.length - 1);
  const last = index === guides.length - 1;
  const guide = guides[index]!;

  const runAction = () => {
    onClose();
    queueMicrotask(() => {
      switch (guide.action) {
        case "new-lesson":
        case "quiz-cards": {
          const button = document.querySelector<HTMLButtonElement>('[aria-label="New lesson"]');
          if (button) button.click();
          else openCommandPalette({ query: "New lesson" });
          break;
        }
        case "side-chats":
          openWelcomeGuide();
          break;
        case "what-you-know":
          void navigate({ to: "/settings/threads", hash: "knowledge-map" });
          break;
        case "courses":
          void navigate({ to: "/settings/threads", hash: "courses" });
          break;
        case "chat-sync":
          void navigate({ to: "/settings/threads", hash: "chat-sync" });
          break;
      }
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <WizardPopup size="wide" initialFocus={nextRef}>
        <WizardHeader
          title="What's new"
          identity={<span className="text-2xl font-medium tracking-tight">OminaX</span>}
        >
          <WizardSteps
            label="What's new progress"
            steps={guides.map((item) => item.title)}
            currentStep={index}
            onStepChange={setStep}
          />
        </WizardHeader>
        <WizardPanel>
          <GuideClip key={guide.id} guide={guide} reducedMotion={reducedMotion} />
          <DialogDescription render={<div />} aria-live="polite">
            <h3 className="text-lg font-semibold tracking-tight text-foreground">{guide.title}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{guide.benefit}</p>
          </DialogDescription>
        </WizardPanel>
        <WizardFooter
          leading={
            <Button variant="ghost" onClick={onClose}>
              Skip
            </Button>
          }
        >
          <Button
            variant="outline"
            className={index === 0 ? "invisible" : undefined}
            onClick={() => setStep(index - 1)}
          >
            Back
          </Button>
          <Button onClick={runAction}>{guide.actionLabel}</Button>
          <Button
            ref={nextRef}
            variant="outline"
            onClick={last ? onClose : () => setStep(index + 1)}
          >
            {last ? "Done" : "Next"}
          </Button>
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}

function GuideClip({
  guide,
  reducedMotion,
}: {
  readonly guide: WhatsNewGuide;
  readonly reducedMotion: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  return (
    <div className="relative aspect-[16/10] overflow-hidden rounded-lg bg-muted">
      <video
        ref={videoRef}
        muted
        loop
        playsInline
        autoPlay={!reducedMotion}
        poster={`/whats-new/${guide.id}.jpg`}
        aria-label={`${guide.title} preview`}
        className="size-full object-cover"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      >
        <source src={`/whats-new/${guide.id}.webm`} type="video/webm" />
        <source src={`/whats-new/${guide.id}.mp4`} type="video/mp4" />
      </video>
      {reducedMotion && !playing ? (
        <div className="absolute inset-0 grid place-items-center">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => void videoRef.current?.play()}
          >
            Play preview
          </Button>
        </div>
      ) : null}
    </div>
  );
}
