"use client";

import s from "./icon-transitions.module.scss";

// =============================================================================
// Icons
// =============================================================================

// Small X for marker delete
export const IconClose = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

// Plus icon
export const IconPlus = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

// Checkmark icon
export const IconCheck = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <path
      d="M3 8l3.5 3.5L13 5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// Checkbox checkmark (smaller, optimized for checkboxes)
export const IconCheckSmall = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
    <path
      d="M3.9375 7L6.125 9.1875L10.5 4.8125"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// List with sparkle icon
export const IconListSparkle = ({
  size = 24,
  style = {},
}: {
  size?: number;
  style?: React.CSSProperties;
}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
    <g clipPath="url(#clip0_list_sparkle)">
      <path
        d="M11.5 12L5.5 12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M18.5 6.75L5.5 6.75"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.25 17.25L5.5 17.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16 12.75L16.5179 13.9677C16.8078 14.6494 17.3506 15.1922 18.0323 15.4821L19.25 16L18.0323 16.5179C17.3506 16.8078 16.8078 17.3506 16.5179 18.0323L16 19.25L15.4821 18.0323C15.1922 17.3506 14.6494 16.8078 13.9677 16.5179L12.75 16L13.9677 15.4821C14.6494 15.1922 15.1922 14.6494 15.4821 13.9677L16 12.75Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </g>
    <defs>
      <clipPath id="clip0_list_sparkle">
        <rect width="24" height="24" fill="white" />
      </clipPath>
    </defs>
  </svg>
);

// Help/Question mark icon for tooltips
export const IconHelp = ({
  size = 20,
  ...props
}: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 20 20"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <circle cx="10" cy="10" r="5.375" stroke="currentColor" strokeWidth="1.25" />
    <path
      d="M8.5 8.5C8.73 7.85 9.31 7.49 10 7.5C10.86 7.51 11.5 8.13 11.5 9C11.5 10.08 10 10.5 10 10.5V10.75"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="10" cy="12.625" r="0.625" fill="currentColor" />
  </svg>
);

// Animated checkmark with draw + bounce effect
export const IconCheckSmallAnimated = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
    <style>{`
      @keyframes checkDraw {
        0% {
          stroke-dashoffset: 12;
        }
        100% {
          stroke-dashoffset: 0;
        }
      }
      @keyframes checkBounce {
        0% {
          transform: scale(0.5);
          opacity: 0;
        }
        50% {
          transform: scale(1.12);
          opacity: 1;
        }
        75% {
          transform: scale(0.95);
        }
        100% {
          transform: scale(1);
        }
      }
      .check-path-animated {
        stroke-dasharray: 12;
        stroke-dashoffset: 0;
        transform-origin: center;
        animation: checkDraw 0.18s ease-out, checkBounce 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      }
    `}</style>
    <path
      className="check-path-animated"
      d="M3.9375 7L6.125 9.1875L10.5 4.8125"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// =============================================================================
// New Icons from SVG files
// =============================================================================

// Copy icon (two overlapping rectangles)
export const IconCopyAlt = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path
      d="M4.75 11.25C4.75 10.4216 5.42157 9.75 6.25 9.75H12.75C13.5784 9.75 14.25 10.4216 14.25 11.25V17.75C14.25 18.5784 13.5784 19.25 12.75 19.25H6.25C5.42157 19.25 4.75 18.5784 4.75 17.75V11.25Z"
      stroke="currentColor"
      strokeWidth="1.5"
    />
    <path
      d="M17.25 14.25H17.75C18.5784 14.25 19.25 13.5784 19.25 12.75V6.25C19.25 5.42157 18.5784 4.75 17.75 4.75H11.25C10.4216 4.75 9.75 5.42157 9.75 6.25V6.75"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

// Animated copy/checkmark icon
export const IconCopyAnimated = ({
  size = 24,
  copied = false,
  tint,
}: {
  size?: number;
  copied?: boolean;
  tint?: string;
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    style={tint ? { color: tint, transition: "color 0.3s ease" } : undefined}
  >
    {/* Copy icon */}
    <g className={`${s.iconState} ${copied ? s.hiddenScaled : s.visibleScaled}`}>
      <path
        d="M4.75 11.25C4.75 10.4216 5.42157 9.75 6.25 9.75H12.75C13.5784 9.75 14.25 10.4216 14.25 11.25V17.75C14.25 18.5784 13.5784 19.25 12.75 19.25H6.25C5.42157 19.25 4.75 18.5784 4.75 17.75V11.25Z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M17.25 14.25H17.75C18.5784 14.25 19.25 13.5784 19.25 12.75V6.25C19.25 5.42157 18.5784 4.75 17.75 4.75H11.25C10.4216 4.75 9.75 5.42157 9.75 6.25V6.75"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </g>
    {/* Checkmark circle */}
    <g className={`${s.iconState} ${copied ? s.visibleScaled : s.hiddenScaled}`}>
      <path
        d="M12 20C7.58172 20 4 16.4182 4 12C4 7.58172 7.58172 4 12 4C16.4182 4 20 7.58172 20 12C20 16.4182 16.4182 20 12 20Z"
        stroke="var(--preview-feedback-color-green)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15 10L11 14.25L9.25 12.25"
        stroke="var(--preview-feedback-color-green)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  </svg>
);

// Animated send arrow icon (paper plane style with checkmark/error transition)
export const IconSendArrow = ({
  size = 24,
  state = "idle",
}: {
  size?: number;
  state?: "idle" | "sending" | "sent" | "failed";
}) => {
  const showArrow = state === "idle";
  const showCheck = state === "sent";
  const showError = state === "failed";
  const isSending = state === "sending";

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Send arrow */}
      <g
        className={`${s.iconStateFast} ${showArrow ? s.visibleScaled : isSending ? s.sending : s.hiddenScaled}`}
      >
        <path
          d="M9.875 14.125L12.3506 19.6951C12.7184 20.5227 13.9091 20.4741 14.2083 19.6193L18.8139 6.46032C19.0907 5.6695 18.3305 4.90933 17.5397 5.18611L4.38072 9.79174C3.52589 10.0909 3.47731 11.2816 4.30494 11.6494L9.875 14.125ZM9.875 14.125L13.375 10.625"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      {/* Green checkmark circle */}
      <g className={`${s.iconStateFast} ${showCheck ? s.visibleScaled : s.hiddenScaled}`}>
        <path
          d="M12 20C7.58172 20 4 16.4182 4 12C4 7.58172 7.58172 4 12 4C16.4182 4 20 7.58172 20 12C20 16.4182 16.4182 20 12 20Z"
          stroke="var(--preview-feedback-color-green)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M15 10L11 14.25L9.25 12.25"
          stroke="var(--preview-feedback-color-green)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      {/* Red error circle with exclamation */}
      <g className={`${s.iconStateFast} ${showError ? s.visibleScaled : s.hiddenScaled}`}>
        <path
          d="M12 20C7.58172 20 4 16.4182 4 12C4 7.58172 7.58172 4 12 4C16.4182 4 20 7.58172 20 12C20 16.4182 16.4182 20 12 20Z"
          stroke="var(--preview-feedback-color-red)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M12 8V12"
          stroke="var(--preview-feedback-color-red)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <circle
          cx="12"
          cy="15"
          r="0.5"
          fill="var(--preview-feedback-color-red)"
          stroke="var(--preview-feedback-color-red)"
          strokeWidth="1"
        />
      </g>
    </svg>
  );
};

