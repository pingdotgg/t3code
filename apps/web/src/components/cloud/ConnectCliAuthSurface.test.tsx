import type { Dispatch, ReactElement, SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const STATE = "q7mK9xV2pL4nR8sT6wYzAQ";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const AUTHORIZE_URL = "https://clerk.example.test/oauth/authorize?state=q7mK9xV2pL4nR8sT6wYzAQ";

const testState = vi.hoisted(() => ({
  isSignedIn: false,
  openSignIn: vi.fn(),
  assign: vi.fn(),
  rememberState: vi.fn(),
  buildAuthorizeUrl: vi.fn(() => AUTHORIZE_URL),
}));

// The component tree is inspected directly, so hooks are faked rather than
// driven by a renderer. Effects run inline: the point of these tests is what
// the surface does before it hands off to Clerk.
const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
      slots = [];
    },
    useEffect(effect: () => void | (() => void)) {
      nextIndex();
      effect();
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = { current: initialValue };
      }
      return slots[index] as { current: T };
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      return [slots[index] as T, vi.fn()];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: hooks.useEffect,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: testState.isSignedIn }),
  useClerk: () => ({ openSignIn: testState.openSignIn }),
  useUser: () => ({ user: null }),
}));

vi.mock("../../cloud/connectCliAuth", () => ({
  buildConnectCliClerkAuthorizeUrl: testState.buildAuthorizeUrl,
  rememberConnectCliAuthState: testState.rememberState,
  readConnectCliAuthState: () => null,
  readConnectCliCallbackResult: () => null,
}));

import { ConnectCliAuthorizeSurface } from "./ConnectCliAuthSurface";

interface SurfaceMessage {
  readonly title: string;
  readonly description: string;
}

function findMessage(node: unknown): SurfaceMessage | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findMessage(child);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== "object" || node === null || !("props" in node)) {
    return null;
  }
  const props = (node as { readonly props: Record<string, unknown> }).props;
  if (typeof props.title === "string" && typeof props.description === "string") {
    return { title: props.title, description: props.description };
  }
  return findMessage(props.children);
}

function renderAuthorizeSurface(href: string): SurfaceMessage {
  vi.stubGlobal("window", {
    location: { href, assign: testState.assign },
    sessionStorage: { getItem: () => null, setItem: () => {} },
  });
  hooks.beginRender();
  const message = findMessage(ConnectCliAuthorizeSurface() as ReactElement);
  if (!message) {
    throw new Error("The connect surface rendered without a message.");
  }
  return message;
}

const connectUrl = (state: string, challenge: string) =>
  `https://app.t3.codes/connect#state=${state}&challenge=${challenge}`;

describe("ConnectCliAuthorizeSurface", () => {
  beforeEach(() => {
    testState.isSignedIn = false;
    testState.openSignIn.mockClear();
    testState.assign.mockClear();
    testState.rememberState.mockClear();
  });

  it("refuses a corrupted connect URL before starting the browser flow", () => {
    // A pane border picked up while copying a URL that wrapped in a narrow
    // terminal: the CLI never prints a non-base64url character.
    const message = renderAuthorizeSurface(
      connectUrl(`${STATE.slice(0, 10)}%E2%94%82${STATE.slice(11)}`, CHALLENGE),
    );

    expect(message.title).toBe("This connect link is incomplete or corrupted");
    expect(message.description).toContain("Copy the whole URL again");
    expect(testState.openSignIn).not.toHaveBeenCalled();
    expect(testState.rememberState).not.toHaveBeenCalled();
    expect(testState.assign).not.toHaveBeenCalled();
  });

  it("refuses a truncated connect URL before starting the browser flow", () => {
    const message = renderAuthorizeSurface(connectUrl(STATE, CHALLENGE.slice(0, 30)));

    expect(message.title).toBe("This connect link is incomplete or corrupted");
    expect(testState.openSignIn).not.toHaveBeenCalled();
    expect(testState.assign).not.toHaveBeenCalled();
  });

  it("still reports a connect URL that carries no request at all", () => {
    const message = renderAuthorizeSurface("https://app.t3.codes/connect");

    expect(message.title).toBe("This connect link is incomplete");
    expect(testState.openSignIn).not.toHaveBeenCalled();
  });

  it("opens sign-in for a well-formed request from a signed-out browser", () => {
    const message = renderAuthorizeSurface(connectUrl(STATE, CHALLENGE));

    expect(message.title).toBe("Connecting your terminal");
    expect(testState.openSignIn).toHaveBeenCalledTimes(1);
    expect(testState.assign).not.toHaveBeenCalled();
  });

  it("forwards a well-formed request to Clerk once signed in", () => {
    testState.isSignedIn = true;

    renderAuthorizeSurface(connectUrl(STATE, CHALLENGE));

    expect(testState.buildAuthorizeUrl).toHaveBeenCalledWith({
      state: STATE,
      challenge: CHALLENGE,
    });
    expect(testState.rememberState).toHaveBeenCalledWith(STATE);
    expect(testState.assign).toHaveBeenCalledWith(AUTHORIZE_URL);
    expect(testState.openSignIn).not.toHaveBeenCalled();
  });
});
