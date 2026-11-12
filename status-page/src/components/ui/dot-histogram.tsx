"use client";

import { ChartScatter } from "@phosphor-icons/react";
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import { Panel, Shell, ShellHeader } from "@/components/ui/surface";
import { EASE_OUT, enter, exit } from "@/lib/motion-tokens";
import { cn } from "@/lib/utils";

export type DotHistogramBin = {
  from: number;
  to: number;
  count: number;
  flagged: boolean;
};

export type DotHistogramProps = {
  /** Raw samples, e.g. one response time per run. */
  values: number[];
  title: string;
  subtitle?: string;
  /** Samples at or above this value are flagged, e.g. a timeout. */
  threshold?: number;
  /** What a flagged sample means, shown in the tooltip and the footer. */
  thresholdLabel?: string;
  /** Number of columns. */
  bins?: number;
  /** What one sample is called, plural: "runs", "requests". */
  unit?: string;
  /** Formats axis labels and the tooltip. */
  format?: (value: number) => string;
  onSelect?: (bin: DotHistogramBin) => void;
  className?: string;
};

const STEP = 7;
const R = 2.4;
const MAX_ROWS = 18;
const AXIS = 22;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  // null until measured: the chart draws once at its real width, so entrance
  // animations don't tween from a guessed size.
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width ?? 520, width !== null] as const;
}

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
}

/**
 * A distribution drawn as dots: every column is a range, every dot a sample
 * (or a fixed group of samples when columns get tall). Dots stack outward from
 * the middle line, so the shape reads like a violin.
 */
