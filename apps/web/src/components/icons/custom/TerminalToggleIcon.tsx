import type { SVGProps } from "react";

export function TerminalToggleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M12 19h8" />
      <path d="m4 17 6-6-6-6" />
    </svg>
  );
}
