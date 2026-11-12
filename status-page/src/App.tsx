// The page frame: the masthead (brand and theme), the public status at "/" and the operator view at "/operator" (its own
// path, so an operator can put Cloudflare Access sign-in in front of it). The public data is polled every 30 s.
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Moon, Sun } from "./icons/index.tsx";
import type { Summary } from "./model.ts";
import { isPublicStatus, siteName, summarize, unavailable } from "./model.ts";
import { short } from "./format.ts";
import { PublicView } from "./PublicView.tsx";
import type { Theme } from "./theme.ts";
import { applyTheme, saveTheme, storedTheme } from "./theme.ts";

export const REFRESH_MS = 30_000;
/** Loaded only on /operator, so the public page does not download the operator view. */
const OperatorView = lazy(async () => ({ default: (await import("./OperatorView.tsx")).OperatorView }));

const isOperatorPath = (): boolean => window.location.pathname.replace(/\/+$/, "") === "/operator";

/** Loads /api/status now and every REFRESH_MS. A failed load keeps names but claims no status (unavailable()). */
function usePublicStatus(poll: boolean): { summary: Summary | null; brand: string } {
  const [state, setState] = useState<{ summary: Summary | null; brand: string }>({ summary: null, brand: "Status" });
  const lastGood = useRef<Summary | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await fetch("/api/status", { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(String(response.status));
        const data: unknown = await response.json();
        if (!isPublicStatus(data)) throw new Error("shape");
        const summary = summarize(data, short);
        lastGood.current = summary;
        if (!cancelled) setState({ summary, brand: siteName(data.brand) });
      } catch {
        if (!cancelled) setState((previous) => ({ ...previous, summary: unavailable(lastGood.current) }));
      }
    };
    void load();
    const timer = poll ? setInterval(() => void load(), REFRESH_MS) : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [poll]);
  return state;
}

/** The brand names the page: the title and the description. The HTML holds the neutral fallback ("Status"). */
function useBrand(name: string, operator: boolean): void {
  useEffect(() => {
    const title = operator ? `Operator · ${name}` : name;
    if (document.title !== title) document.title = title;
    const brand = name.endsWith(" status") ? name.slice(0, -" status".length) : null;
    document.querySelector('meta[name="description"]')?.setAttribute("content", brand === null ? "Live service status." : `Live service status for ${brand}.`);
  }, [name, operator]);
}

export function App(): React.JSX.Element {
  const operator = isOperatorPath();
  // The operator page loads the brand once; only the public page keeps polling.
  const { summary, brand } = usePublicStatus(!operator);
  const [theme, setTheme] = useState<Theme>(() => applyTheme(storedTheme()));
  useBrand(brand, operator);

  const toggleTheme = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    saveTheme(next);
    setTheme(applyTheme(next));
  }, [theme]);

  const name = brand.endsWith(" status") ? brand.slice(0, -" status".length) : brand;
  const width = operator ? "max-w-5xl" : "max-w-3xl";
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow">
        Skip to content
      </a>
      <header className="border-b">
        <div className={`mx-auto flex h-14 ${width} items-center justify-between gap-3 px-4`}>
          <a href="/" className="flex min-w-0 items-center gap-2.5 rounded-md text-[0.9375rem] font-semibold tracking-tight">
            <img src="/brand/logo.svg" alt="" className="h-5 w-auto dark:hidden" />
            <img src="/brand/logo-dark.svg" alt="" className="hidden h-5 w-auto dark:block" />
            <span className="truncate">
              {name}
              {name === brand ? null : <span className="font-normal text-muted-foreground"> Status</span>}
            </span>
          </a>
          <Button variant="ghost" size="icon-sm" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}>
            {theme === "dark" ? <Sun /> : <Moon />}
          </Button>
        </div>
      </header>
      <main id="main" tabIndex={-1} className={`mx-auto w-full ${width} flex-1 px-4 py-10 outline-none sm:py-14`}>
        {operator ? (
          <Suspense fallback={<Skeleton className="mx-auto h-48 max-w-sm" />}><OperatorView /></Suspense>
        ) : (
          <PublicView summary={summary} />
        )}
      </main>
      <footer className="border-t">
        <div className={`mx-auto flex ${width} flex-wrap items-center gap-x-5 gap-y-2 px-4 py-6 text-xs text-muted-foreground`}>
          {operator ? (
            <a href="/" className="mr-auto inline-flex items-center gap-1.5 hover:text-foreground"><ArrowLeft className="size-3.5" />Back to status</a>
          ) : (
            <>
              <span className="mr-auto">Times are shown in your time zone.</span>
              <a href="/operator" className="hover:text-foreground">Staff sign-in</a>
            </>
          )}
          <a href="https://github.com/nclusive-scan/status-monitor" className="hover:text-foreground">Open-source status monitor</a>
        </div>
      </footer>
    </div>
  );
}
