const featureCards = [
  {
    title: "Sessions that survive real work",
    body: "Keep threads, terminal context, and provider activity moving through reconnects, restarts, and partial streams without losing the plot.",
  },
  {
    title: "Git-native by default",
    body: "Branch and worktree flows are built into the interface, so agent experiments stop leaking into the wrong checkout.",
  },
  {
    title: "Built for operators, not demos",
    body: "Fast enough for active use, predictable under load, and shaped around long-running coding sessions instead of single prompts.",
  },
] as const;

const proofItems = [
  "Codex-first today, with Claude Code support planned next.",
  "Desktop app available now, with a browser-based runtime in the same system.",
  "Open source, early, and intentionally opinionated about performance and reliability.",
] as const;

const timeline = [
  {
    label: "Now",
    title: "Alpha desktop runtime",
    detail: "Install the current desktop build and use T3 Code as a faster control surface for Codex.",
  },
  {
    label: "Current shape",
    title: "Web GUI for agent sessions",
    detail: "Threads, terminals, diffs, and session orchestration live in one interface instead of being scattered across terminal tabs.",
  },
  {
    label: "Next",
    title: "More providers",
    detail: "The stack is being expanded beyond Codex so teams can keep one workflow as the model layer evolves.",
  },
] as const;

const commandLines = [
  "npx t3@alpha",
  "Requires Codex CLI installed and authenticated.",
] as const;

export function App() {
  return (
    <div className="page-shell">
      <div className="page-noise" />
      <header className="topbar">
        <a
          className="brand"
          href="#top"
        >
          <span className="brand-mark">T3</span>
          <span className="brand-name">Code</span>
        </a>
        <nav className="topnav">
          <a href="#why">Why</a>
          <a href="#shape">Product</a>
          <a href="#launch">Launch</a>
        </nav>
      </header>

      <main
        className="page"
        id="top"
      >
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">Launch site for t3.codes</p>
            <h1>The control surface for code agents.</h1>
            <p className="hero-body">
              T3 Code gives coding agents a serious interface: threads, terminals, worktrees, and
              recovery paths that hold up when real repository work gets messy.
            </p>
            <div className="hero-actions">
              <a
                className="button button-primary"
                href="https://github.com/pingdotgg/t3code/releases"
                target="_blank"
                rel="noreferrer"
              >
                Get the desktop alpha
              </a>
              <a
                className="button button-secondary"
                href="https://github.com/pingdotgg/t3code"
                target="_blank"
                rel="noreferrer"
              >
                View the repo
              </a>
            </div>
          </div>

          <div className="hero-panel">
            <div className="hero-panel-header">
              <span>Session shape</span>
              <span>Codex-first</span>
            </div>
            <div className="terminal-card">
              <div className="terminal-dots">
                <span />
                <span />
                <span />
              </div>
              <div className="terminal-lines">
                <p>
                  <span className="terminal-prompt">$</span> agent session booted
                </p>
                <p>thread 04 · branch feat/worktree-routing</p>
                <p>provider codex · transport app-server</p>
                <p>reconnect safe · diff ready · terminal attached</p>
              </div>
            </div>
            <div className="metrics-grid">
              <article>
                <strong>Threads</strong>
                <span>Persistent conversation flow around real coding work.</span>
              </article>
              <article>
                <strong>Worktrees</strong>
                <span>Branch isolation without manual terminal choreography.</span>
              </article>
              <article>
                <strong>Recovery</strong>
                <span>Predictable behavior through disconnects and restarts.</span>
              </article>
              <article>
                <strong>Desktop + Web</strong>
                <span>One product model across local and browser runtimes.</span>
              </article>
            </div>
          </div>
        </section>

        <section
          className="marquee-band"
          aria-label="Product summary"
        >
          <span>Minimal web GUI for coding agents</span>
          <span>Built for long-running sessions</span>
          <span>Git-native branching and worktrees</span>
          <span>Performance first. Reliability first.</span>
        </section>

        <section
          className="section-grid"
          id="why"
        >
          <div className="section-intro">
            <p className="eyebrow">Why it exists</p>
            <h2>Agents need a workspace, not a chat bubble.</h2>
            <p>
              The point of T3 Code is not to decorate model output. It is to make agent-driven
              coding usable inside real repositories, with state you can inspect, terminals you can
              trust, and branch boundaries you can keep clean.
            </p>
          </div>
          <div className="feature-grid">
            {featureCards.map((card) => (
              <article
                className="feature-card"
                key={card.title}
              >
                <h3>{card.title}</h3>
                <p>{card.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section
          className="split-panel"
          id="shape"
        >
          <div className="proof-panel">
            <p className="eyebrow">Current product shape</p>
            <h2>Codex-first, operationally focused, still early.</h2>
            <ul className="proof-list">
              {proofItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="command-panel">
            <div className="command-card">
              <p className="command-title">Quick start</p>
              {commandLines.map((line) => (
                <code key={line}>{line}</code>
              ))}
            </div>
          </div>
        </section>

        <section
          className="timeline"
          id="launch"
        >
          <div className="section-intro">
            <p className="eyebrow">Launch</p>
            <h2>Ship the site now. Keep the product story honest.</h2>
          </div>
          <div className="timeline-grid">
            {timeline.map((item) => (
              <article
                className="timeline-card"
                key={item.title}
              >
                <p className="timeline-label">{item.label}</p>
                <h3>{item.title}</h3>
                <p>{item.detail}</p>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
