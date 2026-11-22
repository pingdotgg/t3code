import type { CSSProperties } from "react";
import { BRANDS, ICONS, type IconName } from "../icons.generated";

/** A superheroicons 24px solid glyph (apps/mobile's icon set; add names in generate-icons.mts). */
export function Icon(props: {
  readonly name: IconName;
  readonly size?: number;
  readonly style?: CSSProperties;
}) {
  const size = props.size ?? 20;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      style={{ flex: "none", display: "block", ...props.style }}
      dangerouslySetInnerHTML={{ __html: ICONS[props.name] }}
    />
  );
}

export type Provider = "claudeAgent" | "codex";

/** The provider mark: Claude's asterisk in its orange, Codex's knot in the text colour. */
export function ProviderIcon(props: {
  readonly provider: Provider;
  readonly size?: number;
  readonly muted?: boolean | undefined;
}) {
  const size = props.size ?? 16;
  const brand = BRANDS[props.provider];
  return (
    <svg
      width={size}
      height={size}
      viewBox={brand.viewBox}
      aria-hidden
      style={{
        flex: "none",
        display: "block",
        fill: props.provider === "claudeAgent" ? "#d97757" : "var(--color-foreground-muted)",
        opacity: props.muted ? 0.6 : 1,
      }}
    >
      {brand.paths.map((d) => (
        <path key={d.slice(0, 24)} d={d} fillRule="evenodd" />
      ))}
    </svg>
  );
}
