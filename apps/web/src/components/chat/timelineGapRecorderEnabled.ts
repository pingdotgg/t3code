export const timelineGapRecorderEnabled = (() => {
  if (import.meta.env.DEV) return true;
  try {
    return localStorage.getItem("t3:timeline-gap-recorder") === "1";
  } catch {
    return false;
  }
})();
