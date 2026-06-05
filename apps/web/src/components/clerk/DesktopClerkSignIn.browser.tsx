import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { DesktopCloudAuthOAuthOption } from "../../cloud/desktopAuth";
import { DesktopClerkSignInCard } from "./DesktopClerkSignIn";

const GOOGLE: DesktopCloudAuthOAuthOption = {
  strategy: "oauth_google",
  label: "Google",
  providerId: "google",
  iconUrl: null,
};

const PROVIDERS: readonly DesktopCloudAuthOAuthOption[] = [
  {
    strategy: "oauth_apple",
    label: "Apple",
    providerId: "apple",
    iconUrl: null,
  },
  GOOGLE,
  {
    strategy: "oauth_microsoft",
    label: "Microsoft",
    providerId: "microsoft",
    iconUrl: null,
  },
];

describe("DesktopClerkSignInCard", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses Clerk's compact provider grid when more than two providers are enabled", async () => {
    await render(
      <DesktopClerkSignInCard
        isStarting={false}
        oauthOptions={PROVIDERS}
        startingStrategy={null}
        onJoinWaitlist={vi.fn()}
        onStartOAuth={vi.fn()}
      />,
    );

    expect(document.querySelectorAll('button[aria-label^="Continue with "]')).toHaveLength(3);
    expect(document.body.textContent).toContain("Want early access?");
    expect(document.body.textContent).not.toContain("Continue with Google");
  });

  it("renders a full provider label and starts OAuth for a single provider", async () => {
    const onStartOAuth = vi.fn();
    await render(
      <DesktopClerkSignInCard
        isStarting={false}
        oauthOptions={[GOOGLE]}
        startingStrategy={null}
        onJoinWaitlist={vi.fn()}
        onStartOAuth={onStartOAuth}
      />,
    );

    await userEvent.click(page.getByRole("button", { name: "Continue with Google" }));

    expect(document.body.textContent).toContain("Continue with Google");
    expect(onStartOAuth).toHaveBeenCalledWith("oauth_google");
  });
});
