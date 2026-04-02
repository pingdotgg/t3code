import { type SVGProps, useId } from "react";

export type Icon = React.FC<SVGProps<SVGSVGElement>>;

export const GitHubIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 1024 1024" fill="none">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z"
      transform="scale(64)"
      fill="currentColor"
    />
  </svg>
);

export const CursorIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 466.73 532.09" fill="currentColor">
    <path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
  </svg>
);

export const TraeIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 24 24" fill="currentColor">
    {/* Back rectangle: left strip + bottom strip drawn separately — empty bottom-left corner is the gap between them */}
    <rect x="1" y="4" width="3" height="14" />
    <rect x="4" y="18" width="18" height="3" />
    {/* Front frame: top bar + right bar only — left and bottom are replaced by the back strips above */}
    <rect x="4" y="4" width="18" height="3" />
    <rect x="19" y="7" width="3" height="11" />
    {/* Two diamonds, offset slightly to the right within the open area */}
    <path d="M11 10L13 12L11 14L9 12Z" />
    <path d="M16 10L18 12L16 14L14 12Z" />
  </svg>
);

export const VisualStudioCode: Icon = (props) => {
  const id = useId();
  const maskId = `${id}-vscode-a`;
  const topShadowFilterId = `${id}-vscode-b`;
  const sideShadowFilterId = `${id}-vscode-c`;
  const overlayGradientId = `${id}-vscode-d`;

  return (
    <svg {...props} fill="none" viewBox="0 0 100 100">
      <mask id={maskId} width="100" height="100" x="0" y="0" maskUnits="userSpaceOnUse">
        <path
          fill="#fff"
          fillRule="evenodd"
          d="M70.912 99.317a6.223 6.223 0 0 0 4.96-.19l20.589-9.907A6.25 6.25 0 0 0 100 83.587V16.413a6.25 6.25 0 0 0-3.54-5.632L75.874.874a6.226 6.226 0 0 0-7.104 1.21L29.355 38.04 12.187 25.01a4.162 4.162 0 0 0-5.318.236l-5.506 5.009a4.168 4.168 0 0 0-.004 6.162L16.247 50 1.36 63.583a4.168 4.168 0 0 0 .004 6.162l5.506 5.01a4.162 4.162 0 0 0 5.318.236l17.168-13.032L68.77 97.917a6.217 6.217 0 0 0 2.143 1.4ZM75.015 27.3 45.11 50l29.906 22.701V27.3Z"
          clipRule="evenodd"
        />
      </mask>
      <g mask={`url(#${maskId})`}>
        <path
          fill="#0065A9"
          d="M96.461 10.796 75.857.876a6.23 6.23 0 0 0-7.107 1.207l-67.451 61.5a4.167 4.167 0 0 0 .004 6.162l5.51 5.009a4.167 4.167 0 0 0 5.32.236l81.228-61.62c2.725-2.067 6.639-.124 6.639 3.297v-.24a6.25 6.25 0 0 0-3.539-5.63Z"
        />
        <g filter={`url(#${topShadowFilterId})`}>
          <path
            fill="#007ACC"
            d="m96.461 89.204-20.604 9.92a6.229 6.229 0 0 1-7.107-1.207l-67.451-61.5a4.167 4.167 0 0 1 .004-6.162l5.51-5.009a4.167 4.167 0 0 1 5.32-.236l81.228 61.62c2.725 2.067 6.639.124 6.639-3.297v.24a6.25 6.25 0 0 1-3.539 5.63Z"
          />
        </g>
        <g filter={`url(#${sideShadowFilterId})`}>
          <path
            fill="#1F9CF0"
            d="M75.858 99.126a6.232 6.232 0 0 1-7.108-1.21c2.306 2.307 6.25.674 6.25-2.588V4.672c0-3.262-3.944-4.895-6.25-2.589a6.232 6.232 0 0 1 7.108-1.21l20.6 9.908A6.25 6.25 0 0 1 100 16.413v67.174a6.25 6.25 0 0 1-3.541 5.633l-20.601 9.906Z"
          />
        </g>
        <path
          fill={`url(#${overlayGradientId})`}
          fillRule="evenodd"
          d="M70.851 99.317a6.224 6.224 0 0 0 4.96-.19L96.4 89.22a6.25 6.25 0 0 0 3.54-5.633V16.413a6.25 6.25 0 0 0-3.54-5.632L75.812.874a6.226 6.226 0 0 0-7.104 1.21L29.294 38.04 12.126 25.01a4.162 4.162 0 0 0-5.317.236l-5.507 5.009a4.168 4.168 0 0 0-.004 6.162L16.186 50 1.298 63.583a4.168 4.168 0 0 0 .004 6.162l5.507 5.009a4.162 4.162 0 0 0 5.317.236L29.294 61.96l39.414 35.958a6.218 6.218 0 0 0 2.143 1.4ZM74.954 27.3 45.048 50l29.906 22.701V27.3Z"
          clipRule="evenodd"
          opacity=".25"
          style={{ mixBlendMode: "overlay" }}
        />
      </g>
      <defs>
        <filter
          id={topShadowFilterId}
          width="116.727"
          height="92.246"
          x="-8.394"
          y="15.829"
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" />
          <feOffset />
          <feGaussianBlur stdDeviation="4.167" />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend in2="BackgroundImageFix" mode="overlay" result="effect1_dropShadow" />
          <feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <filter
          id={sideShadowFilterId}
          width="47.917"
          height="116.151"
          x="60.417"
          y="-8.076"
          colorInterpolationFilters="sRGB"
          filterUnits="userSpaceOnUse"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" />
          <feOffset />
          <feGaussianBlur stdDeviation="4.167" />
          <feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend in2="BackgroundImageFix" mode="overlay" result="effect1_dropShadow" />
          <feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <linearGradient
          id={overlayGradientId}
          x1="49.939"
          x2="49.939"
          y1=".258"
          y2="99.742"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
};

export const Zed: Icon = (props) => {
  const id = useId();
  const clipPathId = `${id}-zed-logo-a`;

  return (
    <svg {...props} fill="none" viewBox="0 0 96 96">
      <g clipPath={`url(#${clipPathId})`}>
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M9 6a3 3 0 0 0-3 3v66H0V9a9 9 0 0 1 9-9h80.379c4.009 0 6.016 4.847 3.182 7.682L43.055 57.187H57V51h6v7.688a4.5 4.5 0 0 1-4.5 4.5H37.055L26.743 73.5H73.5V36h6v37.5a6 6 0 0 1-6 6H20.743L10.243 90H87a3 3 0 0 0 3-3V21h6v66a9 9 0 0 1-9 9H6.621c-4.009 0-6.016-4.847-3.182-7.682L52.757 39H39v6h-6v-7.5a4.5 4.5 0 0 1 4.5-4.5h21.257l10.5-10.5H22.5V60h-6V22.5a6 6 0 0 1 6-6h52.757L85.757 6H9Z"
          clipRule="evenodd"
        />
      </g>
      <defs>
        <clipPath id={clipPathId}>
          <path fill="#fff" d="M0 0h96v96H0z" />
        </clipPath>
      </defs>
    </svg>
  );
};

export const OpenAI: Icon = (props) => (
  <svg {...props} preserveAspectRatio="xMidYMid" viewBox="0 0 256 260" fill="currentColor">
    <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" />
  </svg>
);

export const ClaudeAI: Icon = (props) => (
  <svg {...props} preserveAspectRatio="xMidYMid" viewBox="0 0 256 257">
    <path
      fill="currentColor"
      d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z"
    />
  </svg>
);

export const Gemini: Icon = (props) => (
  <svg {...props} viewBox="0 0 296 298" fill="none">
    <mask
      id="gemini__a"
      width="296"
      height="298"
      x="0"
      y="0"
      maskUnits="userSpaceOnUse"
      style={{ maskType: "alpha" }}
    >
      <path
        fill="#3186FF"
        d="M141.201 4.886c2.282-6.17 11.042-6.071 13.184.148l5.985 17.37a184.004 184.004 0 0 0 111.257 113.049l19.304 6.997c6.143 2.227 6.156 10.91.02 13.155l-19.35 7.082a184.001 184.001 0 0 0-109.495 109.385l-7.573 20.629c-2.241 6.105-10.869 6.121-13.133.025l-7.908-21.296a184 184 0 0 0-109.02-108.658l-19.698-7.239c-6.102-2.243-6.118-10.867-.025-13.132l20.083-7.467A183.998 183.998 0 0 0 133.291 26.28l7.91-21.394Z"
      />
    </mask>
    <g mask="url(#gemini__a)">
      <g filter="url(#gemini__b)">
        <ellipse cx="163" cy="149" fill="#3689FF" rx="196" ry="159" />
      </g>
      <g filter="url(#gemini__c)">
        <ellipse cx="33.5" cy="142.5" fill="#F6C013" rx="68.5" ry="72.5" />
      </g>
      <g filter="url(#gemini__d)">
        <ellipse cx="19.5" cy="148.5" fill="#F6C013" rx="68.5" ry="72.5" />
      </g>
      <g filter="url(#gemini__e)">
        <path fill="#FA4340" d="M194 10.5C172 82.5 65.5 134.333 22.5 135L144-66l50 76.5Z" />
      </g>
      <g filter="url(#gemini__f)">
        <path fill="#FA4340" d="M190.5-12.5C168.5 59.5 62 111.333 19 112L140.5-89l50 76.5Z" />
      </g>
      <g filter="url(#gemini__g)">
        <path fill="#14BB69" d="M194.5 279.5C172.5 207.5 66 155.667 23 155l121.5 201 50-76.5Z" />
      </g>
      <g filter="url(#gemini__h)">
        <path fill="#14BB69" d="M196.5 320.5C174.5 248.5 68 196.667 25 196l121.5 201 50-76.5Z" />
      </g>
    </g>
    <defs>
      <filter
        id="gemini__b"
        width="464"
        height="390"
        x="-69"
        y="-46"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="18" />
      </filter>
      <filter
        id="gemini__c"
        width="265"
        height="273"
        x="-99"
        y="6"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__d"
        width="265"
        height="273"
        x="-113"
        y="12"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__e"
        width="299.5"
        height="329"
        x="-41.5"
        y="-130"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__f"
        width="299.5"
        height="329"
        x="-45"
        y="-153"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__g"
        width="299.5"
        height="329"
        x="-41"
        y="91"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
      <filter
        id="gemini__h"
        width="299.5"
        height="329"
        x="-39"
        y="132"
        colorInterpolationFilters="sRGB"
        filterUnits="userSpaceOnUse"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur result="effect1_foregroundBlur_69_17998" stdDeviation="32" />
      </filter>
    </defs>
  </svg>
);

const ANTIGRAVITY_ICON_DATA_URL =
  "data:image/png;base64,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";

export const AntigravityIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 128 128" fill="none">
    <image href={ANTIGRAVITY_ICON_DATA_URL} width="128" height="128" />
  </svg>
);

