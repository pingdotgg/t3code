import type { SVGProps } from "react";

export function SidebarPanelIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        clipRule="evenodd"
        d="M4.25 2C2.45508 2 1 3.45508 1 5.25V10.75C1 12.5449 2.45508 14 4.25 14H11.75C13.5449 14 15 12.5449 15 10.75V5.25C15 3.45508 13.5449 2 11.75 2H4.25ZM2.5 5.5C2.5 4.39543 3.39543 3.5 4.5 3.5H11.5C12.6046 3.5 13.5 4.39543 13.5 5.5V10.5C13.5 11.6046 12.6046 12.5 11.5 12.5H4.5C3.39543 12.5 2.5 11.6046 2.5 10.5V5.5Z"
        fill="currentColor"
        fillRule="evenodd"
      />
      <rect
        x="4"
        y="5"
        width="1.5"
        height="6"
        rx="0.75"
        fill="currentColor"
        style={{ transitionDuration: "250ms", transitionProperty: "width" }}
      />
    </svg>
  );
}
