import "./page3.css";

const features = [
  { flag: "--threads", desc: "Sessions that survive real work" },
  { flag: "--worktrees", desc: "Git-native branching by default" },
  { flag: "--recovery", desc: "Predictable through restarts" },
  { flag: "--runtime", desc: "Desktop + Web in one interface" },
] as const;

export function Page3() {
  let delay = 0;
  const nextDelay = () => `${(delay++) * 0.1}s`;

  return (
    <div className="p3">
      <div className="p3-terminal">
        <div className="p3-chrome">
          <span className="p3-dot p3-dot-red" />
          <span className="p3-dot p3-dot-yellow" />
          <span className="p3-dot p3-dot-green" />
          <span className="p3-title">{"t3code \u2014 zsh \u2014 120x40"}</span>
        </div>

        <div className="p3-body">
          {/* Command: t3code --info */}
          <div className="p3-line" style={{ animationDelay: nextDelay() }}>
            <span className="p3-prompt">$ </span>t3code --info
          </div>
          <div
            className="p3-line p3-line-blank"
            style={{ animationDelay: nextDelay() }}
          />
          <div className="p3-line" style={{ animationDelay: nextDelay() }}>
            <span className="p3-heading">T3 Code v0.0.0-alpha</span>
          </div>
          <div className="p3-line" style={{ animationDelay: nextDelay() }}>
            The control surface for code agents.
          </div>
          <div
            className="p3-line p3-line-blank"
            style={{ animationDelay: nextDelay() }}
          />

          {/* Screenshot */}
          <div className="p3-line" style={{ animationDelay: nextDelay() }}>
            <img
              className="p3-screenshot"
              src="/screenshot.jpeg"
              alt="T3 Code app screenshot"
            />
          </div>

          {/* Command: npx t3@alpha */}
          <div className="p3-line" style={{ animationDelay: nextDelay() }}>
            <span className="p3-prompt">$ </span>npx t3@alpha
          </div>
          <div className="p3-line" style={{ animationDelay: nextDelay() }}>
            Installing T3 Code...
          </div>
          <div
            className="p3-line p3-line-blank"
            style={{ animationDelay: nextDelay() }}
          />
          <div className="p3-line" style={{ animationDelay: nextDelay() }}>
            <span className="p3-label">FEATURES</span>
          </div>

          {features.map(({ flag, desc }) => (
            <div
              key={flag}
              className="p3-line"
              style={{ animationDelay: nextDelay() }}
            >
              {"  "}
              <span className="p3-flag">{flag}</span>
              {"      ".slice(0, Math.max(0, 14 - flag.length))}
              <span className="p3-desc">{desc}</span>
            </div>
          ))}

          <div
            className="p3-line p3-line-blank"
            style={{ animationDelay: nextDelay() }}
          />

          {/* Prompt with blinking cursor */}
          <div className="p3-line" style={{ animationDelay: nextDelay() }}>
            <span className="p3-prompt">$ </span>
            <span className="p3-cursor" />
          </div>
        </div>
      </div>

      {/* Links below terminal */}
      <div className="p3-links">
        <a href="#download" className="p3-link">
          Get started
        </a>
        <a
          href="https://github.com/t3dotgg/t3code"
          target="_blank"
          rel="noopener noreferrer"
          className="p3-link"
        >
          View source
        </a>
      </div>
    </div>
  );
}
