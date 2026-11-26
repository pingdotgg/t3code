// Fork: Kaluwa's Extensions page. Sign-ins and failures, grouped by subscription.
import { T, useGT } from "gt-react";
import { ChevronRightIcon, TriangleAlertIcon } from "lucide-react";

import { Button } from "../ui/button";
import { useExtensions } from "./extensionsContext";
import { subscriptionAttention } from "./extensionsModel";
import { AllClear, SectionCard, SubscriptionIcon, useKindLabels } from "./extensionsParts";
import { AttentionRow } from "./ExtensionsSubscriptionView";

export function ExtensionsAttentionView() {
  const gt = useGT();
  const kinds = useKindLabels();
  const { list, entries, openView } = useExtensions();
  const groups = list.subscriptions
    .map((subscription) => ({
      subscription,
      items: subscriptionAttention(entries, subscription.instanceId),
    }))
    .filter((group) => group.items.length > 0 || group.subscription.issues.length > 0);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">
          <T>Needs attention</T>
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          <T>
            Sign-ins and failures, grouped by subscription. A sign-in on one subscription never
            carries over to another.
          </T>
        </p>
      </header>
      {groups.length === 0 ? (
        <AllClear>
          {gt("All clear. Nothing is failing or waiting for a sign-in on any subscription.")}
        </AllClear>
      ) : (
        groups.map(({ subscription, items }) => (
          <section key={subscription.instanceId} className="flex flex-col gap-2">
            <div className="flex items-center gap-2.5">
              <SubscriptionIcon subscription={subscription} />
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
                {subscription.displayName}
              </h2>
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  openView({ page: "subscription", instanceId: subscription.instanceId })
                }
              >
                <T>Open subscription</T>
                <ChevronRightIcon />
              </Button>
            </div>
            <SectionCard>
              {subscription.issues.map((issue) => (
                <p
                  key={`${issue.kind}:${issue.message}`}
                  className="flex items-start gap-2.5 px-3 py-2.5 text-xs text-warning-foreground"
                >
                  <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  <span className="wrap-anywhere">
                    {gt("{kind} could not be read: {message}", {
                      kind: kinds.plural(issue.kind),
                      message: issue.message,
                    })}
                  </span>
                </p>
              ))}
              {items.map((item) => (
                <AttentionRow key={item.entry.key} item={item} />
              ))}
            </SectionCard>
          </section>
        ))
      )}
    </div>
  );
}