export function DotHistogram({
  values,
  title,
  subtitle,
  threshold,
  thresholdLabel = "over limit",
  bins: binCount = 48,
  unit = "samples",
  format = (v) => `${+v.toFixed(2)}`,
  onSelect,
  className,
}: DotHistogramProps) {
  const reduce = useReducedMotion();
  const [ref, width, measured] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const [fromKeyboard, setFromKeyboard] = useState(false);

  const sorted = [...values].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const p95 = quantile(sorted, 0.95);
  const top = Math.max(sorted.at(-1) ?? 1, threshold ? threshold * 1.04 : 0) || 1;
  // Put the threshold on a column edge, so no column is half flagged.
  const size =
    threshold && threshold < top
      ? threshold / Math.max(1, Math.round((binCount * threshold) / top))
      : top / binCount;

  const bins: DotHistogramBin[] = Array.from({ length: binCount }, (_, i) => ({
    from: i * size,
    to: (i + 1) * size,
    count: 0,
    flagged: threshold !== undefined && i * size >= threshold - size / 1000,
  }));
  for (const v of values) bins[Math.min(Math.floor(v / size), binCount - 1)].count++;

  const peak = Math.max(1, ...bins.map((b) => b.count));
  // Tall columns switch to one dot per group so the chart keeps its height.
  const per = Math.max(1, Math.ceil(peak / MAX_ROWS));
  const rows = Math.ceil(peak / per);
  const plotH = Math.max(rows, 6) * STEP + STEP;
  const mid = plotH / 2;
  const colW = width / binCount;
  const x = (v: number) => (v / (binCount * size)) * width;
  const flagged = values.filter((v) => threshold !== undefined && v >= threshold).length;

  const activeBin = active === null ? null : bins[active];

  const select = (index: number | null, keyboard: boolean) => {
    setFromKeyboard(keyboard);
    setActive(index);
    if (index !== null) onSelect?.(bins[index]);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const filled = bins.flatMap((b, i) => (b.count ? [i] : []));
    if (!filled.length) return;
    const at = active === null ? -1 : filled.indexOf(active);
    const keys: Record<string, number> = {
      ArrowRight: at + 1,
      ArrowLeft: at === -1 ? filled.length - 1 : at - 1,
      Home: 0,
      End: filled.length - 1,
    };
    if (event.key === "Escape") return select(null, true);
    if (!(event.key in keys)) return;
    event.preventDefault();
    select(filled[(keys[event.key] + filled.length) % filled.length], true);
  };

  return (
    <MotionConfig reducedMotion="user">
      <Shell className={cn("max-w-2xl", className)}>
        <ShellHeader
          icon={ChartScatter}
          title={title}
          subtitle={subtitle}
          aside={
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {values.length.toLocaleString("en-US")} {unit}
            </span>
          }
        />
        <Panel className="p-4">
          <div
            ref={ref}
            tabIndex={0}
            role="group"
            aria-label={`${title}. Use arrow keys to read columns.`}
            onKeyDown={onKeyDown}
            onBlur={() => fromKeyboard && setActive(null)}
            className="relative rounded-xl outline-offset-4"
          >
            <svg
              key={measured ? "measured" : "guess"}
              visibility={measured ? undefined : "hidden"}
              role="img"
              aria-label={`${values.length} ${unit}, median ${format(median)}, p95 ${format(p95)}${threshold !== undefined ? `, ${flagged} ${thresholdLabel}` : ""}`}
              width={width}
              height={plotH + AXIS}
              className="block overflow-visible"
              onPointerLeave={() => select(null, false)}
            >
              {[0.25, 0.5, 0.75].map((t) => (
                <line
                  key={t}
                  x1={width * t}
                  x2={width * t}
                  y1={0}
                  y2={plotH}
                  className="stroke-foreground/10"
                  strokeDasharray="2 4"
                />
              ))}

              {activeBin && (
                <rect
                  x={active! * colW}
                  y={0}
                  width={colW}
                  height={plotH}
                  rx={Math.min(colW / 2, 6)}
                  className="fill-foreground/[0.06]"
                />
              )}

              {bins.map((bin, i) => {
                const dots = Math.ceil(bin.count / per);
                const cx = (i + 0.5) * colW;
                return (
                  <motion.g
                    key={i}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{
                      duration: 0.3,
                      ease: EASE_OUT,
                      delay: reduce ? 0 : i * 0.008,
                    }}
                  >
                    <g
                      className={cn(
                        "transition-opacity duration-150",
                        bin.flagged ? "fill-negative" : "fill-brand",
                        active !== null && active !== i && "opacity-45",
                        fromKeyboard && "duration-0",
                      )}
                    >
                      {Array.from({ length: dots }, (_, k) => {
                        const side = k % 2 ? 1 : -1;
                        const ring = Math.ceil(k / 2);
                        return (
                          <circle
                            key={k}
                            cx={cx}
                            cy={mid + side * ring * STEP}
                            r={Math.min(R, colW * 0.38)}
                          />
                        );
                      })}
                    </g>
                  </motion.g>
                );
              })}

              <line
                x1={x(median)}
                x2={x(median)}
                y1={2}
                y2={plotH - 2}
                strokeWidth={2}
                strokeLinecap="round"
                className="stroke-foreground/70"
              />
              {threshold !== undefined && (
                <line
                  x1={x(threshold)}
                  x2={x(threshold)}
                  y1={0}
                  y2={plotH}
                  strokeWidth={1.5}
                  strokeDasharray="3 3"
                  className="stroke-negative"
                />
              )}

              <g fontSize="10" className="fill-muted-foreground">
                <text x={0} y={plotH + 16}>
                  {format(0)}
                </text>
                <text
                  x={x(median)}
                  y={plotH + 16}
                  textAnchor="middle"
                  className="fill-foreground"
                >
                  {format(median)}
                </text>
                {threshold !== undefined && (
                  <text
                    x={x(threshold)}
                    y={plotH + 16}
                    textAnchor="end"
                    className="fill-negative"
                  >
                    {format(threshold)}
                  </text>
                )}
              </g>

              {bins.map((bin, i) => (
                <rect
                  key={i}
                  x={i * colW}
                  y={0}
                  width={colW}
                  height={plotH}
                  fill="transparent"
                  onPointerEnter={() => bin.count && select(i, false)}
                />
              ))}
            </svg>

            <AnimatePresence>
              {activeBin && (
                <motion.div
                  key="tip"
                  initial={fromKeyboard ? false : { opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1, transition: enter }}
                  exit={{ opacity: 0, transition: exit }}
                  className="pointer-events-none absolute top-0 z-10 rounded-xl bg-surface-raised px-3 py-2 text-xs"
                  style={{
                    left: Math.min(Math.max((active! + 0.5) * colW + 10, 0), width - 132),
                    transformOrigin: "top left",
                  }}
                >
                  <p className="text-muted-foreground">
                    {activeBin.flagged
                      ? thresholdLabel
                      : `${format(activeBin.from)}–${format(activeBin.to)}`}
                  </p>
                  <p className="font-mono text-foreground tabular-nums">
                    {activeBin.count} {unit} ·{" "}
                    {((activeBin.count / Math.max(values.length, 1)) * 100).toFixed(1)}%
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-3 w-0.5 rounded-full bg-foreground/70"
              />
              Median <span className="font-mono text-foreground">{format(median)}</span>
            </span>
            <span>
              p95 <span className="font-mono text-foreground">{format(p95)}</span>
            </span>
            {threshold !== undefined && (
              <span className="flex items-center gap-1.5">
                <span aria-hidden="true" className="size-2 rounded-full bg-negative" />
                {thresholdLabel}{" "}
                <span className="font-mono text-foreground tabular-nums">
                  {flagged} · {((flagged / Math.max(values.length, 1)) * 100).toFixed(1)}%
                </span>
              </span>
            )}
            {per > 1 && (
              <span className="ml-auto">
                1 dot = {per} {unit}
              </span>
            )}
          </div>

          <p role="status" aria-live="polite" className="sr-only">
            {fromKeyboard && activeBin
              ? `${format(activeBin.from)} to ${format(activeBin.to)}: ${activeBin.count} ${unit}`
              : ""}
          </p>
        </Panel>
      </Shell>
    </MotionConfig>
  );
}
