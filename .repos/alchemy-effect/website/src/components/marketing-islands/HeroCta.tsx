import { useState } from "react";
import { AGENT_PROMPT as PROMPT } from "./agentPrompt";

export default function HeroCta() {
  return (
    <>
      <div className="hero-cta hero-cta--cards">
        <a
          className="hero-cta__card hero-cta__card--human"
          href="/getting-started"
        >
          <span className="hero-cta__eyebrow">For humans</span>
          <span className="hero-cta__title">
            Get started <span aria-hidden>→</span>
          </span>
        </a>
        <CopyCard />
      </div>
      <div className="hero-cta hero-cta--simple">
        <div className="hero-cta__buttons">
          <a className="alc-btn alc-btn--primary" href="/getting-started">
            Get started <span aria-hidden>→</span>
          </a>
          <a className="alc-btn alc-btn--secondary" href="/tutorial/part-1">
            Tutorial
          </a>
        </div>
        <div className="hero-cta__line">
          <span>
            <span aria-hidden>🤖</span> Using a coding agent?
          </span>
          <InlineCopyChip />
        </div>
      </div>
    </>
  );
}

function InlineCopyChip() {
  const [copied, setCopied] = useState(false);
  const onCopy = () => copy(PROMPT, setCopied);
  return (
    <button
      type="button"
      className="hero-cta__chip"
      onClick={onCopy}
      aria-label={copied ? "Copied" : "Copy prompt"}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span>{copied ? "Copied" : "Copy prompt"}</span>
    </button>
  );
}

function CopyCard() {
  const [copied, setCopied] = useState(false);
  const onCopy = () => copy(PROMPT, setCopied);
  return (
    <button
      type="button"
      className="hero-cta__card hero-cta__card--agent"
      onClick={onCopy}
      aria-label={
        copied ? "Copied prompt" : "Copy prompt for your coding agent"
      }
    >
      <span className="hero-cta__eyebrow">
        For coding agents
        <span className="hero-cta__icon" aria-hidden>
          {copied ? <CheckIcon /> : <CopyIcon />}
        </span>
      </span>
      <code className="hero-cta__prompt-code">{PROMPT}</code>
    </button>
  );
}

function copy(text: string, setCopied: (b: boolean) => void) {
  const finish = () => {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(finish, finish);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
  finish();
}

function CopyIcon() {
  return (
    <svg
      aria-hidden
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
