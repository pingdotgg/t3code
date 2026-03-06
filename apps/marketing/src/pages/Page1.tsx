import "./page1.css";
import { Logo } from "../Logo";

export function Page1() {
  return (
    <div className="p1">
      {/* Navbar */}
      <nav className="p1-nav">
        <a href="/" className="p1-nav-brand">
          <Logo size={28} />
          <span>Code</span>
        </a>
        <a
          href="https://github.com/t3dotgg/t3code"
          target="_blank"
          rel="noopener noreferrer"
          className="p1-nav-github"
        >
          GitHub
        </a>
      </nav>

      {/* Hero text */}
      <div className="p1-hero">
        <h1 className="p1-title">T3 Code</h1>
        <p className="p1-subtitle">The control surface for code agents.</p>
      </div>

      {/* Screenshot with glow */}
      <div className="p1-screenshot-wrap">
        <img
          className="p1-screenshot"
          src="/screenshot.jpeg"
          alt="T3 Code app screenshot"
        />
      </div>

      {/* CTA buttons */}
      <div className="p1-ctas">
        <a href="#download" className="p1-btn p1-btn-primary">
          Get the desktop alpha
        </a>
        <a
          href="https://github.com/t3dotgg/t3code"
          target="_blank"
          rel="noopener noreferrer"
          className="p1-btn p1-btn-secondary"
        >
          View on GitHub
        </a>
      </div>
    </div>
  );
}
