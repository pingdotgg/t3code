import { Trans } from "@palamedes/react/macro";
import type { ReactNode } from "react";

export function DraftHeroProjectHeading({ children }: { children: ReactNode }) {
  return (
    <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl [@media(max-height:28rem)]:text-[0px] [@media(max-height:28rem)]:leading-none">
      <Trans>
        What should we build in{" "}
        <span className="inline-flex min-w-0 max-w-full items-baseline align-baseline font-medium [@media(max-height:28rem)]:text-base [@media(max-height:28rem)]:tracking-normal">
          {children}
        </span>
        ?
      </Trans>
    </h1>
  );
}
