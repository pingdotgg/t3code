export type DemoSceneId = "ask" | "delegate" | "details" | "pending" | "phone";

export type DemoScene = {
  id: DemoSceneId;
  /** Hold before revealing this scene while playing. */
  delayMs: number;
  chromeTitle: string;
};

/** Scripted GUI journey. Fiction on purpose; nothing executes. */
export const STAGED_REMOTE_DEMO: readonly DemoScene[] = [
  { id: "ask", delayMs: 600, chromeTitle: "checkout-flake · lead" },
  { id: "delegate", delayMs: 1100, chromeTitle: "checkout-flake · lead" },
  { id: "details", delayMs: 1200, chromeTitle: "Thread Details · Work" },
  { id: "pending", delayMs: 1100, chromeTitle: "Pending request" },
  { id: "phone", delayMs: 1200, chromeTitle: "Phone · review" },
];

type StagedDemoControls = {
  play: () => void;
  replay: () => void;
  dispose: () => void;
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusDot(tone: "run" | "ok" | "wait"): HTMLElement {
  return el("span", `demo-dot demo-dot--${tone}`);
}

function specialistCard(input: {
  mark: string;
  markClass: string;
  title: string;
  detail: string;
  status: string;
  tone: "run" | "ok" | "wait";
}): HTMLElement {
  const card = el("div", "demo-card");
  const mark = el("span", `demo-mark ${input.markClass}`, input.mark);
  const body = el("div", "demo-card-body");
  const head = el("div", "demo-card-head");
  head.append(el("span", "demo-card-title", input.title), statusDot(input.tone));
  body.append(
    head,
    el("span", "demo-card-detail", input.detail),
    el("span", "demo-card-status", input.status),
  );
  card.append(mark, body, el("span", "demo-card-chevron", "›"));
  return card;
}

function renderAsk(): HTMLElement {
  const frame = el("div", "demo-gui demo-gui--thread");
  frame.append(
    el("div", "demo-thread-bar", "checkout-flake"),
    el(
      "div",
      "demo-bubble demo-bubble--you",
      "Checkout flakes on mobile Safari. Fix it while I'm on the train.",
    ),
  );
  return frame;
}

function renderDelegate(): HTMLElement {
  const frame = el("div", "demo-gui demo-gui--thread");
  frame.append(
    el("div", "demo-thread-bar", "checkout-flake"),
    el(
      "div",
      "demo-bubble demo-bubble--you",
      "Checkout flakes on mobile Safari. Fix it while I'm on the train.",
    ),
    el("div", "demo-section-label", "Delegating specialists"),
    specialistCard({
      mark: "C",
      markClass: "demo-mark--claude",
      title: "Reproduce on Safari",
      detail: "worktree · agent/claude-repro",
      status: "Running",
      tone: "run",
    }),
    specialistCard({
      mark: "X",
      markClass: "demo-mark--codex",
      title: "Patch Elements race",
      detail: "worktree · agent/codex-fix",
      status: "Running",
      tone: "run",
    }),
  );
  return frame;
}

function renderDetails(): HTMLElement {
  const frame = el("div", "demo-gui demo-gui--details");
  const panel = el("div", "demo-details");
  panel.append(el("div", "demo-details-title", "Thread Details"));

  const work = el("section", "demo-details-section");
  work.append(el("h3", "demo-details-h", "Work"));
  const list = el("ul", "demo-details-list");
  for (const row of [
    { label: "Reproduce on Safari", meta: "Claude · completed", tone: "ok" as const },
    { label: "Patch Elements race", meta: "Codex · completed", tone: "ok" as const },
  ]) {
    const item = el("li", "demo-details-row");
    item.append(
      statusDot(row.tone),
      el("span", "demo-details-label", row.label),
      el("span", "demo-details-meta", row.meta),
    );
    list.append(item);
  }
  work.append(list);

  const env = el("section", "demo-details-section");
  env.append(el("h3", "demo-details-h", "Environment and worktree"));
  env.append(el("p", "demo-details-note", "lead on laptop · 2 specialist worktrees"));

  const lineage = el("section", "demo-details-section");
  lineage.append(el("h3", "demo-details-h", "Lineage"));
  lineage.append(el("p", "demo-details-note", "lead → 2 specialists"));

  panel.append(work, env, lineage);
  frame.append(panel);
  return frame;
}

function renderPending(): HTMLElement {
  const frame = el("div", "demo-gui demo-gui--pending");
  const card = el("div", "demo-pending");
  card.append(
    el("div", "demo-pending-eyebrow", "Pending request"),
    el("div", "demo-pending-title", "File change approval"),
    el("code", "demo-pending-detail", "apps/web/src/checkout/StripeMount.tsx"),
    el("p", "demo-pending-reason", "Gate Elements until session restore settles."),
  );
  const actions = el("div", "demo-pending-actions");
  actions.append(
    el("span", "demo-pending-wait", "Waiting for approval"),
    el("span", "demo-pending-btn demo-pending-btn--ghost", "Reject"),
    el("span", "demo-pending-btn demo-pending-btn--ok", "Approve"),
  );
  card.append(actions);
  frame.append(card);
  return frame;
}

function renderPhone(): HTMLElement {
  const frame = el("div", "demo-gui demo-gui--phone");
  const phone = el("div", "demo-phone");
  phone.append(
    el("div", "demo-phone-notch"),
    el("div", "demo-phone-bar", "checkout-flake"),
    el("div", "demo-phone-chip", "Pending · Approve"),
    el("div", "demo-phone-card"),
  );
  const card = phone.querySelector(".demo-phone-card")!;
  card.append(
    el("div", "demo-phone-card-title", "Draft PR #4821"),
    el("div", "demo-phone-card-body", "Fix Safari checkout race"),
    el("div", "demo-phone-card-meta", "Ready · from phone over tailnet"),
  );
  phone.append(el("div", "demo-phone-cta", "Open pull request"));
  frame.append(phone);
  return frame;
}

function renderScene(scene: DemoScene): HTMLElement {
  switch (scene.id) {
    case "ask":
      return renderAsk();
    case "delegate":
      return renderDelegate();
    case "details":
      return renderDetails();
    case "pending":
      return renderPending();
    case "phone":
      return renderPhone();
  }
}

export function startStagedDemo({
  root,
  log,
  playButton,
  replayButton,
  status,
  chromeTitle,
  labels,
}: {
  root: HTMLElement;
  log: HTMLElement;
  playButton: HTMLButtonElement;
  replayButton: HTMLButtonElement;
  status: HTMLElement;
  chromeTitle: HTMLElement | null;
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

  const showScene = (scene: DemoScene) => {
    log.replaceChildren(renderScene(scene));
    if (chromeTitle) chromeTitle.textContent = scene.chromeTitle;
  };

  const showAll = () => {
    clearTimer();
    const last = STAGED_REMOTE_DEMO[STAGED_REMOTE_DEMO.length - 1]!;
    showScene(last);
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
    const scene = STAGED_REMOTE_DEMO[index]!;
    showScene(scene);
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
      const visible = entries.some((entry) => entry.isIntersecting);
      if (!visible && playing) {
        clearTimer();
        setBusy(false);
      }
    });
    observer.observe(root);
    events.signal.addEventListener("abort", () => observer.disconnect());
  }

  showScene(STAGED_REMOTE_DEMO[0]!);
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
