import "./page4.css";
import { Logo } from "../Logo";

export function Page4() {
  return (
    <div className="p4">
      {/* Navbar */}
      <nav className="p4-nav">
        <a href="/" className="p4-nav-left">
          <Logo size={28} />
          <span>Code</span>
        </a>
        <div className="p4-nav-right">
          <span className="p4-badge">Alpha</span>
          <a
            href="https://github.com/t3dotgg/t3code"
            target="_blank"
            rel="noopener noreferrer"
            className="p4-nav-link"
          >
            GitHub
          </a>
        </div>
      </nav>

      {/* Bento Grid */}
      <div className="p4-grid">
        {/* Screenshot — spans 2 rows */}
        <div className="p4-cell p4-screenshot">
          <img src="/screenshot.jpeg" alt="T3 Code app screenshot" />
        </div>

        {/* Feature 1 */}
        <div className="p4-cell p4-feature">
          <h3 className="p4-feature-title">
            Sessions that survive real work
          </h3>
          <p className="p4-feature-desc">
            Persistent sessions that handle restarts, reconnects, and partial
            streams without losing context.
          </p>
        </div>

        {/* Feature 2 */}
        <div className="p4-cell p4-feature">
          <h3 className="p4-feature-title">Git-native by default</h3>
          <p className="p4-feature-desc">
            Every agent session runs in its own worktree. Branches, diffs, and
            merges stay clean.
          </p>
        </div>

        {/* Hero Text */}
        <div className="p4-cell p4-hero-text">
          <h2 className="p4-hero-title">T3 Code</h2>
          <p className="p4-hero-subtitle">
            The control surface for code agents.
          </p>
          <a href="#download" className="p4-download">
            Download
          </a>
        </div>

        {/* Install Command */}
        <div className="p4-cell p4-command">
          <code className="p4-command-text">
            <span className="p4-command-prompt">$</span>
            npx t3@alpha
          </code>
        </div>

        {/* Desktop + Web */}
        <div className="p4-cell p4-desktop">
          <h3 className="p4-desktop-title">Desktop + Web</h3>
          <p className="p4-desktop-desc">
            One runtime, two surfaces. Run it as a native app or open it in the
            browser.
          </p>
        </div>

        {/* GitHub */}
        <div className="p4-cell p4-github">
          <a
            href="https://github.com/t3dotgg/t3code"
            target="_blank"
            rel="noopener noreferrer"
            className="p4-github-link"
          >
            GitHub <span className="p4-github-arrow">&rarr;</span>
          </a>
          <p className="p4-github-desc">Open source</p>
        </div>
      </div>
    </div>
  );
}
