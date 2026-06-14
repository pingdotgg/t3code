/**
 * Imperative band chrome sync (gauge label highlight, prev/next visibility)
 * plus the view-scoped stylesheet. Extracted from t3work-PlanningSpaceView.tsx.
 */

import { planningGaugeActiveLabel } from "./t3work-planningSpaceScene";

const GAUGE_ACTIVE_CLASS = "text-left text-[9px] leading-6 text-primary";
const GAUGE_IDLE_CLASS =
  "text-left text-[9px] leading-6 text-muted-foreground hover:text-foreground";

export function syncPlanningBandChrome(input: {
  band: number;
  allMode: boolean;
  gaugeButtons: ReadonlyMap<string, HTMLButtonElement>;
  navPrev: HTMLButtonElement | null;
  navNext: HTMLButtonElement | null;
}): void {
  const bandLabelForActive = planningGaugeActiveLabel(input.band);
  for (const [label, button] of input.gaugeButtons) {
    const isActive = input.allMode ? label === "All" : label === bandLabelForActive;
    button.className = isActive ? GAUGE_ACTIVE_CLASS : GAUGE_IDLE_CLASS;
  }
  const showNav = input.band >= 5 && !input.allMode;
  for (const button of [input.navPrev, input.navNext]) {
    if (button) button.style.display = showNav ? "" : "none";
  }
}

export const PLANNING_SPACE_CSS = `
.t3ps-root button{cursor:pointer}
.t3ps-node{position:absolute;left:0;top:0;visibility:hidden;will-change:transform}
.t3ps-inner{position:absolute;left:0;top:0;transform:translate(-50%,-50%)}
.t3ps-dot{display:none;width:14px;height:14px;border-radius:9999px;cursor:pointer}
.t3ps-card{width:104px;padding:6px 8px;cursor:pointer}
.t3ps-node[data-live="true"] .t3ps-card{transition:width .35s ease-out}
.t3ps-node[data-band="5"] .t3ps-card{cursor:default}
.t3ps-anchor{cursor:pointer}
.t3ps-node[data-band="0"] .t3ps-card{display:none}
.t3ps-node[data-band="0"] .t3ps-dot{display:block}
.t3ps-node[data-band="0"] .t3ps-title,.t3ps-node[data-band="1"] .t3ps-title{display:none}
.t3ps-node[data-band="1"] .t3ps-avatar{display:none}
.t3ps-node[data-band="2"] .t3ps-card{width:210px}
.t3ps-node[data-band="3"] .t3ps-card{width:352px}
.t3ps-node[data-band="4"] .t3ps-card{width:424px}
.t3ps-node[data-band="5"] .t3ps-card{width:470px}
.t3ps-subdots{display:none}
.t3ps-node[data-band="2"] .t3ps-subdots{display:flex}
.t3ps-subgrid{display:none}
.t3ps-node[data-band="3"] .t3ps-subgrid,.t3ps-node[data-band="4"] .t3ps-subgrid,.t3ps-node[data-band="5"] .t3ps-subgrid{display:grid}
.t3ps-node[data-band="4"] .t3ps-substep,.t3ps-node[data-band="5"] .t3ps-substep{display:flex}
.t3ps-node[data-band="3"] .t3ps-subtitle{-webkit-line-clamp:1}
.t3ps-node[data-band="4"] .t3ps-subtitle,.t3ps-node[data-band="5"] .t3ps-subtitle{white-space:normal;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.t3ps-anchor{transition:outline-color .2s}
.t3ps-elabel{width:240px}
.t3ps-node[data-band="0"] .t3ps-elabel{width:150px}
.t3ps-node[data-band="0"] .t3ps-estat{display:none}
.t3ps-allov{animation:t3psFadeIn .35s ease-out}
.t3ps-allov>button{animation:t3psRise .35s ease-out backwards}
@keyframes t3psFadeIn{from{opacity:0}to{opacity:1}}
@keyframes t3psRise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
[data-drop-hot]{outline:2px dashed var(--primary, #7c89ff);outline-offset:3px;border-radius:8px}
`;
