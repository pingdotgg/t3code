import type { SVGProps } from "react";

type SidebarPlanReadyIconProps = SVGProps<SVGSVGElement> & {
  strokeWidth?: number;
};

export function SidebarPlanReadyIcon({
  strokeWidth: _strokeWidth,
  ...props
}: SidebarPlanReadyIconProps) {
  return (
    <svg
      data-icon="plan-ready"
      fill="currentColor"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        clipRule="evenodd"
        d="M14.25 12.0052L11.75 9.75V14.29L14.25 12.0052Z"
        fillRule="evenodd"
      />
      <path
        clipRule="evenodd"
        d="M1.75 1C2.16399 1.00026 2.5 1.33595 2.5 1.75V8C2.50013 9.79481 3.95613 11.25 5.75098 11.25H11V9.74512C11 9.45081 11.1746 9.18409 11.4453 9.06445C11.716 8.94494 12.032 8.99532 12.252 9.19238L14.752 11.4316C14.909 11.5723 14.9993 11.7733 15 11.9834C15.0005 12.1932 14.9118 12.3936 14.7559 12.5352L12.2559 14.8047C12.0365 15.0038 11.7192 15.0556 11.4473 14.9365C11.1754 14.8174 11.0001 14.55 11 14.2549V12.75H5.75098C3.12771 12.75 1.00013 10.6232 1 8V1.75C1 1.33595 1.33601 1.00026 1.75 1Z"
        fillRule="evenodd"
      />
      <path
        clipRule="evenodd"
        d="M8.25 6C8.66421 6 9 6.33579 9 6.75C9 7.16421 8.66421 7.5 8.25 7.5H5.75C5.33579 7.5 5 7.16421 5 6.75C5 6.33579 5.33579 6 5.75 6H8.25Z"
        fillRule="evenodd"
      />
      <path
        clipRule="evenodd"
        d="M11.25 2C11.6642 2 12 2.33579 12 2.75C12 3.16421 11.6642 3.5 11.25 3.5H5.75C5.33579 3.5 5 3.16421 5 2.75C5 2.33579 5.33579 2 5.75 2H11.25Z"
        fillRule="evenodd"
      />
    </svg>
  );
}