// Animated send/checkmark icon (for "Send to Agent" button)
export const IconSendAnimated = ({
  size = 24,
  sent = false,
}: {
  size?: number;
  sent?: boolean;
}) => (
  <svg width={size} height={size} viewBox="0 0 22 21" fill="none">
    {/* Send icon (document with arrow) */}
    <g className={`${s.iconState} ${sent ? s.hiddenScaled : s.visibleScaled}`}>
      <path
        d="M9.5 5H6.5C4.84315 5 3.5 6.34315 3.5 8V15C3.5 16.6569 4.84315 18 6.5 18H13.5C15.1569 18 16.5 16.6569 16.5 15V12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M13.5 8.5L18.5 3.5M18.5 3.5L14.4524 3.5M18.5 3.5L18.5 7.54762"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M7.5 13.75H12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M7.5 10.75H10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </g>
    {/* Checkmark circle (success state) */}
    <g className={`${s.iconState} ${sent ? s.visibleScaled : s.hiddenScaled}`}>
      <path
        d="M11 19C6.58172 19 3 15.4182 3 11C3 6.58172 6.58172 3 11 3C15.4182 3 19 6.58172 19 11C19 15.4182 15.4182 19 11 19Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 9L10 13.25L8.25 11.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  </svg>
);

// Eye icon (original)
export const IconEye = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path
      d="M4.91516 12.7108C4.63794 12.2883 4.63705 11.7565 4.91242 11.3328C5.84146 9.9033 8.30909 6.74994 12 6.74994C15.6909 6.74994 18.1585 9.9033 19.0876 11.3328C19.3629 11.7565 19.3621 12.2883 19.0848 12.7108C18.1537 14.13 15.6873 17.2499 12 17.2499C8.31272 17.2499 5.8463 14.13 4.91516 12.7108Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M12 14.25C13.2426 14.25 14.25 13.2426 14.25 12C14.25 10.7574 13.2426 9.75 12 9.75C10.7574 9.75 9.75 10.7574 9.75 12C9.75 13.2426 10.7574 14.25 12 14.25Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// Eye icon (alt version - larger pupil)
export const IconEyeAlt = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path
      d="M3.91752 12.7539C3.65127 12.2996 3.65037 11.7515 3.9149 11.2962C4.9042 9.59346 7.72688 5.49994 12 5.49994C16.2731 5.49994 19.0958 9.59346 20.0851 11.2962C20.3496 11.7515 20.3487 12.2996 20.0825 12.7539C19.0908 14.4459 16.2694 18.4999 12 18.4999C7.73064 18.4999 4.90918 14.4459 3.91752 12.7539Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M12 14.8261C13.5608 14.8261 14.8261 13.5608 14.8261 12C14.8261 10.4392 13.5608 9.17392 12 9.17392C10.4392 9.17392 9.17391 10.4392 9.17391 12C9.17391 13.5608 10.4392 14.8261 12 14.8261Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// Eye closed (with slash)
