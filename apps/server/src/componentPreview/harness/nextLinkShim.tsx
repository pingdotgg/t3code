import * as React from "react";

type AnchorProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string | URL;
  prefetch?: boolean | null;
  replace?: boolean | null;
  scroll?: boolean | null;
  shallow?: boolean | null;
};

export default function Link(props: React.PropsWithChildren<AnchorProps>) {
  const {
    children,
    href,
    prefetch: _prefetch,
    replace: _replace,
    scroll: _scroll,
    shallow: _shallow,
    ...rest
  } = props;
  return (
    <a href={typeof href === "string" ? href : href.toString()} {...rest}>
      {children}
    </a>
  );
}
