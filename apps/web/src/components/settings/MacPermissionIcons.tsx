import { useId } from "react";

/** System Settings style badges for the macOS privacy panes. */
export function ScreenRecordingIcon() {
  const gradientId = useId();
  return (
    <svg
      viewBox="0 0 32 32"
      className="size-8 shrink-0 drop-shadow-[0_1px_1px_#0005]"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x2="0" y2="1">
          <stop stopColor="#ff6972" />
          <stop offset="1" stopColor="#ff2938" />
        </linearGradient>
      </defs>
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="7"
        fill={`url(#${gradientId})`}
        stroke="#ffffff40"
      />
      <circle cx="16" cy="16" r="10" fill="none" stroke="#fff" strokeWidth="2" />
      <circle cx="16" cy="16" r="4.5" fill="#fff" />
    </svg>
  );
}

export function AccessibilityPermissionIcon() {
  const gradientId = useId();
  return (
    <svg
      viewBox="0 0 32 32"
      className="size-8 shrink-0 drop-shadow-[0_1px_1px_#0005]"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x2="0" y2="1">
          <stop stopColor="#48b6ff" />
          <stop offset="1" stopColor="#0085ff" />
        </linearGradient>
      </defs>
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="7"
        fill={`url(#${gradientId})`}
        stroke="#ffffff40"
      />
      <circle cx="16" cy="16" r="10" fill="none" stroke="#fff" strokeWidth="1.75" />
      <circle cx="16" cy="10" r="1.6" fill="#fff" />
      <path
        d="m10 13 6 1 6-1M16 14v4m0 0-2.5 6m2.5-6 2.5 6"
        fill="none"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
