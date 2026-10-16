import { type MouseEvent, type ReactNode, createContext, useCallback, useContext, useEffect, useState } from "react";

/** Three pages do not need a router library: history plus a context. */
const Nav = createContext<(to: string) => void>(() => undefined);

export function usePath(): [string, (to: string) => void] {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = useCallback((to: string) => {
    if (to !== window.location.pathname) window.history.pushState(null, "", to);
    setPath(to);
    window.scrollTo({ top: 0 });
  }, []);
  return [path, go];
}

export const NavProvider = Nav.Provider;

export function Link({ to, className, children, ...rest }: { to: string; className?: string; children: ReactNode; "aria-current"?: "page" | undefined }) {
  const go = useContext(Nav);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // New tab, new window and the like stay the browser's business.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(to);
  };
  return (
    <a href={to} className={className} onClick={onClick} {...rest}>
      {children}
    </a>
  );
}

export function txRoute(path: string): { domain: number; txHash: string } | null {
  const m = /^\/tx\/(\d+)\/(0x[0-9a-fA-F]{64})\/?$/.exec(path);
  return m ? { domain: Number(m[1]), txHash: m[2]! } : null;
}
