/**
 * A ~60-line history-API router — deliberately dependency-free so the
 * example stays a *plain* React SPA. Deep links work because the site is
 * deployed with `assets: { notFoundHandling: "single-page-application" }`.
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

interface RouterState {
  readonly path: string;
  readonly navigate: (to: string) => void;
}

const RouterContext = createContext<RouterState>({
  path: "/",
  navigate: () => {},
});

export const Router = ({ children }: { children: ReactNode }) => {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (to: string) => {
    history.pushState(null, "", to);
    setPath(new URL(to, location.origin).pathname);
    window.scrollTo(0, 0);
  };
  return (
    <RouterContext.Provider value={{ path, navigate }}>
      {children}
    </RouterContext.Provider>
  );
};

export const useRouter = () => useContext(RouterContext);

export const Link = ({
  to,
  className,
  children,
  title,
}: {
  to: string;
  className?: string;
  children: ReactNode;
  title?: string;
}) => {
  const { navigate } = useRouter();
  const onClick = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick} className={className} title={title}>
      {children}
    </a>
  );
};

/** Splits a pathname into decoded segments. */
export const segments = (path: string): string[] =>
  path.split("/").filter(Boolean).map(decodeURIComponent);

/** Builds a pathname from raw segments, encoding each. */
export const href = (...parts: string[]): string =>
  "/" + parts.map(encodeURIComponent).join("/");
