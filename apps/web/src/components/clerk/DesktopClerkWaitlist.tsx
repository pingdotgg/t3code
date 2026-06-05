import { useClerk } from "@clerk/react";
import { useState } from "react";

import {
  DesktopClerkAlert,
  DesktopClerkCard,
  DesktopClerkFooterAction,
  DesktopClerkHeader,
  DesktopClerkInput,
  DesktopClerkPrimaryButton,
} from "./DesktopClerkCard";
import { DesktopClerkSignIn } from "./DesktopClerkSignIn";

type DesktopClerkScreen = "waitlist" | "sign-in";

// Mirrors Clerk's waitlist card and form, replacing its router transition with the desktop sign-in flow:
// https://github.com/clerk/javascript/blob/52861184477bee99c71552000311a289e91d3b59/packages/ui/src/components/Waitlist/index.tsx
// https://github.com/clerk/javascript/blob/52861184477bee99c71552000311a289e91d3b59/packages/ui/src/components/Waitlist/WaitlistForm.tsx
export function DesktopClerkWaitlist() {
  const [screen, setScreen] = useState<DesktopClerkScreen>("waitlist");

  if (screen === "sign-in") {
    return <DesktopClerkSignIn onJoinWaitlist={() => setScreen("waitlist")} />;
  }

  return <DesktopClerkWaitlistForm onSignIn={() => setScreen("sign-in")} />;
}

function DesktopClerkWaitlistForm({ onSignIn }: { onSignIn: () => void }) {
  const clerk = useClerk();
  const [emailAddress, setEmailAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [didJoin, setDidJoin] = useState(false);

  const submitWaitlist = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await clerk.joinWaitlist({ emailAddress });
      setDidJoin(true);
    } catch (cause) {
      setError(getClerkErrorMessage(cause));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (didJoin) {
    return (
      <DesktopClerkCard>
        <DesktopClerkHeader
          title="Thanks for joining the waitlist!"
          subtitle="We’ll be in touch when your spot is ready"
        />
      </DesktopClerkCard>
    );
  }

  return (
    <DesktopClerkCard
      footerAction={
        <DesktopClerkFooterAction actionLabel="Sign in" onAction={onSignIn}>
          Already have access?
        </DesktopClerkFooterAction>
      }
    >
      <DesktopClerkHeader
        title="Join the waitlist"
        subtitle="Enter your email address and we’ll let you know when your spot is ready"
      />
      <DesktopClerkAlert>{error}</DesktopClerkAlert>
      <form className="space-y-8 text-left" onSubmit={submitWaitlist}>
        <label className="block space-y-2" htmlFor="desktop-clerk-waitlist-email">
          <span className="text-sm font-semibold text-foreground">Email address</span>
          <DesktopClerkInput
            required
            autoComplete="email"
            id="desktop-clerk-waitlist-email"
            name="emailAddress"
            placeholder="Enter your email address"
            type="email"
            value={emailAddress}
            onChange={(event) => setEmailAddress(event.currentTarget.value)}
          />
        </label>
        <DesktopClerkPrimaryButton disabled={isSubmitting}>
          {isSubmitting ? "Joining the waitlist…" : "Join the waitlist"}
        </DesktopClerkPrimaryButton>
      </form>
    </DesktopClerkCard>
  );
}

function getClerkErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "errors" in error) {
    const errors = (error as { errors?: Array<{ longMessage?: unknown; message?: unknown }> })
      .errors;
    const firstError = errors?.[0];
    if (typeof firstError?.longMessage === "string") return firstError.longMessage;
    if (typeof firstError?.message === "string") return firstError.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return "Could not join the waitlist. Please try again.";
}
