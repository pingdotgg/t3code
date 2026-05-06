import type { SVGProps } from "react";

export function GitHubRepoIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="currentColor" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path d="M7 2a1 1 0 0 1 2 0v5h2.5c.444 0 .668.568.353.9l-3.5 2.946a.482.482 0 0 1-.706 0L4.147 7.9c-.314-.332-.091-.9.354-.9H7V2Z" />
      <path d="M1.808 8.382c.446 0 .807.342.807.763v2.546c0 .984.844 1.782 1.885 1.782h7c1.04 0 1.885-.798 1.885-1.782V9.145c0-.421.361-.763.807-.763.446 0 .808.342.808.763v2.546C15 13.518 13.433 15 11.5 15h-7C2.567 15 1 13.518 1 11.69V9.146c0-.421.362-.763.808-.763Z" />
    </svg>
  );
}
