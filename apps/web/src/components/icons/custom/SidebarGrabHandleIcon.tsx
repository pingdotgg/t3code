import type { SVGProps } from "react";

export function SidebarGrabHandleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 33 56" xmlns="http://www.w3.org/2000/svg" {...props}>
      <rect width="10" height="10" rx="3" fill="currentColor" />
      <rect y="23" width="10" height="10" rx="3" fill="currentColor" />
      <rect y="46" width="10" height="10" rx="3" fill="currentColor" />
      <rect x="23" width="10" height="10" rx="3" fill="currentColor" />
      <rect x="23" y="23" width="10" height="10" rx="3" fill="currentColor" />
      <rect x="23" y="46" width="10" height="10" rx="3" fill="currentColor" />
    </svg>
  );
}
