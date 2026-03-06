import "./page2.css";
import { Logo } from "../Logo";

const headlineWords = ["The", "control", "surface", "for", "code", "agents."];

const features = [
  {
    title: "Sessions that survive",
    description:
      "Persistent sessions that reconnect automatically. Pick up right where you left off, even after restarts or network drops.",
  },
  {
    title: "Git-native branching",
    description:
      "Every agent session runs on its own git branch. Review changes, merge when ready, or discard without risk.",
  },
  {
    title: "Built for operators",
    description:
      "Real-time visibility into what your agents are doing. Approve, reject, or redirect at any point in the workflow.",
  },
];

export function Page2() {
  return (
    <div className="p2">
      {/* Navbar */}
      <nav className="p2-nav">
        <div className="p2-nav-left">
          <Logo size={28} />
          <span>Code</span>
        </div>
        <div className="p2-nav-right">
          <a href="#" className="p2-nav-link">
            Docs
          </a>
          <a href="#" className="p2-nav-link">
            GitHub
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section className="p2-hero">
        <div className="p2-hero-left">
          <span className="p2-badge">Alpha</span>
          <h1 className="p2-headline">
            {headlineWords.map((word) => (
              <span key={word} className="p2-headline-word">
                {word}
              </span>
            ))}
          </h1>
          <p className="p2-description">
            A desktop interface that gives you full visibility and control over
            AI coding agents. Monitor sessions, approve changes, and ship with
            confidence.
          </p>
          <a href="#" className="p2-cta">
            Download the alpha
          </a>
        </div>
        <div className="p2-hero-right">
          <img
            src="/screenshot.jpeg"
            alt="T3 Code application screenshot"
            className="p2-screenshot"
          />
        </div>
      </section>

      {/* Divider */}
      <hr className="p2-divider" />

      {/* Feature Cards */}
      <section className="p2-features">
        {features.map((feature) => (
          <div key={feature.title} className="p2-card">
            <h3 className="p2-card-title">{feature.title}</h3>
            <p className="p2-card-desc">{feature.description}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
