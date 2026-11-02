import { type ReactNode, useState } from "react";

export function FaviconImage(props: {
  sources: ReadonlyArray<string | null | undefined>;
  fallback: ReactNode;
  className?: string | undefined;
}) {
  const sources = props.sources.filter((source): source is string => Boolean(source));
  return (
    <FaviconImageAttempt
      key={sources.join("\0")}
      sources={sources}
      fallback={props.fallback}
      className={props.className}
    />
  );
}

function FaviconImageAttempt(props: {
  sources: ReadonlyArray<string>;
  fallback: ReactNode;
  className?: string | undefined;
}) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const source = props.sources.find((candidate) => !failed.has(candidate));
  if (!source) return props.fallback;
  return (
    <img
      src={source}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={props.className}
      onError={() => setFailed((current) => new Set(current).add(source))}
    />
  );
}
