const MESSAGE_TYPE = "t3-html-render-overflow";

export const HTML_RENDER_INLINE_SCRIPT = `(function () {
  var last, pending = false, root = document.documentElement;
  function report() {
    pending = false;
    var body = document.body;
    var contentHeight = root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height;
    if (!Number.isFinite(contentHeight) || contentHeight < 0) return;
    // Once the viewport fits, scrollHeight is floored at the viewport and cannot
    // distinguish positioned overflow from empty space left after a collapse.
    if (body && contentHeight < root.scrollHeight && root.scrollHeight <= root.clientHeight) {
      var range;
      function bottom(element, clip) {
        var style = window.getComputedStyle(element);
        if (style.display === "none" || style.position === "fixed") return 0;
        var rect = element.getBoundingClientRect();
        var edge = rect.bottom + window.scrollY;
        var value = Math.min(clip, edge);
        // Body overflow propagates to the viewport when root overflow is visible.
        var visible = style.overflowY === "visible" || (element === body && window.getComputedStyle(root).overflowY === "visible");
        if (visible && element.scrollHeight > element.clientHeight) {
          value = Math.max(value, Math.min(clip, rect.top + window.scrollY + element.clientTop + element.scrollHeight));
        }
        // Internal scrollers and clipped descendants must not grow the page.
        var childClip = visible ? clip : value;
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
      // Root pseudo-elements have no DOM nodes and root scrollHeight is viewport-floored.
      ["::before", "::after"].forEach(function (name) {
        var pseudo = window.getComputedStyle(root, name);
        if (pseudo.content === "none" || pseudo.content === "normal" || pseudo.display === "none" || pseudo.position !== "absolute") return;
        var top = parseFloat(pseudo.top), height = parseFloat(pseudo.height);
        if (!Number.isFinite(top) || !Number.isFinite(height)) return;
        var origin = window.getComputedStyle(root).position === "static" ? 0 : root.getBoundingClientRect().top + window.scrollY + root.clientTop;
        var edge = origin + top + height + (parseFloat(pseudo.marginTop) || 0);
        if (pseudo.boxSizing !== "border-box") {
          ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"].forEach(function (key) {
            edge += parseFloat(pseudo[key]) || 0;
          });
        }
        contentHeight = Math.min(root.scrollHeight, Math.max(contentHeight, edge));
      });
    }
    if (!Number.isFinite(contentHeight) || contentHeight < 0) return;
    contentHeight = Math.max(1, Math.ceil(contentHeight));
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
