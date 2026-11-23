import {
  HTML_RENDER_DEFAULT_FONTS,
  htmlRenderTheme,
  injectHtmlRenderBootstrap,
  injectHtmlRenderViewportBridge,
} from "@t3tools/shared/htmlRender";
import { T3_CODE_DARK_THEME_COLORS } from "@t3tools/shared/themePalettes";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";

vi.mock(import("~/hooks/useHtmlRenderTheme"), async (original) => ({
  ...(await original()),
  useHtmlRenderTheme: () =>
    htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark", HTML_RENDER_DEFAULT_FONTS),
}));

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { HtmlRenderDialog } from "./HtmlRenderDialog";

const makeDialog = (src = "https://environment.test/page.html") => (
  <HtmlRenderDialog
    src={src}
    htmlRender={{ attachmentId: "html", title: "Diagram", height: 400 }}
    onClose={() => {}}
  />
);

function frameAndCard() {
  const frame = document.querySelector<HTMLIFrameElement>('[role="dialog"] iframe')!;
  let card = frame.parentElement!;
  while (getComputedStyle(card).overflowY !== "auto") card = card.parentElement!;
  return { frame, card };
}

async function reportHeight(frame: HTMLIFrameElement, height: number) {
  await act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height } },
      }),
    );
  });
}

it("fits the frame to the page's height, requests the viewport bridge, and scrolls only the card at 100%", async () => {
  await page.viewport(1280, 800);
  await using _screen = await render(makeDialog());
  const { frame, card } = frameAndCard();
  expect(frame.src).toContain("?t3-viewport=1");
  expect(frame.src).toContain("&t3-zoomable");
  await reportHeight(frame, 300);
  expect(frame.getBoundingClientRect().height).toBe(300);
  expect(card.scrollHeight).toBe(card.clientHeight);
  expect(card.scrollWidth).toBe(card.clientWidth);
  await reportHeight(frame, 5000);
  expect(frame.getBoundingClientRect().height).toBe(5000);
  expect(card.clientHeight).toBeLessThan(800);
  expect(card.scrollHeight).toBeGreaterThan(card.clientHeight);
  await vi.waitFor(() => expect(card.scrollWidth).toBe(card.clientWidth));
});

it("scales in 2D without reflowing and keeps an off-center landmark pinned on zoom in and zoom out", async () => {
  await page.viewport(1280, 800);
  await using _screen = await render(makeDialog());
  const { frame, card } = frameAndCard();
  await reportHeight(frame, 300);
  const baseRect = frame.getBoundingClientRect();
  const baseWidth = baseRect.width;
  const landmarkX = baseWidth * 0.8;
  const landmarkY = 230;
  const before = { x: baseRect.left + landmarkX, y: baseRect.top + landmarkY };
  const landmarkClient = () => {
    const rect = frame.getBoundingClientRect();
    const scale = rect.width / baseWidth;
    return { x: rect.left + landmarkX * scale, y: rect.top + landmarkY * scale, scale };
  };
  const wheel = (deltaY: number) =>
    card.dispatchEvent(
      new WheelEvent("wheel", {
        ctrlKey: true,
        deltaY,
        clientX: before.x,
        clientY: before.y,
        cancelable: true,
      }),
    );

  wheel(-70);
  await vi.waitFor(() => expect(landmarkClient().scale).toBeGreaterThan(1.8));
  const zoomedIn = landmarkClient();
  expect(Math.abs(zoomedIn.x - before.x)).toBeLessThan(2);
  expect(Math.abs(zoomedIn.y - before.y)).toBeLessThan(2);
  expect(card.scrollWidth).toBeGreaterThan(card.clientWidth);

  wheel(35);
  await vi.waitFor(() => expect(landmarkClient().scale).toBeLessThan(zoomedIn.scale - 0.3));
  const zoomedPartial = landmarkClient();
  expect(zoomedPartial.scale).toBeGreaterThan(1.1);
  expect(Math.abs(zoomedPartial.x - before.x)).toBeLessThan(2);
  expect(Math.abs(zoomedPartial.y - before.y)).toBeLessThan(2);

  await userEvent.click(page.getByRole("button", { name: "Reset zoom" }));
  expect(frame.getBoundingClientRect().width).toBeCloseTo(baseWidth, 0);
  expect(card.scrollWidth).toBe(card.clientWidth);
  for (let step = 0; step < 2; step += 1) {
    await userEvent.click(page.getByRole("button", { name: "Zoom out" }));
  }
  expect(frame.getBoundingClientRect().width).toBeCloseTo(baseWidth * 0.5, 0);
  expect(frame.getBoundingClientRect().height).toBeCloseTo(150, 0);
});

