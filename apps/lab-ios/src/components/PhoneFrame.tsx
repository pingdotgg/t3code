import type { ReactNode } from "react";
import "./PhoneFrame.css";

export const PHONE_WIDTH = 393;
export const PHONE_HEIGHT = 852;

function StatusBar() {
  return (
    <div className="m-statusbar">
      <span className="m-statusbar-time">9:41</span>
      <span className="m-island" />
      <span className="m-statusbar-icons">
        <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor" aria-hidden>
          <rect x="0" y="8" width="3" height="4" rx="1" />
          <rect x="5" y="5.5" width="3" height="6.5" rx="1" />
          <rect x="10" y="3" width="3" height="9" rx="1" />
          <rect x="15" y="0" width="3" height="12" rx="1" />
        </svg>
        <svg width="17" height="12" viewBox="0 0 17 12" fill="currentColor" aria-hidden>
          <path d="M8.5 2.4c2.3 0 4.4.9 6 2.4l1-1.1A10.6 10.6 0 0 0 8.5.9C5.7.9 3.2 2 1.4 3.7l1 1.1a8.9 8.9 0 0 1 6.1-2.4Zm0 3.6c1.4 0 2.7.5 3.7 1.4l1-1.1A7.7 7.7 0 0 0 8.5 4.5c-1.9 0-3.700.7-5 1.800l1 1.100c1-.8 2.600-1.400 4-1.400Zm0 3.500a2 2 0 0 0-1.300.5L8.500 12l1.300-2a2 2 0 0 0-1.300-.5Z" />
        </svg>
        <svg width="27" height="13" viewBox="0 0 27 13" aria-hidden>
          <rect
            x="0.5"
            y="0.5"
            width="23"
            height="12"
            rx="3.800"
            fill="none"
            stroke="currentColor"
            opacity="0.4"
          />
          <rect x="2" y="2" width="20" height="9" rx="2.500" fill="currentColor" />
          <path
            d="M25 4.500v4c.800-.3 1.500-1.100 1.500-2s-.7-1.700-1.500-2Z"
            fill="currentColor"
            opacity="0.5"
          />
        </svg>
      </span>
    </div>
  );
}

/** A 393×852pt iPhone: rounded screen, status bar, home indicator. `theme` picks the token set. */
export function PhoneFrame(props: {
  readonly theme: "dark-mono" | "light";
  readonly scale: number;
  readonly children: ReactNode;
}) {
  return (
    <div
      className="m-frame-slot"
      style={{ width: PHONE_WIDTH * props.scale, height: PHONE_HEIGHT * props.scale }}
    >
      <div
        className="m-phone"
        data-mobile-theme={props.theme}
        data-testid={`phone-${props.theme}`}
        style={{ width: PHONE_WIDTH, height: PHONE_HEIGHT, transform: `scale(${props.scale})` }}
      >
        <div className="m-screen">{props.children}</div>
        <StatusBar />
        <span className="m-home-indicator" />
      </div>
    </div>
  );
}
