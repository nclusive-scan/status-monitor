"use client";

import { ChartBar, ChartDonut, ChartLine, ChartLineUp } from "@phosphor-icons/react";
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "motion/react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { RollingNumber } from "@/components/ui/rolling-number";
import { Panel, Shell, ShellHeader } from "@/components/ui/surface";
import { EASE_IN_OUT, EASE_OUT, enter, exit } from "@/lib/motion-tokens";
import { cn } from "@/lib/utils";

export type ChartType = "bar" | "line" | "area" | "donut";

export type ChartSeries = {
  id: string;
  label: string;
  /** One value per label. For a donut, a slice is the sum of its values. */
  values: number[];
  /** Any CSS color. Defaults to the palette by position, so a series keeps its color. */
  color?: string;
};

export type ChartCardProps = {
  data: { labels: string[]; series: ChartSeries[] };
  type?: ChartType;
  title: string;
  subtitle?: string;
  /** Headline in the header, e.g. a total. Rolls when it changes. */
  total?: string;
  /** Formats values in ticks and the tooltip. */
  format?: (value: number) => string;
  /** Stripe the last point (bars) — e.g. a period that isn't over yet. */
  partialLast?: boolean;
  onSelect?: (index: number) => void;
  className?: string;
};

// Validated for both themes: blue, teal, purple, ochre.
const palette = ["var(--brand)", "#1a9e8c", "#bf5af2", "#b8862b"];
const icons = { bar: ChartBar, line: ChartLine, area: ChartLineUp, donut: ChartDonut };
const H = 200;
const PAD = { top: 8, right: 8, bottom: 22, left: 36 };

const compact = (n: number) =>
  Math.abs(n) >= 1_000_000
    ? `${+(n / 1_000_000).toFixed(1)}M`
    : Math.abs(n) >= 1000
      ? `${+(n / 1000).toFixed(1)}k`
      : `${+n.toFixed(1)}`;

/** A round step (1, 2, 2.5 or 5 × 10ⁿ) so about four ticks cover the value. */
function niceScale(value: number) {
  if (value <= 0) return { max: 1, step: 0.25 };
  const raw = value / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return { max: Math.ceil(value / step - 1e-9) * step, step };
}

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
  return [ref, width ?? 560, width !== null] as const;
}