export const IconEyeClosed = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path
      d="M18.6025 9.28503C18.9174 8.9701 19.4364 8.99481 19.7015 9.35271C20.1484 9.95606 20.4943 10.507 20.7342 10.9199C21.134 11.6086 21.1329 12.4454 20.7303 13.1328C20.2144 14.013 19.2151 15.5225 17.7723 16.8193C16.3293 18.1162 14.3852 19.2497 12.0008 19.25C11.4192 19.25 10.8638 19.1823 10.3355 19.0613C9.77966 18.934 9.63498 18.2525 10.0382 17.8493C10.2412 17.6463 10.5374 17.573 10.8188 17.6302C11.1993 17.7076 11.5935 17.75 12.0008 17.75C13.8848 17.7497 15.4867 16.8568 16.7693 15.7041C18.0522 14.5511 18.9606 13.1867 19.4363 12.375C19.5656 12.1543 19.5659 11.8943 19.4373 11.6729C19.2235 11.3049 18.921 10.8242 18.5364 10.3003C18.3085 9.98991 18.3302 9.5573 18.6025 9.28503ZM12.0008 4.75C12.5814 4.75006 13.1358 4.81803 13.6632 4.93953C14.2182 5.06741 14.362 5.74812 13.9593 6.15091C13.7558 6.35435 13.4589 6.42748 13.1771 6.36984C12.7983 6.29239 12.4061 6.25006 12.0008 6.25C10.1167 6.25 8.51415 7.15145 7.23028 8.31543C5.94678 9.47919 5.03918 10.8555 4.56426 11.6729C4.43551 11.8945 4.43582 12.1542 4.56524 12.375C4.77587 12.7343 5.07189 13.2012 5.44718 13.7105C5.67623 14.0213 5.65493 14.4552 5.38193 14.7282C5.0671 15.0431 4.54833 15.0189 4.28292 14.6614C3.84652 14.0736 3.50813 13.5369 3.27129 13.1328C2.86831 12.4451 2.86717 11.6088 3.26739 10.9199C3.78185 10.0345 4.77959 8.51239 6.22247 7.2041C7.66547 5.89584 9.61202 4.75 12.0008 4.75Z"
      fill="currentColor"
    />
    <path d="M5 19L19 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

// Animated eye icon that transitions between open/closed states
export const IconEyeAnimated = ({
  size = 24,
  isOpen = true,
}: {
  size?: number;
  isOpen?: boolean;
}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    {/* Open state - full outline + pupil */}
    <g className={`${s.iconFade} ${isOpen ? s.visible : s.hidden}`}>
      <path
        d="M3.91752 12.7539C3.65127 12.2996 3.65037 11.7515 3.9149 11.2962C4.9042 9.59346 7.72688 5.49994 12 5.49994C16.2731 5.49994 19.0958 9.59346 20.0851 11.2962C20.3496 11.7515 20.3487 12.2996 20.0825 12.7539C19.0908 14.4459 16.2694 18.4999 12 18.4999C7.73064 18.4999 4.90918 14.4459 3.91752 12.7539Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 14.8261C13.5608 14.8261 14.8261 13.5608 14.8261 12C14.8261 10.4392 13.5608 9.17392 12 9.17392C10.4392 9.17392 9.17391 10.4392 9.17391 12C9.17391 13.5608 10.4392 14.8261 12 14.8261Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
    {/* Closed state - split outline + slash */}
    <g className={`${s.iconFade} ${isOpen ? s.hidden : s.visible}`}>
      <path
        d="M18.6025 9.28503C18.9174 8.9701 19.4364 8.99481 19.7015 9.35271C20.1484 9.95606 20.4943 10.507 20.7342 10.9199C21.134 11.6086 21.1329 12.4454 20.7303 13.1328C20.2144 14.013 19.2151 15.5225 17.7723 16.8193C16.3293 18.1162 14.3852 19.2497 12.0008 19.25C11.4192 19.25 10.8638 19.1823 10.3355 19.0613C9.77966 18.934 9.63498 18.2525 10.0382 17.8493C10.2412 17.6463 10.5374 17.573 10.8188 17.6302C11.1993 17.7076 11.5935 17.75 12.0008 17.75C13.8848 17.7497 15.4867 16.8568 16.7693 15.7041C18.0522 14.5511 18.9606 13.1867 19.4363 12.375C19.5656 12.1543 19.5659 11.8943 19.4373 11.6729C19.2235 11.3049 18.921 10.8242 18.5364 10.3003C18.3085 9.98991 18.3302 9.5573 18.6025 9.28503ZM12.0008 4.75C12.5814 4.75006 13.1358 4.81803 13.6632 4.93953C14.2182 5.06741 14.362 5.74812 13.9593 6.15091C13.7558 6.35435 13.4589 6.42748 13.1771 6.36984C12.7983 6.29239 12.4061 6.25006 12.0008 6.25C10.1167 6.25 8.51415 7.15145 7.23028 8.31543C5.94678 9.47919 5.03918 10.8555 4.56426 11.6729C4.43551 11.8945 4.43582 12.1542 4.56524 12.375C4.77587 12.7343 5.07189 13.2012 5.44718 13.7105C5.67623 14.0213 5.65493 14.4552 5.38193 14.7282C5.0671 15.0431 4.54833 15.0189 4.28292 14.6614C3.84652 14.0736 3.50813 13.5369 3.27129 13.1328C2.86831 12.4451 2.86717 11.6088 3.26739 10.9199C3.78185 10.0345 4.77959 8.51239 6.22247 7.2041C7.66547 5.89584 9.61202 4.75 12.0008 4.75Z"
        fill="currentColor"
      />
      <path d="M5 19L19 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </g>
  </svg>
);

// Animated pause/play icon that transitions between states
export const IconPausePlayAnimated = ({
  size = 24,
  isPaused = false,
}: {
  size?: number;
  isPaused?: boolean;
}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    {/* Pause bars - visible when not paused */}
    <g className={`${s.iconFadeFast} ${isPaused ? s.hidden : s.visible}`}>
      <path d="M8 6L8 18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M16 18L16 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </g>
    {/* Play triangle - visible when paused */}
    <path
      className={`${s.iconFadeFast} ${isPaused ? s.visible : s.hidden}`}
      d="M17.75 10.701C18.75 11.2783 18.75 12.7217 17.75 13.299L8.75 18.4952C7.75 19.0725 6.5 18.3509 6.5 17.1962L6.5 6.80384C6.5 5.64914 7.75 4.92746 8.75 5.50481L17.75 10.701Z"
      stroke="currentColor"
      strokeWidth="1.5"
    />
  </svg>
);