export const IntelliJIdeaIcon: Icon = (props) => {
  const id = useId();
  const gradientAId = `${id}-idea-a`;
  const gradientBId = `${id}-idea-b`;
  const gradientCId = `${id}-idea-c`;
  const gradientDId = `${id}-idea-d`;

  return (
    <svg {...props} viewBox="0 0 70 70" fill="none">
      <defs>
        <linearGradient
          id={gradientAId}
          x1="0.7898"
          y1="40.0893"
          x2="33.3172"
          y2="40.0893"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0.2581" stopColor="#F97A12" />
          <stop offset="0.4591" stopColor="#B07B58" />
          <stop offset="0.7241" stopColor="#577BAE" />
          <stop offset="0.9105" stopColor="#1E7CE5" />
          <stop offset="1" stopColor="#087CFA" />
        </linearGradient>
        <linearGradient
          id={gradientBId}
          x1="25.7674"
          y1="24.88"
          x2="79.424"
          y2="54.57"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#F97A12" />
          <stop offset="0.07179946" stopColor="#CB7A3E" />
          <stop offset="0.1541" stopColor="#9E7B6A" />
          <stop offset="0.242" stopColor="#757B91" />
          <stop offset="0.3344" stopColor="#537BB1" />
          <stop offset="0.4324" stopColor="#387CCC" />
          <stop offset="0.5381" stopColor="#237CE0" />
          <stop offset="0.6552" stopColor="#147CEF" />
          <stop offset="0.7925" stopColor="#0B7CF7" />
          <stop offset="1" stopColor="#087CFA" />
        </linearGradient>
        <linearGradient
          id={gradientCId}
          x1="63.2277"
          y1="42.9153"
          x2="48.2903"
          y2="-1.7191"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FE315D" />
          <stop offset="0.07840246" stopColor="#CB417E" />
          <stop offset="0.1601" stopColor="#9E4E9B" />
          <stop offset="0.2474" stopColor="#755BB4" />
          <stop offset="0.3392" stopColor="#5365CA" />
          <stop offset="0.4365" stopColor="#386DDB" />
          <stop offset="0.5414" stopColor="#2374E9" />
          <stop offset="0.6576" stopColor="#1478F3" />
          <stop offset="0.794" stopColor="#0B7BF8" />
          <stop offset="1" stopColor="#087CFA" />
        </linearGradient>
        <linearGradient
          id={gradientDId}
          x1="10.7204"
          y1="16.473"
          x2="55.5237"
          y2="90.58"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FE315D" />
          <stop offset="0.04023279" stopColor="#F63462" />
          <stop offset="0.1037" stopColor="#DF3A71" />
          <stop offset="0.1667" stopColor="#C24383" />
          <stop offset="0.2912" stopColor="#AD4A91" />
          <stop offset="0.5498" stopColor="#755BB4" />
          <stop offset="0.9175" stopColor="#1D76ED" />
          <stop offset="1" stopColor="#087CFA" />
        </linearGradient>
      </defs>
      <polygon points="17.7,54.6 0.8,41.2 9.2,25.6 33.3,35" fill={`url(#${gradientAId})`} />
      <path
        d="M70 18.7 68.7 59.2 41.8 70 25.6 59.6 49.3 35 38.9 12.3 48.2 1.1Z"
        fill={`url(#${gradientBId})`}
      />
      <polygon points="70,18.7 48.7,43.9 38.9,12.3 48.2,1.1" fill={`url(#${gradientCId})`} />
      <path
        d="M33.7 58.1 5.6 68.3 10.1 52.5 16 33.1 0 27.7 10.1 0 32.1 2.7 53.7 27.4Z"
        fill={`url(#${gradientDId})`}
      />
      <rect x="13.7" y="13.5" width="43.2" height="43.2" fill="#000" />
      <rect x="17.7" y="48.6" width="16.2" height="2.7" fill="#fff" />
      <path d="M29.4 22.4v-3.3h-9v3.3h2.6v11.3h-2.6V37h9v-3.3h-2.5V22.4h2.5Z" fill="#fff" />
      <path
        d="M38 37.3c-1.4 0-2.6-.3-3.5-.8-.9-.5-1.7-1.2-2.3-1.9l2.5-2.8c.5.6 1 1 1.5 1.3.5.3 1.1.5 1.7.5.7 0 1.3-.2 1.8-.7.4-.5.6-1.2.6-2.3V19.1h4v11.7c0 1.1-.1 2-.4 2.8-.3.8-.7 1.4-1.3 2-.5.5-1.2 1-2 1.2-.8.3-1.6.5-2.6.5Z"
        fill="#fff"
      />
    </svg>
  );
};

export const OpenCodeIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 32 40" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g clipPath="url(#opencode__clip0_1311_94969)">
      <path d="M24 32H8V16H24V32Z" fill="#BCBBBB" />
      <path d="M24 8H8V32H24V8ZM32 40H0V0H32V40Z" fill="#211E1E" />
    </g>
    <defs>
      <clipPath id="opencode__clip0_1311_94969">
        <rect width="32" height="40" fill="white" />
      </clipPath>
    </defs>
  </svg>
);
