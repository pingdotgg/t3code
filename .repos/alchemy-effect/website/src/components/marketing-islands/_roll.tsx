import type { CSSProperties } from "react";
import { highlightTS } from "../marketing/highlightTS";
import "./HeroHosts.css";

/**
 * A code template whose ⟨n⟩ slots roll between values the way the talk
 * deck's Roll does: a changed value slides up out of its slot while the new
 * one slides in, and the slot's width eases between the two. `segments` is
 * `template.split(/⟨(\d)⟩/)`; `n` bumps on every change to restart the roll.
 * Changed slots stay lit; `lit` lights every slot, changed or not.
 */
export function RollTemplate({
  segments,
  was,
  now,
  n,
  lit = false,
}: {
  segments: string[];
  was: readonly string[];
  now: readonly string[];
  n: number;
  lit?: boolean;
}) {
  return (
    <>
      {segments.map((seg, i) => {
        if (i % 2 === 0)
          return <span key={i} dangerouslySetInnerHTML={{ __html: highlightTS(seg) }} />;
        const k = +seg;
        const rolling = was[k] !== now[k];
        return (
          <span
            key={`${i}-${n}`}
            className={`hh-slot ${rolling || lit ? "is-active" : ""} ${rolling ? "is-rolling" : ""}`}
            style={
              {
                "--from": `${was[k]!.length}ch`,
                "--to": `${now[k]!.length}ch`,
                width: `${now[k]!.length}ch`,
              } as CSSProperties
            }
          >
            <span className="hh-slot__strip">
              <span dangerouslySetInnerHTML={{ __html: highlightTS(was[k]!) || "" }} />
              <span dangerouslySetInnerHTML={{ __html: highlightTS(now[k]!) || "" }} />
            </span>
          </span>
        );
      })}
    </>
  );
}
