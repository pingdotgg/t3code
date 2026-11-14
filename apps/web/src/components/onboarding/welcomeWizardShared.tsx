import type { ReactNode } from "react";

export const PRIMARY_AGENT_DRIVERS = ["codex", "claudeAgent"] as const;

export type OnboardingAgentDriver = (typeof PRIMARY_AGENT_DRIVERS)[number];

export function StepShell({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
}) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      {description ? (
        <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </>
  );
}
