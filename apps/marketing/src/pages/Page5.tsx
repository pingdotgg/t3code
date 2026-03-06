import "./page5.css";

export function Page5() {
  return (
    <div className="p5">
      {/* Navbar */}
      <nav className="p5-nav">
        <a href="/" className="p5-nav-brand">
          <img src="/icon.png" alt="T3" className="p5-nav-icon" />
        </a>
        <a
          href="https://github.com/t3dotgg/t3code"
          target="_blank"
          rel="noopener noreferrer"
          className="p5-nav-github"
        >
          GitHub{" "}
          <span className="p5-nav-github-arrow" aria-hidden="true">
            &#8599;
          </span>
        </a>
      </nav>

      {/* Content */}
      <main className="p5-main">
        <h1 className="p5-tagline">
          T3 Code is the best way to code with AI.
        </h1>

        <a
          href="https://github.com/pingdotgg/t3code/releases"
          target="_blank"
          rel="noopener noreferrer"
          className="p5-hero-button"
        >
          Download now
        </a>

        <div className="p5-screenshot-wrap">
          <img
            src="/screenshot.jpeg"
            alt="T3 Code"
            className="p5-screenshot"
          />
        </div>

        <div className="p5-cta">
          <a
            href="https://github.com/pingdotgg/t3code/releases"
            className="p5-button"
          >
            Get T3 Code
          </a>
          <p className="p5-sub">Free and open source</p>
        </div>
      </main>
    </div>
  );
}
