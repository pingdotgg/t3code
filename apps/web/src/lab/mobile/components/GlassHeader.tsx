import type { ReactNode } from "react";
import type { IconName } from "../icons.generated";
import { Icon } from "./Icon";
import "./GlassHeader.css";

/** A 44pt glass circle button (the native AppBar's back and ellipsis). */
export function GlassButton(props: {
  readonly icon: IconName;
  readonly label: string;
  readonly size?: number;
}) {
  return (
    <button className="m-glass-button" aria-label={props.label}>
      <Icon name={props.icon} size={props.size ?? 22} />
    </button>
  );
}

/** The thread header: back, a centred medium title over a muted subtitle, ellipsis. Content scrolls under it. */
export function GlassHeader(props: {
  readonly title: string;
  readonly subtitle?: string;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
}) {
  return (
    <div className="m-header">
      <div className="m-header-fade" />
      <div className="m-header-row">
        <div className="m-header-side">{props.leading}</div>
        <div className="m-header-title">
          <div className="m-header-title-text">{props.title}</div>
          {props.subtitle ? <div className="m-header-subtitle">{props.subtitle}</div> : null}
        </div>
        <div className="m-header-side m-header-side-end">{props.trailing}</div>
      </div>
    </div>
  );
}
