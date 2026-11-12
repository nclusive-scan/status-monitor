// Light or dark: the OS setting until the viewer picks one; the choice is kept on this device only (localStorage, which
// may be blocked: then it lasts for this page view). Dark mode is the .dark class on <html>, which the tokens key off.
export type Theme = "light" | "dark";
const THEME_STORAGE = "status-monitor-theme";

export function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export const systemTheme = (): Theme => (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

export function applyTheme(theme: Theme | null): Theme {
  const effective = theme ?? systemTheme();
  document.documentElement.classList.toggle("dark", effective === "dark");
  return effective;
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE, theme);
  } catch {
    // Storage blocked: the choice lasts for this page view.
  }
}
