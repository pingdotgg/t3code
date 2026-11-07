import { useId, type SVGProps } from "react";

// OminaX "Nest" mark: an O with two side-chat bubbles, cut apart by clip paths.
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  const id = useId();
  return (
    <svg {...props} viewBox="134 164 808 782" xmlns="http://www.w3.org/2000/svg">
      <clipPath id={`${id}o`}>
        <path
          clipRule="evenodd"
          d="M-200 -200H1224V1224H-200ZM546 740a182 182 0 1 0 364 0a182 182 0 1 0 -364 0Z"
        />
      </clipPath>
      <clipPath id={`${id}b`}>
        <path
          clipRule="evenodd"
          d="M-200 -200H1224V1224H-200ZM798 888a86 86 0 1 0 172 0a86 86 0 1 0 -172 0Z"
        />
      </clipPath>
      <circle
        cx="440"
        cy="470"
        r="250"
        clipPath={`url(#${id}o)`}
        fill="none"
        stroke="currentColor"
        strokeWidth="112"
      />
      <circle cx="728" cy="740" r="150" clipPath={`url(#${id}b)`} fill="currentColor" />
      <circle cx="884" cy="888" r="58" fill="currentColor" />
    </svg>
  );
}
