import type { ReactNode } from "react";
import { AppText } from "../../components/AppText";

export function PullRequestSectionHeading({ children }: { readonly children: ReactNode }) {
  return <AppText className="text-base font-t3-semibold">{children}</AppText>;
}