// Eye with minus (hidden/collapsed state)
export const IconEyeMinus = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path
      d="M4.91516 12.7108C4.63794 12.2883 4.63705 11.7565 4.91242 11.3328C5.84146 9.9033 8.30909 6.74994 12 6.74994C15.6909 6.74994 18.1585 9.9033 19.0876 11.3328C19.3629 11.7565 19.3621 12.2883 19.0848 12.7108C18.1537 14.13 15.6873 17.2499 12 17.2499C8.31272 17.2499 5.8463 14.13 4.91516 12.7108Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path d="M9 12H15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

// Gear icon
export const IconGear = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path
      d="M10.6504 5.81117C10.9939 4.39628 13.0061 4.39628 13.3496 5.81117C13.5715 6.72517 14.6187 7.15891 15.4219 6.66952C16.6652 5.91193 18.0881 7.33479 17.3305 8.57815C16.8411 9.38134 17.2748 10.4285 18.1888 10.6504C19.6037 10.9939 19.6037 13.0061 18.1888 13.3496C17.2748 13.5715 16.8411 14.6187 17.3305 15.4219C18.0881 16.6652 16.6652 18.0881 15.4219 17.3305C14.6187 16.8411 13.5715 17.2748 13.3496 18.1888C13.0061 19.6037 10.9939 19.6037 10.6504 18.1888C10.4285 17.2748 9.38135 16.8411 8.57815 17.3305C7.33479 18.0881 5.91193 16.6652 6.66952 15.4219C7.15891 14.6187 6.72517 13.5715 5.81117 13.3496C4.39628 13.0061 4.39628 10.9939 5.81117 10.6504C6.72517 10.4285 7.15891 9.38134 6.66952 8.57815C5.91193 7.33479 7.33479 5.91192 8.57815 6.66952C9.38135 7.15891 10.4285 6.72517 10.6504 5.81117Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

// Pause icon (two vertical bars - original)
export const IconPauseAlt = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path
      d="M9.25 5.75C9.80228 5.75 10.25 6.19772 10.25 6.75L10.25 17.25C10.25 17.8023 9.80228 18.25 9.25 18.25L6.75 18.25C6.19772 18.25 5.75 17.8023 5.75 17.25L5.75 6.75C5.75 6.19772 6.19772 5.75 6.75 5.75L9.25 5.75Z"
      stroke="currentColor"
      strokeWidth="1.5"
    />
    <path
      d="M17.25 5.75C17.8023 5.75 18.25 6.19772 18.25 6.75L18.25 17.25C18.25 17.8023 17.8023 18.25 17.25 18.25L14.75 18.25C14.1977 18.25 13.75 17.8023 13.75 17.25L13.75 6.75C13.75 6.19772 14.1977 5.75 14.75 5.75L17.25 5.75Z"
      stroke="currentColor"
      strokeWidth="1.5"
    />
  </svg>
);

// Pause icon (simple lines)
export const IconPause = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M8 6L8 18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M16 18L16 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

// Play icon (triangle pointing right)
export const IconPlayAlt = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path
      d="M17.75 10.701C18.75 11.2783 18.75 12.7217 17.75 13.299L8.75 18.4952C7.75 19.0725 6.5 18.3509 6.5 17.1962L6.5 6.80384C6.5 5.64914 7.75 4.92746 8.75 5.50481L17.75 10.701Z"
      stroke="currentColor"
      strokeWidth="1.5"
    />
  </svg>
);

// Trash can icon (filled)
export const IconTrashAlt = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path
      d="M13.5 4C14.7426 4 15.75 5.00736 15.75 6.25V7H18.5C18.9142 7 19.25 7.33579 19.25 7.75C19.25 8.16421 18.9142 8.5 18.5 8.5H17.9678L17.6328 16.2217C17.61 16.7475 17.5912 17.1861 17.5469 17.543C17.5015 17.9087 17.4225 18.2506 17.2461 18.5723C16.9747 19.0671 16.5579 19.4671 16.0518 19.7168C15.7227 19.8791 15.3772 19.9422 15.0098 19.9717C14.6514 20.0004 14.2126 20 13.6865 20H10.3135C9.78735 20 9.34856 20.0004 8.99023 19.9717C8.62278 19.9422 8.27729 19.8791 7.94824 19.7168C7.44205 19.4671 7.02532 19.0671 6.75391 18.5723C6.57751 18.2506 6.49853 17.9087 6.45312 17.543C6.40883 17.1861 6.39005 16.7475 6.36719 16.2217L6.03223 8.5H5.5C5.08579 8.5 4.75 8.16421 4.75 7.75C4.75 7.33579 5.08579 7 5.5 7H8.25V6.25C8.25 5.00736 9.25736 4 10.5 4H13.5ZM7.86621 16.1562C7.89013 16.7063 7.90624 17.0751 7.94141 17.3584C7.97545 17.6326 8.02151 17.7644 8.06934 17.8516C8.19271 18.0763 8.38239 18.2577 8.6123 18.3711C8.70153 18.4151 8.83504 18.4545 9.11035 18.4766C9.39482 18.4994 9.76335 18.5 10.3135 18.5H13.6865C14.2367 18.5 14.6052 18.4994 14.8896 18.4766C15.165 18.4545 15.2985 18.4151 15.3877 18.3711C15.6176 18.2577 15.8073 18.0763 15.9307 17.8516C15.9785 17.7644 16.0245 17.6326 16.0586 17.3584C16.0938 17.0751 16.1099 16.7063 16.1338 16.1562L16.4668 8.5H7.5332L7.86621 16.1562ZM9.97656 10.75C10.3906 10.7371 10.7371 11.0626 10.75 11.4766L10.875 15.4766C10.8879 15.8906 10.5624 16.2371 10.1484 16.25C9.73443 16.2629 9.38794 15.9374 9.375 15.5234L9.25 11.5234C9.23706 11.1094 9.56255 10.7629 9.97656 10.75ZM14.0244 10.75C14.4384 10.7635 14.7635 11.1105 14.75 11.5244L14.6201 15.5244C14.6066 15.9384 14.2596 16.2634 13.8457 16.25C13.4317 16.2365 13.1067 15.8896 13.1201 15.4756L13.251 11.4756C13.2645 11.0617 13.6105 10.7366 14.0244 10.75ZM10.5 5.5C10.0858 5.5 9.75 5.83579 9.75 6.25V7H14.25V6.25C14.25 5.83579 13.9142 5.5 13.5 5.5H10.5Z"
      fill="currentColor"
    />
  </svg>
);