export function ChartCard({
  data,
  type = "bar",
  title,
  subtitle,
  total,
  format = compact,
  partialLast = false,
  onSelect,
  className,
}: ChartCardProps) {
  const uid = useId().replace(/:/g, "");
  const reduce = useReducedMotion();
  const [ref, width, measured] = useWidth();
  const [hidden, setHidden] = useState<string[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [fromKeyboard, setFromKeyboard] = useState(false);

  const series = data.series.map((s, i) => ({
    ...s,
    color: s.color ?? palette[i % palette.length],
  }));
  const visible = series.filter((s) => !hidden.includes(s.id));
  const donut = type === "donut";
  const count = donut ? visible.length : data.labels.length;

  // A toggle can remove the point the selection pointed at.
  const activeIndex = active !== null && active < count ? active : null;

  const select = (index: number | null, keyboard: boolean) => {
    setFromKeyboard(keyboard);
    setActive(index);
    if (index !== null) onSelect?.(index);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!count) return;
    const keys: Record<string, number> = {
      ArrowRight: (activeIndex ?? -1) + 1,
      ArrowLeft: (activeIndex ?? count) - 1,
      Home: 0,
      End: count - 1,
    };
    if (!(event.key in keys)) {
      if (event.key === "Escape") select(null, true);
      return;
    }
    event.preventDefault();
    select((keys[event.key] + count) % count, true);
  };

  const innerW = Math.max(width - PAD.left - PAD.right, 40);
  const innerH = H - PAD.top - PAD.bottom;
  const { max, step } = niceScale(Math.max(0, ...visible.flatMap((s) => s.values)));
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const band = innerW / Math.max(data.labels.length, 1);
  const x = (i: number) =>
    PAD.left +
    (type === "bar"
      ? band * (i + 0.5)
      : (innerW * i) / Math.max(data.labels.length - 1, 1));
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const labelEvery = Math.ceil(data.labels.length / Math.max(Math.floor(innerW / 56), 1));

  const summary = donut
    ? visible.map((s) => `${s.label} ${format(sum(s.values))}`).join(", ")
    : `${type} chart of ${visible.map((s) => s.label).join(", ")} over ${data.labels[0]} to ${data.labels.at(-1)}`;

  const tooltip =
    activeIndex === null ? null : donut ? (
      <TooltipRows
        title={visible[activeIndex]?.label}
        rows={[
          {
            color: visible[activeIndex]?.color,
            label: "Total",
            value: format(sum(visible[activeIndex]?.values ?? [])),
          },
        ]}
      />
    ) : (
      <TooltipRows
        title={data.labels[activeIndex]}
        rows={visible.map((s) => ({
          color: s.color,
          label: s.label,
          value: format(s.values[activeIndex] ?? 0),
        }))}
      />
    );

  return (
    <MotionConfig reducedMotion="user">
      <Shell className={cn("max-w-2xl", className)}>
        <ShellHeader
          icon={icons[type]}
          title={title}
          subtitle={subtitle}
          aside={
            total && (
              <RollingNumber
                value={total}
                className="text-xl font-medium tracking-tight"
              />
            )
          }
        />
        <Panel className="p-4">
          {series.length > 1 && (
            <div role="group" aria-label="Series" className="mb-3 flex flex-wrap gap-1.5">
              {series.map((s) => {
                const on = !hidden.includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setHidden((h) =>
                        on
                          ? visible.length > 1
                            ? [...h, s.id]
                            : h
                          : h.filter((id) => id !== s.id),
                      )
                    }
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs transition-[background-color,color,opacity,scale] duration-150 ease-out active:scale-[0.97]",
                      on
                        ? "bg-foreground/[0.06] text-foreground"
                        : "text-muted-foreground opacity-60 hover:opacity-100",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="size-2.5 rounded-[3px]"
                      style={{
                        background: on ? s.color : "transparent",
                        boxShadow: on ? undefined : `inset 0 0 0 1.5px ${s.color}`,
                      }}
                    />
                    {s.label}
                  </button>
                );
              })}
            </div>
          )}

          <div
            ref={ref}
            tabIndex={0}
            role="group"
            aria-label={`${title}. Use arrow keys to read values.`}
            onKeyDown={onKeyDown}
            onBlur={() => fromKeyboard && setActive(null)}
            className="relative rounded-xl outline-offset-4"
          >
            <svg
              key={measured ? "measured" : "guess"}
              visibility={measured ? undefined : "hidden"}
              role="img"
              aria-label={summary}
              width={width}
              height={donut ? 220 : H}
              className="block overflow-visible"
              onPointerLeave={() => select(null, false)}
            >
              <defs>
                <clipPath id={`${uid}-reveal`}>
                  <motion.rect
                    x={0}
                    y={0}
                    height={H}
                    initial={{ width: 0 }}
                    animate={{ width }}
                    transition={{ duration: 0.8, ease: EASE_OUT }}
                  />
                </clipPath>
                {series.map((s, i) => (
                  <linearGradient
                    key={s.id}
                    id={`${uid}-fill-${i}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0%" stopColor={s.color} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
                  </linearGradient>
                ))}
                {series.map((s, i) => (
                  <pattern
                    key={s.id}
                    id={`${uid}-stripe-${i}`}
                    width="7"
                    height="7"
                    patternUnits="userSpaceOnUse"
                    patternTransform="rotate(45)"
                  >
                    <rect width="7" height="7" fill={s.color} />
                    <rect width="3" height="7" fill="white" opacity="0.22" />
                  </pattern>
                ))}
              </defs>

              {donut ? (
                <Donut
                  series={visible}
                  width={width}
                  activeIndex={activeIndex}
                  instant={fromKeyboard || !!reduce}
                  onHover={(i) => select(i, false)}
                  format={format}
                />
              ) : (
                <>
                  {ticks.map((t) => (
                    <g key={t} className="text-muted-foreground">
                      <line
                        x1={PAD.left}
                        x2={width - PAD.right}
                        y1={y(t)}
                        y2={y(t)}
                        stroke="currentColor"
                        strokeOpacity={t === 0 ? 0.18 : 0.08}
                      />
                      <text
                        x={PAD.left - 8}
                        y={y(t)}
                        dy="0.32em"
                        textAnchor="end"
                        fontSize="10"
                        fill="currentColor"
                      >
                        {format(t)}
                      </text>
                    </g>
                  ))}
                  {data.labels.map((label, i) =>
                    i % labelEvery === 0 ? (
                      <text
                        key={label}
                        x={x(i)}
                        y={H - 6}
                        textAnchor="middle"
                        fontSize="10"
                        className="fill-muted-foreground"
                      >
                        {label}
                      </text>
                    ) : null,
                  )}

                  {type === "bar"
                    ? data.labels.map((_, i) => {
                        const gap = 2;
                        const groupW = Math.min(
                          band * 0.72,
                          18 * visible.length + gap * (visible.length - 1),
                        );
                        const barW =
                          (groupW - gap * (visible.length - 1)) /
                          Math.max(visible.length, 1);
                        return visible.map((s, j) => {
                          const v = s.values[i] ?? 0;
                          const index = series.findIndex((t) => t.id === s.id);
                          return (
                            <motion.rect
                              key={`${s.id}-${i}`}
                              x={x(i) - groupW / 2 + j * (barW + gap)}
                              width={barW}
                              rx={3}
                              initial={{ y: y(0), height: 0 }}
                              animate={{ y: y(v), height: y(0) - y(v) }}
                              transition={{
                                duration: 0.5,
                                ease: EASE_OUT,
                                delay: reduce ? 0 : i * 0.03,
                              }}
                              fill={
                                partialLast && i === data.labels.length - 1
                                  ? `url(#${uid}-stripe-${index})`
                                  : s.color
                              }
                              opacity={
                                activeIndex === null || activeIndex === i ? 1 : 0.4
                              }
                              style={{ transition: "opacity 150ms ease-out" }}
                            />
                          );
                        });
                      })
                    : visible.map((s) => {
                        const points = s.values.map((v, i) => [x(i), y(v)] as const);
                        const line = points
                          .map(([px, py], i) => `${i ? "L" : "M"}${px},${py}`)
                          .join("");
                        const area = `${line}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z`;
                        return (
                          <g key={s.id}>
                            {type === "area" && (
                              // Revealed left to right with the line, so the fill
                              // never fades in ahead of the stroke that bounds it.
                              <g clipPath={`url(#${uid}-reveal)`}>
                                <motion.path
                                  initial={{ d: area }}
                                  animate={{ d: area }}
                                  transition={{ duration: 0.4, ease: EASE_IN_OUT }}
                                  fill={`url(#${uid}-fill-${series.findIndex((t) => t.id === s.id)})`}
                                />
                              </g>
                            )}
                            <motion.path
                              initial={{ pathLength: 0, d: line }}
                              animate={{ pathLength: 1, d: line }}
                              transition={{
                                pathLength: { duration: 0.8, ease: EASE_OUT },
                                d: { duration: 0.4, ease: EASE_IN_OUT },
                              }}
                              fill="none"
                              stroke={s.color}
                              strokeWidth={2}
                              strokeLinejoin="round"
                              strokeLinecap="round"
                            />
                          </g>
                        );
                      })}

                  {type !== "bar" && activeIndex !== null && (
                    <g>
                      <line
                        x1={x(activeIndex)}
                        x2={x(activeIndex)}
                        y1={PAD.top}
                        y2={y(0)}
                        stroke="currentColor"
                        strokeOpacity={0.25}
                        className="text-foreground"
                      />
                      {visible.map((s) => (
                        <circle
                          key={s.id}
                          cx={x(activeIndex)}
                          cy={y(s.values[activeIndex] ?? 0)}
                          r={4.5}
                          fill={s.color}
                          stroke="var(--surface-inset)"
                          strokeWidth={2}
                        />
                      ))}
                    </g>
                  )}

                  {/* Hit areas, wider than the marks. */}
                  {data.labels.map((label, i) => (
                    <rect
                      key={label}
                      x={
                        type === "bar"
                          ? x(i) - band / 2
                          : x(i) - innerW / Math.max(data.labels.length - 1, 1) / 2
                      }
                      y={PAD.top}
                      width={
                        type === "bar"
                          ? band
                          : innerW / Math.max(data.labels.length - 1, 1)
                      }
                      height={innerH}
                      fill="transparent"
                      onPointerEnter={() => select(i, false)}
                      onClick={() => select(i, false)}
                    />
                  ))}
                </>
              )}
            </svg>

            <AnimatePresence>
              {activeIndex !== null && tooltip && (
                <motion.div
                  key="tip"
                  initial={fromKeyboard ? false : { opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1, transition: enter }}
                  exit={{ opacity: 0, transition: exit }}
                  className="pointer-events-none absolute top-0 z-10 min-w-36 rounded-xl bg-surface-raised px-3 py-2 text-xs"
                  style={
                    donut
                      ? { left: "50%", transform: "translateX(-50%)" }
                      : {
                          left: Math.min(Math.max(x(activeIndex) - 72, 0), width - 160),
                          transformOrigin: "top center",
                        }
                  }
                >
                  {tooltip}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <table className="sr-only">
            <caption>{title}</caption>
            <thead>
              <tr>
                <th scope="col">{donut ? "Series" : "Label"}</th>
                {donut ? (
                  <th scope="col">Total</th>
                ) : (
                  visible.map((s) => (
                    <th key={s.id} scope="col">
                      {s.label}
                    </th>
                  ))
                )}
              </tr>
            </thead>
            <tbody>
              {donut
                ? visible.map((s) => (
                    <tr key={s.id}>
                      <th scope="row">{s.label}</th>
                      <td>{format(sum(s.values))}</td>
                    </tr>
                  ))
                : data.labels.map((label, i) => (
                    <tr key={label}>
                      <th scope="row">{label}</th>
                      {visible.map((s) => (
                        <td key={s.id}>{format(s.values[i] ?? 0)}</td>
                      ))}
                    </tr>
                  ))}
            </tbody>
          </table>
          <p role="status" aria-live="polite" className="sr-only">
            {fromKeyboard && activeIndex !== null
              ? donut
                ? `${visible[activeIndex]?.label}: ${format(sum(visible[activeIndex]?.values ?? []))}`
                : `${data.labels[activeIndex]}: ${visible.map((s) => `${s.label} ${format(s.values[activeIndex] ?? 0)}`).join(", ")}`
              : ""}
          </p>
        </Panel>
      </Shell>
    </MotionConfig>
  );
}

