export type DemoSpeaker = "you" | "lead" | "claude" | "codex" | "phone" | "system";

export type DemoLine = {
  speaker: DemoSpeaker;
  text: string;
  /** Hold before revealing this line while playing. */
  delayMs: number;
};

/** Scripted multi-agent + remote story. Fiction on purpose; nothing executes. */
export const STAGED_REMOTE_DEMO: readonly DemoLine[] = [
  {
    speaker: "you",
    text: "Checkout flakes on mobile Safari. Fix it while I'm on the train.",
    delayMs: 700,
  },
  {
    speaker: "lead",
    text: "On it. Spawning Claude to reproduce, Codex to patch: separate worktrees.",
    delayMs: 1100,
  },
  {
    speaker: "system",
    text: "worktree agent/claude-repro  ·  worktree agent/codex-fix",
    delayMs: 800,
  },
  {
    speaker: "claude",
    text: "Reproduced. Race between session restore and Stripe Elements mount.",
    delayMs: 1200,
  },
  {
    speaker: "codex",
    text: "Patch ready: gate Elements until restore settles. Tests green.",
    delayMs: 1100,
  },
  {
    speaker: "phone",
    text: "Watching both threads from the phone over the tailnet...",
    delayMs: 900,
  },
  {
    speaker: "you",
    text: "Looks right. Open the draft PR.",
    delayMs: 900,
  },
  {
    speaker: "lead",
    text: "Draft PR #4821 ready for review. Title and body generated.",
    delayMs: 1000,
  },
];

const SPEAKER_LABEL: Record<DemoSpeaker, string> = {
  you: "You",
  lead: "Lead",
  claude: "Claude",
  codex: "Codex",
  phone: "Phone",
  system: "t3",
};

export function speakerLabel(speaker: DemoSpeaker): string {
  return SPEAKER_LABEL[speaker];
}

type StagedDemoControls = {
  play: () => void;
  replay: () => void;
  dispose: () => void;
};

export function startStagedDemo({
  root,
  log,
  playButton,
  replayButton,
  status,
  labels,
}: {
  root: HTMLElement;
  log: HTMLElement;
  playButton: HTMLButtonElement;
  replayButton: HTMLButtonElement;
  status: HTMLElement;
  labels: {
    play: string;
    replay: string;
    playing: string;
    complete: string;
  };
}): StagedDemoControls {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const events = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let index = 0;
  let playing = false;
  let visible = true;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const setBusy = (next: boolean) => {
    playing = next;
    playButton.disabled = next;
    replayButton.disabled = next;
    playButton.setAttribute("aria-pressed", next ? "true" : "false");
    status.textContent = next
      ? labels.playing
      : index >= STAGED_REMOTE_DEMO.length
        ? labels.complete
        : "";
  };

  const renderLine = (line: DemoLine) => {
    const row = document.createElement("div");
    row.className = `demo-line demo-line--${line.speaker}`;
    row.setAttribute("data-speaker", line.speaker);

    const who = document.createElement("span");
    who.className = "demo-who";
    who.textContent = speakerLabel(line.speaker);

    const body = document.createElement("span");
    body.className = "demo-text";
    body.textContent = line.text;

    row.append(who, body);
    log.append(row);
    log.scrollTop = log.scrollHeight;
  };

  const showAll = () => {
    clearTimer();
    log.replaceChildren();
    for (const line of STAGED_REMOTE_DEMO) renderLine(line);
    index = STAGED_REMOTE_DEMO.length;
    setBusy(false);
    status.textContent = labels.complete;
  };

  const step = () => {
    if (!playing) return;
    if (index >= STAGED_REMOTE_DEMO.length) {
      setBusy(false);
      status.textContent = labels.complete;
      return;
    }
    const line = STAGED_REMOTE_DEMO[index]!;
    renderLine(line);
    index += 1;
    if (index >= STAGED_REMOTE_DEMO.length) {
      setBusy(false);
      status.textContent = labels.complete;
      return;
    }
    const next = STAGED_REMOTE_DEMO[index]!;
    timer = setTimeout(step, next.delayMs);
  };

  const play = () => {
    if (playing) return;
    if (reducedMotion.matches) {
      showAll();
      return;
    }
    if (index >= STAGED_REMOTE_DEMO.length) {
      log.replaceChildren();
      index = 0;
    }
    if (index === 0) log.replaceChildren();
    setBusy(true);
    const first = STAGED_REMOTE_DEMO[index];
    timer = setTimeout(step, first?.delayMs ?? 0);
  };

  const replay = () => {
    clearTimer();
    playing = false;
    index = 0;
    log.replaceChildren();
    status.textContent = "";
    playButton.disabled = false;
    replayButton.disabled = false;
    playButton.setAttribute("aria-pressed", "false");
    play();
  };

  playButton.textContent = labels.play;
  replayButton.textContent = labels.replay;
  playButton.addEventListener("click", play, { signal: events.signal });
  replayButton.addEventListener("click", replay, { signal: events.signal });

  if (typeof IntersectionObserver !== "undefined") {
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      if (!visible && playing) {
        clearTimer();
        setBusy(false);
      }
    });
    observer.observe(root);
    events.signal.addEventListener("abort", () => observer.disconnect());
  }

  // Idle state: first line only, so the frame is never an empty void.
  renderLine(STAGED_REMOTE_DEMO[0]!);
  index = 1;

  return {
    play,
    replay,
    dispose: () => {
      clearTimer();
      events.abort();
    },
  };
}
