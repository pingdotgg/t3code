import type { SVGProps } from "react";

export function AddProjectIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="currentColor" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path d="M1 10.75A4.25 4.25 0 0 0 5.25 15h1a.75.75 0 0 0 0-1.5h-1a2.75 2.75 0 0 1-2.75-2.75v-5.5A2.75 2.75 0 0 1 5.25 2.5h5.5a2.75 2.75 0 0 1 2.75 2.75v.997a.75.75 0 0 0 1.5 0V5.25A4.25 4.25 0 0 0 10.75 1h-5.5A4.25 4.25 0 0 0 1 5.25z" />
      <path d="M10.75 14.25a.75.75 0 0 0 1.5 0v-2h2a.75.75 0 0 0 0-1.5h-2v-2a.75.75 0 0 0-1.5 0v2h-2a.75.75 0 0 0 0 1.5h2z" />
    </svg>
  );
}
