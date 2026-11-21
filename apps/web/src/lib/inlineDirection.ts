export function isUiRtl(): boolean {
  return document.documentElement.dir === "rtl";
}

export function inlineArrowKey(edge: "start" | "end"): "ArrowLeft" | "ArrowRight" {
  return (edge === "start") !== isUiRtl() ? "ArrowLeft" : "ArrowRight";
}