// Forma sidebar archive icon
export const IconSidebarArchive = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} fill="currentColor" viewBox="0 0 16 16">
    <path
      clipRule="evenodd"
      d="m2 3 1.652 9.911A2.5 2.5 0 0 0 6.118 15h3.764a2.5 2.5 0 0 0 2.466-2.089L14 3H2Zm1.77 1.5 1.361 8.164a1 1 0 0 0 .987.836h3.764a1 1 0 0 0 .987-.836l1.36-8.164H3.771Z"
      fillRule="evenodd"
    />
    <path d="M5.5 2.5A1.5 1.5 0 0 1 7 1h2a1.5 1.5 0 0 1 1.5 1.5v1h-5v-1Z" />
    <path d="M1 3.75A.75.75 0 0 1 1.75 3h12.5a.75.75 0 0 1 0 1.5H1.75A.75.75 0 0 1 1 3.75Z" />
  </svg>
);

// Chat bubble with ellipsis
export const IconChatEllipsis = ({
  size = 16,
  style = {},
}: {
  size?: number;
  style?: React.CSSProperties;
}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
    <path
      d="M18.8875 19.25L19.6112 19.0533C19.6823 19.3148 19.6068 19.5943 19.4137 19.7844C19.2206 19.9746 18.9399 20.0457 18.6795 19.9706L18.8875 19.25ZM14.9631 18.244L15.263 18.9314L14.9631 18.244ZM18.0914 15.6309L17.4669 15.2156L18.0914 15.6309ZM4.75 11.8041H5.5C5.5 15.2664 8.39065 18.1081 12 18.1081V18.8581V19.6081C7.60123 19.6081 4 16.1334 4 11.8041H4.75ZM19.25 11.8041H18.5C18.5 8.34166 15.6094 5.5 12 5.5V4.75V4C16.3988 4 20 7.47476 20 11.8041H19.25ZM12 4.75V5.5C8.39065 5.5 5.5 8.34166 5.5 11.8041H4.75H4C4 7.47476 7.60123 4 12 4V4.75ZM18.0914 15.6309L17.4669 15.2156C18.1213 14.2315 18.5 13.0612 18.5 11.8041H19.25H20C20 13.3681 19.5276 14.8257 18.716 16.0462L18.0914 15.6309ZM18.8875 19.25L18.1638 19.4467L17.2953 16.2517L18.019 16.055L18.7428 15.8583L19.6112 19.0533L18.8875 19.25ZM12 18.8581V18.1081C12.9509 18.1081 13.8518 17.9105 14.6632 17.5565L14.9631 18.244L15.263 18.9314C14.2652 19.3667 13.1603 19.6081 12 19.6081V18.8581ZM15.3144 18.2188L15.5224 17.4982L19.0955 18.5294L18.8875 19.25L18.6795 19.9706L15.1064 18.9394L15.3144 18.2188ZM14.9631 18.244L14.6632 17.5565C14.925 17.4423 15.2286 17.4134 15.5224 17.4982L15.3144 18.2188L15.1064 18.9394C15.1677 18.957 15.223 18.9489 15.263 18.9314L14.9631 18.244ZM18.0914 15.6309L18.716 16.0462C18.7451 16.0024 18.7636 15.9351 18.7428 15.8583L18.019 16.055L17.2953 16.2517C17.1957 15.8853 17.2716 15.5093 17.4669 15.2156L18.0914 15.6309Z"
      fill="currentColor"
    />
    <circle cx="15" cy="11.75" r="1" fill="currentColor" />
    <circle cx="12" cy="11.75" r="1" fill="currentColor" />
    <circle cx="9" cy="11.75" r="1" fill="currentColor" />
  </svg>
);

// Checkmark icon
export const IconCheckmark = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <g clipPath="url(#clip0_2_45)">
      <path
        d="M16.25 8.75L10 15.25L7.25 12.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
    <defs>
      <clipPath id="clip0_2_45">
        <rect width="24" height="24" fill="white" />
      </clipPath>
    </defs>
  </svg>
);

// Large checkmark icon
export const IconCheckmarkLarge = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <g clipPath="url(#clip0_2_37)">
      <path
        d="M17.5962 7.75L9.42308 16.25L6.15385 12.6538"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
    <defs>
      <clipPath id="clip0_2_37">
        <rect width="24" height="24" fill="white" />
      </clipPath>
    </defs>
  </svg>
);

// Checkmark in circle icon
export const IconCheckmarkCircle = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <g clipPath="url(#clip0_checkmark_circle)">
      <path
        d="M12 20C7.58172 20 4 16.4182 4 12C4 7.58172 7.58172 4 12 4C16.4182 4 20 7.58172 20 12C20 16.4182 16.4182 20 12 20Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15 10L11 14.25L9.25 12.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
    <defs>
      <clipPath id="clip0_checkmark_circle">
        <rect width="24" height="24" fill="white" />
      </clipPath>
    </defs>
  </svg>
);

// X mark / close icon
export const IconXmark = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <g clipPath="url(#clip0_2_53)">
      <path
        d="M16.25 16.25L7.75 7.75"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.75 16.25L16.25 7.75"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
    <defs>
      <clipPath id="clip0_2_53">
        <rect width="24" height="24" fill="white" />
      </clipPath>
    </defs>
  </svg>
);

