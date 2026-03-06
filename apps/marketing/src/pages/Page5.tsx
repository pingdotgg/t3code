import "./page5.css";
import { Logo } from "../Logo";

export function Page5() {
  return (
    <div className="p5">
      {/* Navbar */}
      <nav className="p5-nav">
        <a href="/" className="p5-nav-brand">
          <Logo size={26} />
          <span>Code</span>
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
          One interface.
          <br />
          Every agent.
        </h1>

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