it("bridges full-screen iframe gestures across moving pinches, runs on strict-CSP saved renders, and leaves inline renders untouched", async () => {
  await page.viewport(390, 760);
  const html = injectHtmlRenderBootstrap(`<!doctype html><html><head><style>
    body{margin:0}.board{width:100%;height:420px;position:relative}
    button{position:absolute;right:12px;top:12px}#widget,#capturer,#drop{position:absolute;width:40px;height:40px}#widget{left:12px;top:12px}#capturer{left:90px;top:140px}#drop{left:12px;top:70px}
  </style></head><body><div class="board"><div id="widget"></div><div id="capturer">Drag me</div><div id="drop">Drop</div><button id="toggle" type="button">Tap me</button></div><script>
    const pe=(t,type,id,buttons,x,y)=>t.dispatchEvent(new PointerEvent(type,{pointerId:id,pointerType:"mouse",button:0,buttons,screenX:x,screenY:y,bubbles:true,cancelable:true}));
    const touch=(id,cx,cy,sx,sy)=>new Touch({identifier:id,target:document.body,clientX:cx,clientY:cy,screenX:sx,screenY:sy});
    const ge=(type,scale)=>{const e=new Event(type,{cancelable:true});Object.defineProperty(e,"scale",{value:scale});window.dispatchEvent(e);};
    document.getElementById("toggle").addEventListener("click",()=>parent.postMessage({type:"button-clicked"},"*"));
    document.getElementById("widget").addEventListener("pointerdown",(e)=>e.preventDefault());
    const cap=document.getElementById("capturer");
    cap.addEventListener("pointerdown",(e)=>cap.setPointerCapture(e.pointerId));
    cap.addEventListener("pointerup",()=>parent.postMessage({type:"capture-drag-ended"},"*"));
    window.addEventListener("message",(e)=>{
      if(e.data?.type==="check-wheel"){
        const ev=new WheelEvent("wheel",{ctrlKey:true,deltaY:-60,clientX:250,clientY:200,cancelable:true});
        window.dispatchEvent(ev);
        parent.postMessage({type:"wheel-checked",prevented:ev.defaultPrevented},"*");
      }
      if(e.data?.type==="pinch-step"){
        const {phase,cx,cy,sx,sy,half,scale}=e.data;
        const ts=phase==="touchend"?[]:[touch(1,cx-half/scale,cy,sx-half,sy),touch(2,cx+half/scale,cy,sx+half,sy)];
        window.dispatchEvent(new TouchEvent(phase,{touches:ts,cancelable:true}));
        if(e.data.gesture!==undefined) ge(phase==="touchstart"?"gesturestart":"gesturechange",e.data.gesture);
        parent.postMessage({type:"pinch-flushed"},"*");
      }
      if(e.data?.type==="trigger-drag"){
        pe(document.body,"pointerdown",1,1,200,200);pe(window,"pointermove",1,1,140,160);pe(window,"pointerup",1,0,140,160);
      }
      if(e.data?.type==="trigger-ignored-drags"){
        pe(document.body,"pointerdown",1,1,180,180);pe(window,"pointermove",1,0,80,80);
        const w=document.getElementById("widget");
        pe(w,"pointerdown",2,1,20,20);pe(window,"pointermove",2,1,120,120);pe(window,"pointerup",2,0,120,120);
        parent.postMessage({type:"flushed"},"*");
      }
    });
  </script></body></html>`);
  const src = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(src) };
  const clicked = vi.fn();
  const flushed = vi.fn();
  const pinchFlushed = vi.fn();
  const captureEnded = vi.fn();
  const wheelPrevented: boolean[] = [];
  const messages = new AbortController();
  using _messages = { [Symbol.dispose]: () => messages.abort() };
  window.addEventListener(
    "message",
    (event) => {
      if (event.data?.type === "button-clicked") clicked();
      if (event.data?.type === "flushed") flushed();
      if (event.data?.type === "pinch-flushed") pinchFlushed();
      if (event.data?.type === "capture-drag-ended") captureEnded();
      if (event.data?.type === "wheel-checked") wheelPrevented.push(Boolean(event.data.prevented));
    },
    { signal: messages.signal },
  );

  // Inline frames do not opt into viewport zoom listeners.
  {
    await using _inline = await render(<HtmlRenderDocument src={src} title="Inline" />);
    const inlineFrame = document.querySelector<HTMLIFrameElement>('iframe[title="Inline"]')!;
    await vi.waitFor(() => {
      inlineFrame.contentWindow?.postMessage({ type: "check-wheel" }, "*");
      expect(wheelPrevented.length).toBeGreaterThan(0);
    });
    expect(wheelPrevented.at(-1)).toBe(false);
    wheelPrevented.length = 0;
  }

  // Saved legacy HTML with a strict CSP meta tag runs the head-injected viewport bridge.
  {
    const legacy = injectHtmlRenderViewportBridge(
      `<!doctype html><html><head><style>body{margin:0;height:420px}#a,#b{position:absolute;width:40px;height:40px}#a{left:220px;top:220px}#b{left:80px;top:100px}</style><meta http-equiv="Content-Security-Policy" content="default-src 'none'"></head><body><div id="a">A</div><div id="b">B</div></body></html>`,
    );
    const legacySrc = URL.createObjectURL(new Blob([legacy], { type: "text/html" }));
    using _legacyUrl = { [Symbol.dispose]: () => URL.revokeObjectURL(legacySrc) };
    await using _legacyScreen = await render(makeDialog(legacySrc));
    const { card } = frameAndCard();
    const fl = page.frameLocator(page.getByTitle("Diagram"));
    await fl.getByText("A").click();
    for (let i = 0; i < 4; i += 1) {
      await userEvent.click(page.getByRole("button", { name: "Zoom in" }));
    }
    const start = { left: card.scrollLeft, top: card.scrollTop };
    await userEvent.dragAndDrop(fl.getByText("A"), fl.getByText("B"));
    await vi.waitFor(() => {
      expect(card.scrollLeft).toBeGreaterThan(start.left);
      expect(card.scrollTop).toBeGreaterThan(start.top);
    });
  }

  await using _screen = await render(makeDialog(src));
  const { frame, card } = frameAndCard();
  await vi.waitFor(() => expect(frame.getBoundingClientRect().height).toBeGreaterThanOrEqual(420));

  // Moving two-finger pinch across two zoom commits keeps the landmark under the moving midpoint
  // while suppressing concurrent iOS gesturechange events (150% then 225%).
  const baseRect = frame.getBoundingClientRect();
  const baseWidth = baseRect.width;
  const landmarkX = 160;
  const startScreenX = baseRect.left + landmarkX;
  const sendPinch = (phase: string, screenX: number, half: number, gesture?: number) => {
    const rect = frame.getBoundingClientRect();
    const scale = rect.width / baseWidth;
    frame.contentWindow?.postMessage(
      {
        type: "pinch-step",
        phase,
        cx: (screenX - rect.left) / scale,
        cy: 150,
        sx: screenX,
        sy: 150,
        half,
        scale,
        gesture,
      },
      "*",
    );
  };
  sendPinch("touchstart", startScreenX, 50, 1);
  sendPinch("touchmove", startScreenX + 20, 75, 1.5);
  await vi.waitFor(() => {
    expect(pinchFlushed).toHaveBeenCalledTimes(2);
    expect(page.getByRole("button", { name: "Reset zoom" }).element().textContent).toBe("150%");
  });
  const afterCommit1 = frame.getBoundingClientRect();
  expect(Math.abs(afterCommit1.left + landmarkX * 1.5 - (startScreenX + 20))).toBeLessThan(2);

  sendPinch("touchmove", startScreenX + 40, 112.5, 2.25);
  await vi.waitFor(() => {
    expect(pinchFlushed).toHaveBeenCalledTimes(3);
    expect(page.getByRole("button", { name: "Reset zoom" }).element().textContent).toBe("225%");
  });
  const afterCommit2 = frame.getBoundingClientRect();
  expect(Math.abs(afterCommit2.left + landmarkX * 2.25 - (startScreenX + 40))).toBeLessThan(2);
  sendPinch("touchend", startScreenX + 40, 112.5);
  await vi.waitFor(() => expect(pinchFlushed).toHaveBeenCalledTimes(4));
  await userEvent.click(page.getByRole("button", { name: "Reset zoom" }));

  // Ctrl+wheel inside the full-screen iframe zooms in and consumes the event.
  frame.contentWindow?.postMessage({ type: "check-wheel" }, "*");
  await vi.waitFor(() =>
    expect(page.getByRole("button", { name: "Reset zoom" }).element().textContent).not.toBe("100%"),
  );
  expect(wheelPrevented.at(-1)).toBe(true);
  expect(card.scrollWidth).toBeGreaterThan(card.clientWidth);

  // Mouse drag pans both axes; released-outside hovers and preventDefault widgets do not pan.
  const beforeDrag = { left: card.scrollLeft, top: card.scrollTop };
  frame.contentWindow?.postMessage({ type: "trigger-drag" }, "*");
  await vi.waitFor(() => {
    expect(card.scrollLeft).toBeGreaterThan(beforeDrag.left);
    expect(card.scrollTop).toBeGreaterThan(beforeDrag.top);
  });
  const settled = { left: card.scrollLeft, top: card.scrollTop };
  frame.contentWindow?.postMessage({ type: "trigger-ignored-drags" }, "*");
  await vi.waitFor(() => expect(flushed).toHaveBeenCalledTimes(1));
  expect({ left: card.scrollLeft, top: card.scrollTop }).toEqual(settled);

  // A widget that calls setPointerCapture without preventDefault keeps its drag instead of panning.
  card.scrollLeft = 0;
  card.scrollTop = 0;
  const fl = page.frameLocator(page.getByTitle("Diagram"));
  await userEvent.dragAndDrop(fl.getByText("Drag me"), fl.getByText("Drop"));
  await vi.waitFor(() => expect(captureEnded).toHaveBeenCalledTimes(1));
  expect({ left: card.scrollLeft, top: card.scrollTop }).toEqual({ left: 0, top: 0 });

  // Interactive page buttons remain clickable when zoomed.
  card.scrollLeft = card.scrollWidth - card.clientWidth;
  card.scrollTop = 0;
  await fl.getByRole("button", { name: "Tap me" }).click();
  await vi.waitFor(() => expect(clicked).toHaveBeenCalledTimes(1));
});
