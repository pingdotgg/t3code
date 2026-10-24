const MESSAGE_TYPE = "t3-html-render-overflow";

export const HTML_RENDER_INLINE_SCRIPT = `(function () {
  var last, pending = false, root = document.documentElement;
  function report() {
    pending = false;
    var body = document.body;
    var contentHeight = root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height;
    // Once the viewport fits, scrollHeight is floored at the viewport and cannot
    // distinguish positioned overflow from empty space left after a collapse.
    if (body && contentHeight < root.scrollHeight && root.scrollHeight <= root.clientHeight) {
      var range;
      function bottom(element, clip) {
        var style = window.getComputedStyle(element);
        if (style.display === "none" || style.position === "fixed") return 0;
        var edge = element.getBoundingClientRect().bottom + window.scrollY;
        var value = Math.min(clip, edge);
        // Internal scrollers and clipped descendants must not grow the page.
        var childClip = style.overflowY === "visible" ? clip : value;
        for (var child = element.firstChild; child; child = child.nextSibling) {
          if (child.nodeType === 1) value = Math.max(value, bottom(child, childClip));
          else if (child.nodeType === 3 && child.textContent.trim()) {
            if (!range) range = document.createRange();
            range.selectNode(child);
            value = Math.max(value, Math.min(childClip, range.getBoundingClientRect().bottom + window.scrollY));
          }
        }
        return value;
      }
      contentHeight = Math.min(root.scrollHeight, Math.max(contentHeight, bottom(body, Infinity)));
    }
    contentHeight = Math.ceil(contentHeight);
    if (!Number.isFinite(contentHeight) || contentHeight <= 0) return;
    var x = Math.max(root.scrollWidth, body ? body.scrollWidth : 0) > window.innerWidth + 1;
    var y = Math.max(root.scrollHeight, body ? body.scrollHeight : 0) > window.innerHeight + 1;
    var next = contentHeight + "," + x + "," + y;
    if (next === last) return;
    last = next;
    window.ReactNativeWebView.postMessage(JSON.stringify({type: ${JSON.stringify(MESSAGE_TYPE)}, contentHeight: contentHeight, x: x, y: y}));
  }
  function schedule() {
    if (pending) return;
    pending = true;
    window.requestAnimationFrame(report);
  }
  report();
  if (window.ResizeObserver) {
    var resize = new ResizeObserver(schedule);
    resize.observe(root);
    if (document.body) resize.observe(document.body);
    document.addEventListener("DOMContentLoaded", function () {
      if (document.body) resize.observe(document.body);
      schedule();
    });
  }
  // Positioned descendants can change scroll overflow without resizing root or body.
  if (window.MutationObserver) {
    new MutationObserver(schedule).observe(root, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ["style", "class", "hidden", "open"]
    });
  }
  document.addEventListener("load", schedule, true);
  window.addEventListener("load", schedule);
  window.addEventListener("resize", schedule);
  if (document.fonts) {
    document.fonts.ready.then(schedule);
    document.fonts.addEventListener("loadingdone", schedule);
    document.fonts.addEventListener("loadingerror", schedule);
  }
})();true;`;

export function readHtmlRenderInlineMessage(data: string) {
  try {
    const message: unknown = JSON.parse(data);
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== MESSAGE_TYPE ||
      !("x" in message) ||
      typeof message.x !== "boolean" ||
      !("y" in message) ||
      typeof message.y !== "boolean" ||
      !("contentHeight" in message) ||
      typeof message.contentHeight !== "number" ||
      !Number.isFinite(message.contentHeight) ||
      message.contentHeight <= 0
    ) {
      return null;
    }
    return { x: message.x, y: message.y, contentHeight: message.contentHeight };
  } catch {
    return null;
  }
}
