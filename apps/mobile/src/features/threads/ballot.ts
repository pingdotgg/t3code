// Custom build: a ballot (an html_render page where the reader marks choices) hands its picks to
// the message box of the thread it belongs to when its Done button calls `t3Compose(text)`, as on
// desktop (apps/web/src/ballot.ts). Nothing is sent.
import { readBallotPicksRequest } from "@t3tools/shared/htmlRender";
import { getRandomValues } from "expo-crypto";
import { appendParagraphToDraft } from "@t3tools/client-runtime/next-prompt-draft";

/** A tap must end this soon before the request, a little like a browser's user activation. */
export const BALLOT_TAP_WINDOW_MS = 1_500;
/** A touch that moves further than this between start and end is a scroll or drag, not a tap. */
export const BALLOT_TAP_SLOP_PX = 10;
/** One tap lets a page hand over this many requests at most, waiting or not. */
export const BALLOT_MAX_REQUESTS_PER_TAP = 4;
/** And this many characters in all, so a looping click handler can't flood the draft. */
export const BALLOT_MAX_CHARS_PER_TAP = 20_000;

const TOKEN_KEY = "t3BallotToken";

export function createBallotToken(): string {
  const bytes = getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Injected before content loads. It captures what it calls and keeps the token in its closure,
 * which stops page code that runs later. Android doesn't promise it runs before inline scripts,
 * so the host's tap gate and per-tap budget are the real boundary, not the token.
 */
export function ballotScript(token: string): string {
  return `(function(){var R=typeof Reflect==="object"&&Reflect,a=R&&R.apply,J=JSON,s=J&&J.stringify,S=String,r=window.ReactNativeWebView,p=r&&r.postMessage;if(typeof a!=="function"||typeof s!=="function"||typeof p!=="function")return;var u=navigator.userActivation,g=null;try{var d=u&&Object.getOwnPropertyDescriptor(Object.getPrototypeOf(u),"isActive");if(d&&typeof d.get==="function")g=d.get;}catch(e){}var k=${JSON.stringify(JSON.stringify(token))};function c(t){if(g&&a(g,u,[])!==true)return;var x=a(s,J,[S(t)]);a(p,r,['{"jsonrpc":"2.0","method":"t3/compose","params":{"text":'+x+'},"${TOKEN_KEY}":'+k+'}']);}try{Object.defineProperty(window,"t3Compose",{value:c,writable:false,configurable:false});}catch(e){window.t3Compose=c;}})();true;`;
}

/** The picks from a ballot's `t3Compose` call, or undefined for any other or forged message. */
export function readBallotMessage(
  data: string,
  token: string,
): { readonly text: string } | undefined {
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof message !== "object" || message === null) return undefined;
  if ((message as Record<string, unknown>)[TOKEN_KEY] !== token) return undefined;
  return readBallotPicksRequest(message);
}

export interface BallotTouchPoint {
  readonly x: number;
  readonly y: number;
  readonly at: number;
}

/** True when a touch ended close to where it started, so it was a tap rather than a scroll. */
export function isBallotTap(start: BallotTouchPoint, end: BallotTouchPoint): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) <= BALLOT_TAP_SLOP_PX;
}

export interface BallotTapGate {
  touchStart(point: BallotTouchPoint): void;
  /** Returns the requests that were waiting for this touch and may now go through. */
  touchEnd(point: BallotTouchPoint): readonly string[];
  touchCancel(): void;
  /** Returns the text when a tap just ended; holds it while a finger is down; drops it otherwise. */
  request(text: string, now: number): readonly string[];
}

/**
 * A page's text is taken only shortly after a real tap (not a scroll), within a per-touch cap on
 * requests and characters. A request that beats the touch's end waits for the finger to lift
 * and goes through only if that was a tap.
 */
export function createBallotTapGate(): BallotTapGate {
  let start: BallotTouchPoint | null = null;
  let lastTapAt: number | null = null;
  let pending: string[] = [];
  // What the current touch has handed over so far; a new touch starts a fresh budget.
  let usedRequests = 0;
  let usedChars = 0;
  const spend = (text: string): boolean => {
    if (
      usedRequests >= BALLOT_MAX_REQUESTS_PER_TAP ||
      usedChars + text.length > BALLOT_MAX_CHARS_PER_TAP
    ) {
      return false;
    }
    usedRequests += 1;
    usedChars += text.length;
    return true;
  };
  return {
    touchStart(point) {
      // A new gesture ends the last tap's window: requests now wait until this touch is a tap.
      start = point;
      lastTapAt = null;
      pending = [];
      usedRequests = 0;
      usedChars = 0;
    },
    touchEnd(point) {
      const tapped = start !== null && isBallotTap(start, point);
      const accepted = tapped ? pending : [];
      lastTapAt = tapped ? point.at : null;
      start = null;
      pending = [];
      return accepted;
    },
    touchCancel() {
      start = null;
      lastTapAt = null;
      pending = [];
    },
    request(text, now) {
      if (lastTapAt !== null && now >= lastTapAt && now - lastTapAt <= BALLOT_TAP_WINDOW_MS) {
        return spend(text) ? [text] : [];
      }
      if (
        start !== null &&
        now >= start.at &&
        now - start.at <= BALLOT_TAP_WINDOW_MS &&
        spend(text)
      ) {
        pending.push(text);
      }
      return [];
    },
  };
}

/** Picks go in as their own paragraph, as next-prompt suggestions do. */
export const appendBallotPicks = appendParagraphToDraft;

export interface BallotPicksRequest {
  /** `scopedThreadKey` of the thread whose timeline holds the page. */
  readonly threadKey: string;
  readonly text: string;
}

type Listener = (request: BallotPicksRequest) => boolean;

const listeners = new Set<Listener>();

/** The thread screen listens here and takes only text from pages in the thread it shows. */
export function onBallotPicks(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True when a thread screen took the text. */
export function requestBallotPicks(request: BallotPicksRequest): boolean {
  for (const listener of listeners) {
    if (listener(request)) return true;
  }
  return false;
}