// X mark large / close icon (larger variant)
export const IconXmarkLarge = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path
      d="M16.7198 6.21973C17.0127 5.92683 17.4874 5.92683 17.7803 6.21973C18.0732 6.51262 18.0732 6.9874 17.7803 7.28027L13.0606 12L17.7803 16.7197C18.0732 17.0126 18.0732 17.4874 17.7803 17.7803C17.4875 18.0731 17.0127 18.0731 16.7198 17.7803L12.0001 13.0605L7.28033 17.7803C6.98746 18.0731 6.51268 18.0731 6.21979 17.7803C5.92689 17.4874 5.92689 17.0126 6.21979 16.7197L10.9395 12L6.21979 7.28027C5.92689 6.98738 5.92689 6.51262 6.21979 6.21973C6.51268 5.92683 6.98744 5.92683 7.28033 6.21973L12.0001 10.9395L16.7198 6.21973Z"
      fill="currentColor"
    />
  </svg>
);

// Sun icon (light mode)
export const IconSun = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none">
    <path
      d="M9.99999 12.7082C11.4958 12.7082 12.7083 11.4956 12.7083 9.99984C12.7083 8.50407 11.4958 7.2915 9.99999 7.2915C8.50422 7.2915 7.29166 8.50407 7.29166 9.99984C7.29166 11.4956 8.50422 12.7082 9.99999 12.7082Z"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M10 3.9585V5.05698"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M10 14.9429V16.0414"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M5.7269 5.72656L6.50682 6.50649"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M13.4932 13.4932L14.2731 14.2731"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M3.95834 10H5.05683"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M14.9432 10H16.0417"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M5.7269 14.2731L6.50682 13.4932"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M13.4932 6.50649L14.2731 5.72656"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// Moon icon (dark mode)
export const IconMoon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none">
    <path
      d="M15.5 10.4955C15.4037 11.5379 15.0124 12.5314 14.3721 13.3596C13.7317 14.1878 12.8688 14.8165 11.8841 15.1722C10.8995 15.5278 9.83397 15.5957 8.81217 15.3679C7.79038 15.1401 6.8546 14.6259 6.11434 13.8857C5.37408 13.1454 4.85995 12.2096 4.63211 11.1878C4.40427 10.166 4.47215 9.10048 4.82781 8.11585C5.18346 7.13123 5.81218 6.26825 6.64039 5.62791C7.4686 4.98756 8.46206 4.59634 9.5045 4.5C8.89418 5.32569 8.60049 6.34302 8.67685 7.36695C8.75321 8.39087 9.19454 9.35339 9.92058 10.0794C10.6466 10.8055 11.6091 11.2468 12.6331 11.3231C13.657 11.3995 14.6743 11.1058 15.5 10.4955Z"
      stroke="currentColor"
      strokeWidth="1.13793"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// Edit/pencil icon for marker hover
export const IconEdit = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M11.3799 6.9572L9.05645 4.63375M11.3799 6.9572L6.74949 11.5699C6.61925 11.6996 6.45577 11.791 6.277 11.8339L4.29549 12.3092C3.93194 12.3964 3.60478 12.0683 3.69297 11.705L4.16585 9.75693C4.20893 9.57947 4.29978 9.4172 4.42854 9.28771L9.05645 4.63375M11.3799 6.9572L12.3455 5.98759C12.9839 5.34655 12.9839 4.31002 12.3455 3.66897C11.7033 3.02415 10.6594 3.02415 10.0172 3.66897L9.06126 4.62892L9.05645 4.63375"
      stroke="currentColor"
      strokeWidth="0.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// Trash icon for delete button in edit panel
