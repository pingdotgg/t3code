import type { XmlNode } from "./documentPreviewXml";

export function mediaTime(value: string | undefined): number | undefined {
  const time = value?.trim().replace(/^npt=/, "");
  if (!time) return;
  const clock = /^(?:(\d+):)?([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/.exec(time);
  const offset = /^(\d+(?:\.\d+)?)(h|min|m|s|ms)?$/.exec(time);
  const seconds = clock
    ? Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
    : offset
      ? Number(offset[1]) *
        (offset[2] === "h"
          ? 3600
          : offset[2] === "min" || offset[2] === "m"
            ? 60
            : offset[2] === "ms"
              ? 0.001
              : 1)
      : NaN;
  if (Number.isFinite(seconds)) return seconds;
}

const nptTime = /^(?:(?:\d+:)?[0-5]\d:[0-5]\d|\d+)(?:\.\d*)?$/;
const ttmlContent = new Set(["ttml:tt", "ttml:body", "ttml:div", "ttml:p"]);

export function mediaFragment(href: string) {
  const hash = href.indexOf("#");
  if (hash < 0) return "";
  const time = new URLSearchParams(href.slice(hash + 1)).get("t")?.replace(/^npt:/, "");
  if (!time) return "";
  const [start, stop, extra] = time.split(",");
  if (extra !== undefined || (start && !nptTime.test(start)) || (!start && !stop)) return "";
  if (stop !== undefined && !nptTime.test(stop)) return "";
  const begin = start ? mediaTime(start.replace(/\.$/, "")) : 0;
  const end = mediaTime(stop?.replace(/\.$/, ""));
  if (begin === undefined || (stop !== undefined && (end === undefined || end <= begin))) return "";
  return end === undefined ? `#t=${begin}` : `#t=${begin},${end}`;
}

function vttTime(seconds: number) {
  const ms = Math.round(seconds * 1000);
  return (
    [
      String(Math.floor(ms / 3_600_000)).padStart(2, "0"),
      String(Math.floor(ms / 60_000) % 60).padStart(2, "0"),
      String(Math.floor(ms / 1000) % 60).padStart(2, "0"),
    ].join(":") +
    "." +
    String(ms % 1000).padStart(3, "0")
  );
}

export function ttmlCaptions(root: XmlNode) {
  const cues: string[] = [];
  function captionText(node: XmlNode): string {
    if (node.name === "ttml:br") return "\n";
    if (node.name === "#text") return node.text.replace(/\s+/g, " ");
    return node.children.map(captionText).join("");
  }
  function visit(node: XmlNode, start: number, end: number): number {
    const begin = start + (mediaTime(node.attrs.begin) ?? 0);
    const until = mediaTime(node.attrs.end);
    const duration = mediaTime(node.attrs.dur);
    const finish = Math.min(
      end,
      until === undefined ? Infinity : start + until,
      duration === undefined ? Infinity : begin + duration,
    );
    if (begin >= finish || cues.length >= 4096) return Math.min(end, begin);
    if (node.name === "ttml:p") {
      const content = captionText(node)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (Number.isFinite(finish) && finish > begin && content.length) {
        const payload = content
          .join("\n")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
        cues.push(`${vttTime(begin)} --> ${vttTime(finish)}\n${payload}`);
      }
      return finish;
    }
    const sequential = node.attrs.timeContainer === "seq";
    let childrenEnd = begin;
    for (const child of node.children) {
      if (!ttmlContent.has(child.name)) continue;
      const childEnd = visit(child, sequential ? childrenEnd : begin, finish);
      childrenEnd = Math.max(childrenEnd, childEnd);
    }
    return until === undefined && duration === undefined ? childrenEnd : finish;
  }
  visit(root, 0, Infinity);
  return cues.length ? `WEBVTT\n\n${cues.join("\n\n")}\n` : "";
}
