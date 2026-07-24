import type { Icon } from "./Icons";

/**
 * Compact local mark for Hermes provider surfaces. The paired wings suggest
 * Hermes' caduceus without depending on a remote image asset.
 */
export const HermesIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 24 24" fill="none">
    <path
      d="M12 3v18M8.5 6.5c-2.8-2.2-5-1.1-5.5-.7.8 2.8 2.6 4.2 5.5 4.2h7c2.9 0 4.7-1.4 5.5-4.2-.5-.4-2.7-1.5-5.5.7M8 14h8M9.5 18h5"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="3" r="1.4" fill="currentColor" />
  </svg>
);