export const IconTrash = ({ size = 24 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M13.5 4C14.7426 4 15.75 5.00736 15.75 6.25V7H18.5C18.9142 7 19.25 7.33579 19.25 7.75C19.25 8.16421 18.9142 8.5 18.5 8.5H17.9678L17.6328 16.2217C17.61 16.7475 17.5912 17.1861 17.5469 17.543C17.5015 17.9087 17.4225 18.2506 17.2461 18.5723C16.9747 19.0671 16.5579 19.4671 16.0518 19.7168C15.7227 19.8791 15.3772 19.9422 15.0098 19.9717C14.6514 20.0004 14.2126 20 13.6865 20H10.3135C9.78735 20 9.34856 20.0004 8.99023 19.9717C8.62278 19.9422 8.27729 19.8791 7.94824 19.7168C7.44205 19.4671 7.02532 19.0671 6.75391 18.5723C6.57751 18.2506 6.49853 17.9087 6.45312 17.543C6.40883 17.1861 6.39005 16.7475 6.36719 16.2217L6.03223 8.5H5.5C5.08579 8.5 4.75 8.16421 4.75 7.75C4.75 7.33579 5.08579 7 5.5 7H8.25V6.25C8.25 5.00736 9.25736 4 10.5 4H13.5ZM7.86621 16.1562C7.89013 16.7063 7.90624 17.0751 7.94141 17.3584C7.97545 17.6326 8.02151 17.7644 8.06934 17.8516C8.19271 18.0763 8.38239 18.2577 8.6123 18.3711C8.70153 18.4151 8.83504 18.4545 9.11035 18.4766C9.39482 18.4994 9.76335 18.5 10.3135 18.5H13.6865C14.2367 18.5 14.6052 18.4994 14.8896 18.4766C15.165 18.4545 15.2985 18.4151 15.3877 18.3711C15.6176 18.2577 15.8073 18.0763 15.9307 17.8516C15.9785 17.7644 16.0245 17.6326 16.0586 17.3584C16.0938 17.0751 16.1099 16.7063 16.1338 16.1562L16.4668 8.5H7.5332L7.86621 16.1562ZM9.97656 10.75C10.3906 10.7371 10.7371 11.0626 10.75 11.4766L10.875 15.4766C10.8879 15.8906 10.5624 16.2371 10.1484 16.25C9.73443 16.2629 9.38794 15.9374 9.375 15.5234L9.25 11.5234C9.23706 11.1094 9.56255 10.7629 9.97656 10.75ZM14.0244 10.75C14.4383 10.7635 14.7635 11.1105 14.75 11.5244L14.6201 15.5244C14.6066 15.9384 14.2596 16.2634 13.8457 16.25C13.4317 16.2365 13.1067 15.8896 13.1201 15.4756L13.251 11.4756C13.2645 11.0617 13.6105 10.7366 14.0244 10.75ZM10.5 5.5C10.0858 5.5 9.75 5.83579 9.75 6.25V7H14.25V6.25C14.25 5.83579 13.9142 5.5 13.5 5.5H10.5Z"
      fill="currentColor"
    />
  </svg>
);

// Chevron icons for navigation
export const IconChevronLeft = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M8.5 3.5L4 8L8.5 12.5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const IconChevronRight = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M8.5 11.5L12 8L8.5 4.5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// Animated Bunny mascot
export const AnimatedBunny = ({
  size = 20,
  color = "#4C74FF",
}: {
  size?: number;
  color?: string;
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 28 28"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <style>{`
      @keyframes bunnyEnterEar {
        0% { opacity: 0; transform: scale(0.8); }
        100% { opacity: 1; transform: scale(1); }
      }
      @keyframes bunnyEnterFace {
        0% { opacity: 0; transform: scale(0.9); }
        100% { opacity: 1; transform: scale(1); }
      }
      @keyframes bunnyEnterEye {
        0% { opacity: 0; transform: scale(0.5); }
        100% { opacity: 1; transform: scale(1); }
      }
      @keyframes leftEyeLook {
        0%, 8% { transform: translate(0, 0); }
        10%, 18% { transform: translate(1.5px, 0); }
        20%, 22% { transform: translate(1.5px, 0) scaleY(0.1); }
        24%, 32% { transform: translate(1.5px, 0); }
        35%, 48% { transform: translate(-0.8px, -0.6px); }
        52%, 54% { transform: translate(0, 0) scaleY(0.1); }
        56%, 68% { transform: translate(0, 0); }
        72%, 82% { transform: translate(-0.5px, 0.5px); }
        85%, 100% { transform: translate(0, 0); }
      }
      @keyframes rightEyeLook {
        0%, 8% { transform: translate(0, 0); }
        10%, 18% { transform: translate(0.8px, 0); }
        20%, 22% { transform: translate(0.8px, 0) scaleY(0.1); }
        24%, 32% { transform: translate(0.8px, 0); }
        35%, 48% { transform: translate(-1.5px, -0.6px); }
        52%, 54% { transform: translate(0, 0) scaleY(0.1); }
        56%, 68% { transform: translate(0, 0); }
        72%, 82% { transform: translate(-1.2px, 0.5px); }
        85%, 100% { transform: translate(0, 0); }
      }
      @keyframes leftEarTwitch {
        0%, 9% { transform: rotate(0deg); }
        12% { transform: rotate(-8deg); }
        16%, 34% { transform: rotate(0deg); }
        38% { transform: rotate(-12deg); }
        42% { transform: rotate(-6deg); }
        48%, 100% { transform: rotate(0deg); }
      }
      @keyframes rightEarTwitch {
        0%, 9% { transform: rotate(0deg); }
        12% { transform: rotate(6deg); }
        16%, 34% { transform: rotate(0deg); }
        38% { transform: rotate(10deg); }
        42% { transform: rotate(4deg); }
        48%, 71% { transform: rotate(0deg); }
        74% { transform: rotate(8deg); }
        78%, 100% { transform: rotate(0deg); }
      }
      .bunny-eye-left {
        opacity: 0;
        animation: bunnyEnterEye 0.3s ease-out 0.35s forwards, leftEyeLook 5s ease-in-out 0.65s infinite;
        transform-origin: center;
        transform-box: fill-box;
      }
      .bunny-eye-right {
        opacity: 0;
        animation: bunnyEnterEye 0.3s ease-out 0.4s forwards, rightEyeLook 5s ease-in-out 0.7s infinite;
        transform-origin: center;
        transform-box: fill-box;
      }
      .bunny-ear-left {
        opacity: 0;
        animation: bunnyEnterEar 0.3s ease-out 0.1s forwards, leftEarTwitch 5s ease-in-out 0.4s infinite;
        transform-origin: bottom center;
        transform-box: fill-box;
      }
      .bunny-ear-right {
        opacity: 0;
        animation: bunnyEnterEar 0.3s ease-out 0.15s forwards, rightEarTwitch 5s ease-in-out 0.45s infinite;
        transform-origin: bottom center;
        transform-box: fill-box;
      }
      .bunny-face {
        opacity: 0;
        animation: bunnyEnterFace 0.3s ease-out 0.25s forwards;
        transform-origin: center;
        transform-box: fill-box;
      }
      svg:hover .bunny-eye-left,
      svg:hover .bunny-eye-right {
        opacity: 0;
        transition: opacity 0.2s ease;
      }
      .bunny-happy-face {
        opacity: 0;
        transition: opacity 0.2s ease;
      }
      svg:hover .bunny-happy-face {
        opacity: 1;
      }
    `}</style>
    {/* Invisible hover area to catch all hover events */}
    <rect width="28" height="28" fill="transparent" />
    {/* Left ear */}
    <path
      className="bunny-ear-left"
      d="M3.738 10.2164L7.224 2.007H9.167L5.676 10.2164H3.738ZM10.791 6.42705C10.791 5.90346 10.726 5.42764 10.596 4.99959C10.47 4.57155 10.292 4.16643 10.063 3.78425C9.833 3.39825 9.56 3.01797 9.243 2.64343C8.926 2.26507 8.767 2.07589 8.767 2.07589L10.24 0.957996C10.24 0.957996 10.433 1.17203 10.819 1.60007C11.209 2.0243 11.559 2.49056 11.869 2.99886C12.178 3.50717 12.413 4.04222 12.574 4.60403C12.734 5.16584 12.814 5.77352 12.814 6.42705C12.814 7.10734 12.73 7.7303 12.562 8.29593C12.394 8.85774 12.153 9.3966 11.84 9.9126C11.526 10.4247 11.181 10.8833 10.802 11.2884C10.428 11.6974 10.24 11.9018 10.24 11.9018L8.767 10.7839C8.767 10.7839 8.924 10.5948 9.237 10.2164C9.554 9.8419 9.83 9.4597 10.063 9.06985C10.3 8.6762 10.479 8.26726 10.602 7.84304C10.728 7.41499 10.791 6.943 10.791 6.42705Z"
      fill={color}
    />
    {/* Right ear */}
    <path
      className="bunny-ear-right"
      d="M15.003 10.2164L18.489 2.007H20.432L16.941 10.2164H15.003ZM22.056 6.42705C22.056 5.90346 21.991 5.42764 21.861 4.99959C21.735 4.57155 21.557 4.16643 21.328 3.78425C21.098 3.39825 20.825 3.01797 20.508 2.64343C20.191 2.26507 20.032 2.07589 20.032 2.07589L21.505 0.957996C21.505 0.957996 21.698 1.17203 22.084 1.60007C22.474 2.0243 22.824 2.49056 23.133 2.99886C23.443 3.50717 23.678 4.04222 23.839 4.60403C23.999 5.16584 24.079 5.77352 24.079 6.42705C24.079 7.10734 23.995 7.7303 23.827 8.29593C23.659 8.85774 23.418 9.3966 23.105 9.9126C22.791 10.4247 22.445 10.8833 22.067 11.2884C21.693 11.6974 21.505 11.9018 21.505 11.9018L20.032 10.7839C20.032 10.7839 20.189 10.5948 20.502 10.2164C20.819 9.8419 21.094 9.4597 21.328 9.06985C21.565 8.6762 21.744 8.26726 21.866 7.84304C21.993 7.41499 22.056 6.943 22.056 6.42705Z"
      fill={color}
    />
    {/* Face outline */}
    <path
      className="bunny-face"
      d="M2.03 20.4328C2.03 20.9564 2.093 21.4322 2.219 21.8602C2.345 22.2883 2.523 22.6953 2.752 23.0813C2.981 23.4635 3.254 23.8419 3.572 24.2164C3.889 24.5948 4.047 24.7839 4.047 24.7839L2.574 25.9018C2.574 25.9018 2.379 25.6878 1.989 25.2598C1.603 24.8355 1.256 24.3693 0.946 23.861C0.636 23.3527 0.401 22.8176 0.241 22.2558C0.08 21.694 0 21.0863 0 20.4328C0 19.7525 0.084 19.1314 0.252 18.5696C0.421 18.004 0.661 17.4651 0.975 16.953C1.288 16.4371 1.632 15.9765 2.007 15.5714C2.385 15.1625 2.574 14.958 2.574 14.958L4.047 16.0759C4.047 16.0759 3.889 16.2651 3.572 16.6434C3.258 17.018 2.983 17.4021 2.746 17.7957C2.513 18.1855 2.335 18.5945 2.213 19.0225C2.091 19.4467 2.03 19.9168 2.03 20.4328ZM23.687 20.4271C23.687 19.9035 23.622 19.4276 23.492 18.9996C23.366 18.5715 23.188 18.1664 22.959 17.7843C22.729 17.3982 22.456 17.018 22.139 16.6434C21.822 16.2651 21.663 16.0759 21.663 16.0759L23.136 14.958C23.136 14.958 23.329 15.172 23.715 15.6001C24.105 16.0243 24.455 16.4906 24.765 16.9989C25.074 17.5072 25.309 18.0422 25.47 18.604C25.63 19.1658 25.71 19.7735 25.71 20.4271C25.71 21.1073 25.626 21.7303 25.458 22.2959C25.29 22.8577 25.049 23.3966 24.736 23.9126C24.422 24.4247 24.077 24.8833 23.698 25.2884C23.324 25.6974 23.136 25.9018 23.136 25.9018L21.663 24.7839C21.663 24.7839 21.82 24.5948 22.133 24.2164C22.45 23.8419 22.726 23.4597 22.959 23.0698C23.196 22.6762 23.375 22.2673 23.498 21.843C23.624 21.415 23.687 20.943 23.687 20.4271Z"
      fill={color}
    />
    {/* Animated bunny eyes */}
    <circle className="bunny-eye-left" cx="8.277" cy="20.466" r="1.8" fill={color} />
    <circle className="bunny-eye-right" cx="19.878" cy="20.466" r="1.8" fill={color} />
    {/* Happy face on hover */}
    <text
      className="bunny-happy-face"
      x="14"
      y="26"
      textAnchor="middle"
      fontSize="12"
      fontWeight="bold"
      fill={color}
      fontFamily="system-ui, -apple-system, sans-serif"
    >
      ˃ ᵕ ˂
    </text>
  </svg>
);

// Layout / grid icon for layout mode
export const IconLayout = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <line x1="3" y1="9" x2="21" y2="9" stroke="currentColor" strokeWidth="1.5" />
    <line x1="9" y1="9" x2="9" y2="21" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);
