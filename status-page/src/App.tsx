// The page frame: the masthead (brand, Status / Operator view switch, theme toggle), the public status and the
// key-gated operator view. The public data is polled every 30 s; the operator view loads on demand.
import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { IconButton } from "@/components/ui/action-button";
import { Segmented } from "@/components/ui/segmented-control";
import type { Summary } from "./model.ts";
import { isPublicStatus, siteName, summarize, unavailable } from "./model.ts";
import { short } from "./format.ts";
import { CardSkeleton } from "@/components/ui/loading-skeleton";
import { PublicView } from "./PublicView.tsx";
import type { Theme } from "./theme.ts";
import { applyTheme, saveTheme, storedTheme } from "./theme.ts";

export const REFRESH_MS = 30_000;
/** Loaded only when someone opens it, so the public page does not download the operator view. */
const OperatorView = lazy(async () => ({ default: (await import("./OperatorView.tsx")).OperatorView }));
type View = "public" | "private";

/** Loads /api/status now and every REFRESH_MS. A failed load keeps names but claims no status (unavailable()). */
function usePublicStatus(): { summary: Summary | null; brand: string; loadedAt: number | null } {
  const [state, setState] = useState<{ summary: Summary | null; brand: string; loadedAt: number | null }>({ summary: null, brand: "Status", loadedAt: null });
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
        if (!cancelled) setState({ summary, brand: siteName(data.brand), loadedAt: Date.now() });
      } catch {
        if (!cancelled) setState((previous) => ({ ...previous, summary: unavailable(lastGood.current), loadedAt: Date.now() }));
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return state;
}

/** The brand names the page: the title and the description. The HTML holds the neutral fallback ("Status"). */
function useBrand(name: string): void {
  useEffect(() => {
    if (document.title !== name) document.title = name;
    const brand = name.endsWith(" status") ? name.slice(0, -" status".length) : null;
    document.querySelector('meta[name="description"]')?.setAttribute("content", brand === null ? "Live service status." : `Live service status for ${brand}.`);
  }, [name]);
}

export function App(): React.JSX.Element {
  const { summary, brand, loadedAt } = usePublicStatus();
  const [view, setView] = useState<View>("public");
  const [theme, setTheme] = useState<Theme>(() => applyTheme(storedTheme()));
  const main = useRef<HTMLElement>(null);
  useBrand(brand);

  const toggleTheme = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    saveTheme(next);
    setTheme(applyTheme(next));
  }, [theme]);

  const switchView = (next: View): void => {
    setView(next);
    main.current?.focus();
  };

  const name = brand.endsWith(" status") ? brand.slice(0, -" status".length) : brand;
  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-surface focus:px-4 focus:py-2 focus:text-sm">
        Skip to status
      </a>
      <header className="sticky top-0 z-30 border-b border-foreground/[0.06] bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
          <p className="flex min-w-0 items-center gap-2.5 text-[0.9375rem] font-semibold tracking-tight">
            <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-lg bg-foreground text-background">
              <span className="size-2 rounded-full bg-positive" />
            </span>
            <span className="truncate">
              {name}
              {name === brand ? null : <span className="font-normal text-muted-foreground"> status</span>}
            </span>
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <Segmented<View>
              label="View"
              value={view}
              onValueChange={switchView}
              options={[
                { value: "public", label: "Status" },
                { value: "private", label: "Operator" },
              ]}
            />
            <IconButton
              icon={theme === "dark" ? SunIcon : MoonIcon}
              label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              onClick={toggleTheme}
            />
          </div>
        </div>
      </header>
      <main id="main" ref={main} tabIndex={-1} className="mx-auto max-w-5xl px-4 pt-6 pb-16 outline-none sm:px-6 sm:pt-10">
        {view === "public" ? <PublicView summary={summary} loadedAt={loadedAt} /> : (
          <Suspense fallback={<CardSkeleton className="mx-auto max-w-md" />}><OperatorView /></Suspense>
        )}
      </main>
    </div>
  );
}
