// Served in the HTML response so document URLs and CSP remain independent of the client.
export const HTML_RENDER_SELECTION_SCRIPT = String.raw`// Loaded as raw source into sandboxed HTML documents, including older saved renders.
(() => {
  const method = "t3/selection";
  const excluded =
    "button,input,textarea,select,[role=button],[contenteditable],[hidden],[aria-hidden=true],script,style,template,noscript,svg";
  const normalize = (text) => text.replace(/\s+/g, " ");
  let down = false;
  let active = false;
  let timer;
  let pending = false;
  let pointer = null;
  let marked = null;
  let commentQuote = null;
  let commentTarget = null;
  const post = (params) => window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
  const cancel = () => {
    clearTimeout(timer);
    pending = false;
    active = false;
    pointer = null;
    post(null);
  };
  const stream = () => {
    let text = "";
    let separator = false;
    const chunks = [];
    const visit = (node) => {
      if (node.nodeType === 3 && node.length) {
        if (separator && text.length) text += "\n";
        separator = false;
        chunks.push({ node, start: text.length, end: text.length + node.length });
        text += node.data;
      } else if (node.nodeType === 1 && !node.matches(excluded)) {
        const display = getComputedStyle(node).display;
        if (display === "none") return;
        const block =
          (display && display !== "contents" && !display.startsWith("inline")) ||
          node.tagName === "BR";
        if (block) separator = true;
        for (const child of node.childNodes) visit(child);
        if (block) separator = true;
      }
    };
    if (document.body) visit(document.body);
    return { text, chunks };
  };
  const rect = (range) => {
    // Paragraph selection may include a trailing newline with an empty rect.
    const rects = Array.from(range.getClientRects());
    const r =
      rects.findLast((rect) => rect.width > 0 && rect.height > 0) || range.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };
  const selector = (text, start, end) => {
    const normalized = normalize(text);
    let a = normalize(text.slice(0, start)).length;
    if (start > 0 && /\s/.test(text[start - 1]) && /\s/.test(text[start])) a--;
    const b = normalize(text.slice(0, end)).length;
    let before = Math.max(0, a - 32);
    let after = Math.min(normalized.length, b + 32);
    const splitsPair = (offset) =>
      /[\uD800-\uDBFF]/.test(normalized[offset - 1] || "") &&
      /[\uDC00-\uDFFF]/.test(normalized[offset] || "");
    if (splitsPair(before)) before++;
    if (splitsPair(after)) after--;
    return {
      text: text.slice(start, end),
      start: a,
      end: b,
      prefix: normalized.slice(before, a),
      suffix: normalized.slice(b, after),
    };
  };
  const capture = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0).cloneRange();
    const boundary = (node, last) => {
      if (!range.intersectsNode(node)) return null;
      if (node.nodeType === 3) {
        const start = node === range.startContainer ? range.startOffset : 0;
        const end = node === range.endContainer ? range.endOffset : node.length;
        return start < end ? node : null;
      }
      for (
        let child = last ? node.lastChild : node.firstChild;
        child;
        child = last ? child.previousSibling : child.nextSibling
      ) {
        const found = boundary(child, last);
        if (found) return found;
      }
      return null;
    };
    const first = boundary(range.commonAncestorContainer, false);
    const last = boundary(range.commonAncestorContainer, true);
    if (!first || !last) return null;
    range.setStart(first, first === range.startContainer ? range.startOffset : 0);
    range.setEnd(last, last === range.endContainer ? range.endOffset : last.length);
    const ancestor = (node) => (node.nodeType === 1 ? node : node.parentElement)?.closest(excluded);
    if (ancestor(range.startContainer) || ancestor(range.endContainer)) return null;
    const { text, chunks } = stream();
    let start = null;
    let end = 0;
    for (const chunk of chunks) {
      if (!range.intersectsNode(chunk.node)) continue;
      const a = range.startContainer === chunk.node ? range.startOffset : 0;
      const b = range.endContainer === chunk.node ? range.endOffset : chunk.node.length;
      if (a === b) continue;
      start ??= chunk.start + a;
      end = chunk.start + b;
    }
    if (start === null || !text.slice(start, end).trim()) return null;
    // Keep oversized quotes local; the parent can display its normal shorten action.
    if (end - start > 8000) return { tooLong: true, rect: rect(range), pointer };
    return { selector: selector(text, start, end), rect: rect(range), pointer };
  };
  const schedule = (delay = 0) => {
    clearTimeout(timer);
    pending = true;
    timer = setTimeout(() => {
      pending = false;
      if (active && !down) post(capture());
    }, delay);
  };
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!event.isPrimary) return;
      cancel();
      down = event.button === 0;
      active =
        down &&
        !event.target.closest?.("button,[role=button],input,textarea,select,[contenteditable]");
    },
    true,
  );
  window.addEventListener("pointerup", (event) => {
    if (event.isPrimary) down = false;
  });
  window.addEventListener("pointercancel", () => {
    down = false;
    cancel();
  });
  window.addEventListener("mouseup", (event) => {
    down = false;
    if (!active || event.button !== 0) return;
    pointer = { x: event.clientX, y: event.clientY };
    schedule(event.detail >= 2 ? 500 : 0);
  });
  document.addEventListener("selectionchange", () => {
    if (active && !down && !pending) schedule();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") cancel();
    else if (
      event.key === "Tab" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      active &&
      capture()?.selector
    ) {
      event.preventDefault();
      post({ focus: true });
    } else if (
      (event.shiftKey && event.key.startsWith("Arrow")) ||
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a")
    ) {
      active = true;
      pointer = null;
      schedule();
    }
  });
  document.addEventListener("contextmenu", cancel);
  document.addEventListener(
    "scroll",
    () => {
      if (!down) cancel();
    },
    true,
  );
  window.addEventListener("resize", cancel);
  const clearMark = () => {
    if (window.CSS?.highlights) CSS.highlights.delete("t3-html-citation");
    marked = null;
  };
  const markQuote = (quote, action, changesOnly = false) => {
    clearMark();
    const reply = (target) => {
      if (changesOnly && (
        target === commentTarget ||
        target && commentTarget && ["left", "top", "width", "height"].every(
          (key) => target[key] === commentTarget[key],
        )
      )) return;
      if (action === "mark") commentTarget = target;
      post({ target, selector: quote, action });
    };
    if (
      !quote ||
      typeof quote.text !== "string" ||
      !quote.text.trim() ||
      quote.text.length > 8000 ||
      typeof quote.prefix !== "string" ||
      typeof quote.suffix !== "string"
    ) {
      reply(null);
      return;
    }
    const { text, chunks } = stream();
    const normalized = normalize(text);
    const needle = normalize(quote.text);
    const matches = [];
    for (let at = normalized.indexOf(needle); at >= 0; at = normalized.indexOf(needle, at + 1))
      matches.push(at);
    const contextual = matches.filter(
      (at) =>
        normalized.slice(Math.max(0, at - quote.prefix.length), at) === quote.prefix &&
        normalized.slice(at + needle.length, at + needle.length + quote.suffix.length) ===
          quote.suffix,
    );
    const at =
      contextual.length === 1
        ? contextual[0]
        : contextual.length === 0 && matches.length === 1
          ? matches[0]
          : undefined;
    if (at === undefined) {
      reply(null);
      return;
    }
    const rawOffset = (offset) => {
      let count = 0;
      for (const match of text.matchAll(/\s+|\S+/g)) {
        const whitespace = /\s/.test(match[0][0]);
        const length = whitespace ? 1 : match[0].length;
        if (offset <= count + length)
          return match.index + (whitespace && offset > count ? match[0].length : offset - count);
        count += length;
      }
      return text.length;
    };
    const start = rawOffset(at);
    const end = rawOffset(at + needle.length);
    const first = chunks.find((chunk) => chunk.end > start);
    const last = chunks.findLast((chunk) => chunk.start < end);
    if (!first || !last) {
      reply(null);
      return;
    }
    marked = document.createRange();
    marked.setStart(first.node, Math.max(0, start - first.start));
    marked.setEnd(last.node, Math.min(last.node.length, end - last.start));
    if (action === "target") {
      // Reveal the quoted range, even when its containing element is much taller.
      for (let element = last.node.parentElement; element; element = element.parentElement) {
        if (element === document.scrollingElement) continue;
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        const bounds = rect(marked);
        const top = box.top + element.clientTop;
        const left = box.left + element.clientLeft;
        let dy = 0;
        let dx = 0;
        if (
          /^(auto|scroll|hidden)$/.test(style.overflowY) &&
          element.scrollHeight > element.clientHeight
        )
          dy =
            bounds.top < top
              ? bounds.top - top
              : Math.max(0, bounds.top + bounds.height - top - element.clientHeight);
        if (
          /^(auto|scroll|hidden)$/.test(style.overflowX) &&
          element.scrollWidth > element.clientWidth
        )
          dx =
            bounds.left < left
              ? bounds.left - left
              : Math.max(0, bounds.left + bounds.width - left - element.clientWidth);
        if (dx || dy) element.scrollBy({ left: dx, top: dy, behavior: "instant" });
      }
      const bounds = marked.getBoundingClientRect();
      const marginX = Math.min(80, window.innerWidth / 3);
      const dx = bounds.left < 0
        ? bounds.left - marginX
        : bounds.right > window.innerWidth
          ? bounds.right - window.innerWidth + marginX
          : 0;
      const dy = bounds.top < 0 || bounds.bottom > window.innerHeight
        ? bounds.top - Math.min(80, window.innerHeight / 3)
        : 0;
      // Page CSS can request smooth scrolling; return geometry only after positioning.
      if (dx || dy) window.scrollBy({ left: dx, top: dy, behavior: "instant" });
    }
    if (window.CSS?.highlights && window.Highlight)
      CSS.highlights.set("t3-html-citation", new Highlight(marked));
    reply(rect(marked));
  };
  // Only an open comment needs ongoing quote validation; coalesce page changes.
  let validation;
  const validateComment = () => {
    if (!commentQuote || validation) return;
    validation = requestAnimationFrame(() => {
      validation = null;
      if (commentQuote) markQuote(commentQuote, "mark", true);
    });
  };
  const commentObserver = new MutationObserver(validateComment);
  const commentResize = window.ResizeObserver ? new ResizeObserver(validateComment) : null;
  window.addEventListener("resize", validateComment);
  document.addEventListener("scroll", validateComment, true);
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.data?.method !== "t3/selection-command") return;
    const { action, selector: quote } = event.data.params || {};
    if (action === "clear") {
      cancel();
      window.getSelection()?.removeAllRanges();
    }
    if (action === "dismiss") cancel();
    if (action === "unmark") {
      commentQuote = null;
      commentTarget = null;
      commentObserver.disconnect();
      commentResize?.disconnect();
      clearMark();
    }
    if (action !== "mark" && action !== "target") return;
    commentQuote = action === "mark" ? quote : null;
    if (commentQuote) {
      // Any attribute can affect page CSS; validation replies only when the target changes.
      commentObserver.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      commentResize?.observe(document.documentElement);
    } else {
      commentObserver.disconnect();
      commentResize?.disconnect();
    }
    markQuote(quote, action);
  });
})();
`;