const sum = (values: number[]) => values.reduce((n, v) => n + v, 0);

function TooltipRows({
  title,
  rows,
}: {
  title?: string;
  rows: { color?: string; label: string; value: string }[];
}) {
  return (
    <>
      <p className="mb-1 font-medium">{title}</p>
      {rows.map((row) => (
        <p key={row.label} className="flex items-center gap-2 text-muted-foreground">
          <span
            aria-hidden="true"
            className="size-2 rounded-[2px]"
            style={{ background: row.color }}
          />
          <span className="flex-1">{row.label}</span>
          <span className="font-mono text-foreground tabular-nums">{row.value}</span>
        </p>
      ))}
    </>
  );
}

function Donut({
  series,
  width,
  activeIndex,
  instant,
  onHover,
  format,
}: {
  format: (value: number) => string;
  series: (ChartSeries & { color: string })[];
  width: number;
  activeIndex: number | null;
  instant: boolean;
  onHover: (index: number) => void;
}) {
  const total = sum(series.map((s) => sum(s.values))) || 1;
  const r = 78;
  const c = 2 * Math.PI * r;
  const gap = series.length > 1 ? 2 : 0;
  const starts = series.map((_, i) =>
    series.slice(0, i).reduce((n, s) => n + (sum(s.values) / total) * c, 0),
  );

  return (
    <g>
      <text
        x={width / 2}
        y={104}
        textAnchor="middle"
        fontSize="11"
        className="fill-muted-foreground"
      >
        {activeIndex === null ? "Total" : series[activeIndex]?.label}
      </text>
      <text
        x={width / 2}
        y={124}
        textAnchor="middle"
        fontSize="18"
        fontWeight={500}
        className="fill-foreground tabular-nums"
      >
        {activeIndex === null
          ? format(total)
          : `${Math.round((sum(series[activeIndex]?.values ?? []) / total) * 100)}%`}
      </text>
      <g transform={`translate(${width / 2}, 110) rotate(-90)`}>
        {series.map((s, i) => {
          const share = sum(s.values) / total;
          const length = Math.max(share * c - gap, 0);
          const start = starts[i];
          return (
            <motion.circle
              key={s.id}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={activeIndex === i ? 26 : 22}
              strokeDashoffset={-start}
              initial={{ strokeDasharray: `0 ${c}` }}
              animate={{ strokeDasharray: `${length} ${c}` }}
              transition={
                instant
                  ? { duration: 0 }
                  : { duration: 0.6, ease: EASE_OUT, delay: i * 0.06 }
              }
              style={{ transition: "stroke-width 150ms ease-out" }}
              onPointerEnter={() => onHover(i)}
            />
          );
        })}
      </g>
    </g>
  );
}
