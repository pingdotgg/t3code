import { useContext, useRef, useState, type ComponentProps } from "react";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";
import {
  PullRequestReviewContext,
  type PullRequestReviewContextValue,
} from "./PullRequestReviewContext";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

export function PullRequestTextarea(props: ComponentProps<typeof Textarea>) {
  const context = useContext(PullRequestReviewContext);
  return context?.azure ? <AzureTextarea {...props} context={context} /> : <Textarea {...props} />;
}
function AzureTextarea({
  context,
  ref: forwardedRef,
  ...props
}: ComponentProps<typeof Textarea> & { context: PullRequestReviewContextValue }) {
  const [query, setQuery] = useState<{ start: number; end: number; text: string } | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  return (
    <div className="space-y-1">
      <Textarea
        {...props}
        ref={(node) => {
          input.current = node;
          if (typeof forwardedRef === "function") forwardedRef(node);
          else if (forwardedRef) forwardedRef.current = node;
        }}
        onChange={(event) => {
          props.onChange?.(event);
          const end = event.target.selectionStart;
          const match = /(?:^|\s)@([^\s<>@]*)$/.exec(event.target.value.slice(0, end));
          setQuery(match ? { start: end - match[1]!.length - 1, end, text: match[1]! } : null);
        }}
        onKeyDown={(event) => {
          if (query && event.key === "Escape") {
            event.stopPropagation();
            setQuery(null);
          }
          props.onKeyDown?.(event);
        }}
      />
      {query ? (
        <MentionChoices
          context={context}
          query={query.text}
          onSelect={(id) => {
            const element = input.current;
            if (!element) return;
            const next = `${element.value.slice(0, query.start)}@<${id}> ${element.value.slice(query.end)}`;
            const setter = Object.getOwnPropertyDescriptor(
              HTMLTextAreaElement.prototype,
              "value",
            )!.set!;
            setter.call(element, next);
            element.dispatchEvent(new Event("input", { bubbles: true }));
            setQuery(null);
            element.focus();
            element.setSelectionRange(query.start + id.length + 4, query.start + id.length + 4);
          }}
        />
      ) : null}
    </div>
  );
}
function MentionChoices({
  context,
  query,
  onSelect,
}: {
  context: PullRequestReviewContextValue;
  query: string;
  onSelect: (id: string) => void;
}) {
  const result = useEnvironmentQuery(
    pullRequestEnvironment.reviewerCandidates({
      environmentId: context.environmentId,
      input: context.reference,
    }),
  );
  const activity = useEnvironmentQuery(
    pullRequestEnvironment.activity({
      environmentId: context.environmentId,
      input: context.reference,
    }),
  );
  const people = new Map(
    (result.data?.candidates ?? []).map((person) => [
      person.id,
      { id: person.id, name: person.name ?? person.login, login: person.login },
    ]),
  );
  for (const [id, name] of Object.entries(activity.data?.identities ?? {}))
    if (!id.startsWith("000000")) people.set(id, { id, name, login: "" });
  const choices = [...people.values()]
    .filter((person) =>
      `${person.name} ${person.login}`.toLowerCase().includes(query.toLowerCase()),
    )
    .slice(0, 8);
  return (
    <div
      role="group"
      aria-label="Mention a person"
      className="flex flex-wrap gap-1 rounded border bg-background p-1"
    >
      {choices.map((person) => (
        <Button
          key={person.id}
          size="xs"
          variant="ghost"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(person.id)}
        >
          {person.name ?? person.login}
        </Button>
      ))}
      {choices.length === 0 ? (
        <span className="text-xs text-muted-foreground">
          {result.isPending
            ? "Loading people…"
            : result.error
              ? "People could not be loaded."
              : "No matching people."}
        </span>
      ) : null}
    </div>
  );
}
