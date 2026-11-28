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
const ttmlParameters = "{http://www.w3.org/ns/ttml#parameter}";
const dfxpParameters = "{http://www.w3.org/2006/04/ttaf1#parameter}";

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
  const attributes = root.children.find((node) => node.name === "ttml:tt")?.attrs;
  function parameter(name: string) {
    return (attributes?.[ttmlParameters + name] ?? attributes?.[dfxpParameters + name])?.trim();
  }
  const rate = parameter("frameRate") ?? "30";
  const nominalFrameRate = /^\d+$/.test(rate) ? Number(rate) : NaN;
  const multiplier = parameter("frameRateMultiplier") ?? "1 1";
  const ratio = /^(\d+)\s+(\d+)$/.exec(multiplier);
  const frameRate = nominalFrameRate * (Number(ratio?.[1]) / Number(ratio?.[2]));
  const subFrameRateText = parameter("subFrameRate") ?? "1";
  const subFrameRate = /^\d+$/.test(subFrameRateText) ? Number(subFrameRateText) : NaN;
  const tickText = parameter("tickRate");
  let tickRate = parameter("frameRate") === undefined ? 1 : frameRate * subFrameRate;
  if (tickText !== undefined) tickRate = /^\d+$/.test(tickText) ? Number(tickText) : NaN;
  const timeBase = parameter("timeBase") ?? "media";
  const continuousSmpte = timeBase === "smpte" && parameter("markerMode") === "continuous";
  const dropMode = parameter("dropMode") ?? "nonDrop";

  function captionTime(value: string | undefined) {
    const time = value?.trim() ?? "";
    const tick = /^(\d+(?:\.\d+)?)t$/.exec(time);
    if (tick) {
      const seconds = Number.isFinite(tickRate) && tickRate > 0 ? Number(tick[1]) / tickRate : NaN;
      return Number.isFinite(seconds * 1000) ? seconds : undefined;
    }
    const offset = /^(\d+(?:\.\d+)?)f$/.exec(time);
    const clockMatch = /^(\d{2,}:[0-5]\d:[0-5]\d)(?::(\d{2,})(?:\.(\d+))?)?$/.exec(time);
    const clock = continuousSmpte || clockMatch?.[2] !== undefined ? clockMatch : null;
    if (!offset && !clock) return mediaTime(value);
    if (timeBase !== "media" && !(continuousSmpte && clock)) return;
    if (!Number.isFinite(frameRate) || frameRate <= 0) return;

    const frames = Number(clock?.[2] ?? offset?.[1] ?? 0);
    if (clock && frames >= nominalFrameRate) return;
    let fractionalFrame = 0;
    if (clock?.[3] !== undefined) {
      const subFrames = Number(clock[3]);
      if (!Number.isFinite(subFrameRate) || subFrames >= subFrameRate) return;
      fractionalFrame = subFrames / subFrameRate;
    }
    const clockSeconds = clock ? (mediaTime(clock[1]) ?? NaN) : 0;
    let seconds = clockSeconds + (frames + fractionalFrame) / frameRate;
    if (continuousSmpte) {
      const minutes = Math.floor(clockSeconds / 60);
      const atMinuteStart = clock?.[2] !== undefined && clockSeconds % 60 === 0;
      let droppedFrames = 0;
      // TTML §N.3 counts skipped labels before applying the effective frame rate.
      if (dropMode === "dropNTSC") {
        if (atMinuteStart && minutes % 10 !== 0 && frames < 2) return;
        droppedFrames = (minutes - Math.floor(minutes / 10)) * 2;
      } else if (dropMode === "dropPAL") {
        if (atMinuteStart && minutes % 2 === 0 && minutes % 20 !== 0 && frames < 4) return;
        droppedFrames = (Math.floor(minutes / 2) - Math.floor(minutes / 20)) * 4;
      } else if (dropMode !== "nonDrop") {
        return;
      }
      seconds =
        (clockSeconds * nominalFrameRate + frames - droppedFrames + fractionalFrame) / frameRate;
    }
    if (Number.isFinite(seconds * 1000)) return seconds;
  }

  const cues: string[] = [];
  function captionText(node: XmlNode): string {
    if (node.name === "ttml:br") return "\n";
    if (node.name === "#text") return node.text.replace(/\s+/g, " ");
    return node.children.map(captionText).join("");
  }
  function visit(node: XmlNode, start: number, end: number): number {
    const begin = start + (captionTime(node.attrs.begin) ?? 0);
    const until = captionTime(node.attrs.end);
    const duration = captionTime(node.attrs.dur);
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
