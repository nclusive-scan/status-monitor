// The status page's charts, built with DOM and SVG elements only: no innerHTML, no inline style attributes (the page's
// CSP has no 'unsafe-inline'; positions are set through the CSSOM, which CSP allows). Every chart carries a text summary
// for screen readers (role="img" + aria-label); the hover tooltip is a convenience on top, never the only way to a value.
import type { DayView, LatencyPoint } from "./model.ts";

const SVG = "http://www.w3.org/2000/svg";

function svg(tag: string, attributes: Record<string, string>): SVGElement {
  const element = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

const BAND_LABEL: Readonly<Record<DayView["band"], string>> = {
  ok: "Operational", degraded: "Degraded", down: "Outage", none: "No data",
};

const dayLabel = (date: string): string =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const pct = (value: number | null): string => (value === null ? "no data" : `${value.toFixed(value === 100 ? 0 : 2)}%`);
const ms = (value: number | null): string => (value === null ? "—" : `${String(Math.round(value))} ms`);

// ---- Tooltip: one floating element for the whole page ----

let tip: HTMLElement | null = null;

function tooltip(): HTMLElement {
  if (tip === null) {
    tip = document.createElement("div");
    tip.className = "tooltip";
    tip.setAttribute("aria-hidden", "true");
    tip.hidden = true;
    document.body.append(tip);
  }
  return tip;
}

function showTip(lines: readonly string[], x: number, y: number): void {
  const element = tooltip();
  element.replaceChildren(...lines.map((line, index) => {
    const row = document.createElement("div");
    row.className = index === 0 ? "tooltip-title" : "tooltip-row";
    row.textContent = line;
    return row;
  }));
  element.hidden = false;
  const width = element.offsetWidth;
  const left = Math.min(Math.max(8, x - width / 2), window.innerWidth - width - 8);
  // Fixed to the viewport, so it can never widen the page.
  element.style.transform = `translate(${String(Math.round(left))}px, ${String(Math.round(Math.max(8, y - element.offsetHeight - 10)))}px)`;
}

export function hideTip(): void {
  if (tip !== null) tip.hidden = true;
}

// ---- 30-day uptime bars ----

/** One bar per day, coloured by band, with the day and its uptime on hover. */
export function uptimeBars(name: string, days: readonly DayView[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "bars";
  const measured = days.filter((day) => day.uptime !== null);
  const bad = days.filter((day) => day.band === "down").length;
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", measured.length === 0
    ? `${name}: no uptime history yet`
    : `${name}: ${String(measured.length)} of the last ${String(days.length)} days measured, ${String(bad)} with an outage`);
  for (const day of days) {
    const bar = document.createElement("span");
    bar.className = "bar";
    bar.dataset["band"] = day.band;
    bar.addEventListener("pointerenter", () => {
      const box = bar.getBoundingClientRect();
      showTip([dayLabel(day.date), `${BAND_LABEL[day.band]} · ${pct(day.uptime)}`], box.left + box.width / 2, box.top);
    });
    bar.addEventListener("pointerleave", hideTip);
    wrap.append(bar);
  }
  return wrap;
}

// ---- 24-hour response time ----

const W = 320;
const H = 72;
const PAD = 4;

const hourLabel = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** An area chart of the hourly average, a hover crosshair and the hour's average and worst. */
export function latencyChart(name: string, points: readonly LatencyPoint[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "spark";
  const values = points.map((point) => point.avgMs);
  const known = values.filter((value): value is number => value !== null);
  if (known.length === 0) {
    wrap.classList.add("spark-empty");
    wrap.textContent = "No response times yet";
    return wrap;
  }
  const peak = Math.max(...known);
  const top = peak > 0 ? peak * 1.15 : 1;
  const step = points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0;
  const x = (index: number): number => PAD + index * step;
  const y = (value: number): number => H - PAD - (value / top) * (H - PAD * 2);
  // Gaps (hours with nothing measured) break the line instead of drawing a false slope across them.
  let line = "";
  let area = "";
  const singles: { index: number; value: number }[] = [];
  let run: { index: number; value: number }[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const first = run[0];
    const last = run.at(-1);
    if (first === undefined || last === undefined) return;
    // A lone measured hour has no line to draw: it shows as a dot instead.
    if (run.length === 1) singles.push(first);
    const path = run.map((point, offset) => `${offset === 0 ? "M" : "L"}${x(point.index).toFixed(1)},${y(point.value).toFixed(1)}`).join("");
    line += path;
    area += `${path}L${x(last.index).toFixed(1)},${String(H - PAD)}L${x(first.index).toFixed(1)},${String(H - PAD)}Z`;
    run = [];
  };
  values.forEach((value, index) => {
    if (value === null) flush();
    else run.push({ index, value });
  });
  flush();

  const chart = svg("svg", { viewBox: `0 0 ${String(W)} ${String(H)}`, preserveAspectRatio: "none", class: "spark-svg", "aria-hidden": "true" });
  chart.append(
    svg("line", { x1: "0", x2: String(W), y1: String(H - PAD), y2: String(H - PAD), class: "spark-base" }),
    svg("path", { d: area, class: "spark-area" }),
    svg("path", { d: line, class: "spark-line", "vector-effect": "non-scaling-stroke" }),
  );
  for (const point of singles) {
    chart.append(svg("circle", { cx: x(point.index).toFixed(1), cy: y(point.value).toFixed(1), r: "3", class: "spark-point" }));
  }
  const cross = svg("line", { x1: "0", x2: "0", y1: "0", y2: String(H), class: "spark-cross", "vector-effect": "non-scaling-stroke" });
  const dot = svg("circle", { r: "3.5", class: "spark-dot" });
  cross.setAttribute("visibility", "hidden");
  dot.setAttribute("visibility", "hidden");
  chart.append(cross, dot);
  wrap.append(chart);

  const average = known.reduce((a, b) => a + b, 0) / known.length;
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", `${name}: average response ${ms(average)} over the last 24 hours, slowest hour ${ms(Math.max(...known))}`);
  wrap.addEventListener("pointermove", (event) => {
    const box = chart.getBoundingClientRect();
    const index = Math.round(((event.clientX - box.left) / box.width * W - PAD) / (step === 0 ? 1 : step));
    const point = points[Math.min(points.length - 1, Math.max(0, index))];
    if (point === undefined) return;
    const at = Math.min(points.length - 1, Math.max(0, index));
    cross.setAttribute("x1", x(at).toFixed(1));
    cross.setAttribute("x2", x(at).toFixed(1));
    cross.setAttribute("visibility", "visible");
    if (point.avgMs === null) dot.setAttribute("visibility", "hidden");
    else {
      dot.setAttribute("cx", x(at).toFixed(1));
      dot.setAttribute("cy", y(point.avgMs).toFixed(1));
      dot.setAttribute("visibility", "visible");
    }
    const screenX = box.left + (x(at) / W) * box.width;
    showTip([hourLabel(point.hour), `Average ${ms(point.avgMs)}`, `Slowest ${ms(point.maxMs)}`], screenX, box.top);
  });
  wrap.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    hideTip();
  });
  return wrap;
}
