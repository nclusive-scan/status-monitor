// The public status: what is out right now, when everything was last checked, each service's checks, uptime and
// response times, incidents, maintenance and how status is decided. Built from the TUFFUI components in components/ui.
// Every value from the API is rendered as text (React escapes it); nothing is injected as HTML.
import type { Icon } from "@phosphor-icons/react";
import {
  CalendarDotsIcon, CheckCircleIcon, ClockCounterClockwiseIcon, GaugeIcon, HeartbeatIcon, ListChecksIcon, PulseIcon, QuestionIcon, ShieldCheckIcon, WarningIcon, WarningCircleIcon, WrenchIcon, XCircleIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { ChartCard } from "@/components/ui/chart-card";
import type { DataColumn } from "@/components/ui/data-table";
import { DataTable } from "@/components/ui/data-table";
import { Accordion } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/empty-state";
import { CardSkeleton } from "@/components/ui/loading-skeleton";
import { StatGrid } from "@/components/ui/stat-grid";
import { StatusPill } from "@/components/ui/status-pill";
import { Inset, Panel, Shell, ShellHeader } from "@/components/ui/surface";
import { TickGauge } from "@/components/ui/tick-gauge";
import { cn } from "@/lib/utils";
import type { Shown } from "./format.ts";
import { ago, dayLabel, hourLabel, ms, percent, TONE } from "./format.ts";
import { useNow } from "./hooks.ts";
import type { CheckView, ComponentView, DayView, IncidentView, Summary } from "./model.ts";
import { LABEL } from "./model.ts";

const ICON: Readonly<Record<Shown, Icon>> = {
  ok: CheckCircleIcon, degraded: WarningCircleIcon, down: XCircleIcon, unknown: QuestionIcon, maintenance: WrenchIcon, none: PulseIcon,
};
const UPTIME_TARGET = 0.999;

function Pill({ shown, size = "md" }: { shown: Shown; size?: "sm" | "md" }): React.JSX.Element {
  return (
    <StatusPill tone={TONE[shown]} icon={ICON[shown]} size={size}>
      {LABEL[shown]}
    </StatusPill>
  );
}

// ---- Overall ----

const ORB: Readonly<Record<Shown, string>> = {
  ok: "bg-positive", degraded: "bg-warning", down: "bg-negative", unknown: "bg-muted-foreground", maintenance: "bg-brand", none: "bg-muted-foreground",
};

function Hero({ summary, now, loadedAt }: { summary: Summary; now: number; loadedAt: number | null }): React.JSX.Element {
  const operational = summary.stats === null ? null : `${String(summary.stats.operational)} of ${String(summary.stats.total)} services operational`;
  const checks = summary.components.reduce((total, component) => total + component.checks.length, 0);
  const nextRefresh = loadedAt === null ? null : Math.max(0, Math.ceil((loadedAt + 30_000 - now) / 1000));
  return (
    <Shell className="max-w-none">
      <Panel className="relative overflow-hidden p-5 sm:p-7">
        <div aria-hidden="true" className={cn("pointer-events-none absolute -top-24 -right-24 size-72 rounded-full opacity-[0.12] blur-3xl", ORB[summary.overall])} />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <span aria-hidden="true" className="relative mt-1.5 flex size-3.5 shrink-0">
              {summary.overall === "ok" || summary.overall === "down" || summary.overall === "degraded" ? (
                <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-50 motion-reduce:animate-none", ORB[summary.overall])} />
              ) : null}
              <span className={cn("relative inline-flex size-3.5 rounded-full", ORB[summary.overall])} />
            </span>
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{summary.headline}</h1>
              <p className="mt-1.5 max-w-xl text-sm text-pretty text-muted-foreground">
                {summary.overall === "none" || summary.stale ? summary.freshness : operational ?? summary.freshness}
              </p>
            </div>
          </div>
          {summary.overall === "none" ? null : <div className="self-start sm:self-center"><Pill shown={summary.overall} /></div>}
        </div>
        <dl className="relative mt-6 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          <Fact icon={HeartbeatIcon} label="Last check" value={ago(summary.lastRunAt, now)} tone={summary.stale ? "negative" : "positive"}
            detail={summary.stale ? "Monitor delayed" : "Monitor running"} />
          <Fact icon={ListChecksIcon} label="Checks" value={String(checks)}
            detail={checks === 0 ? "None listed" : summary.attention.length === 0 ? "All passing" : `${String(summary.attention.length)} not passing`}
            {...(checks === 0 ? {} : { tone: summary.attention.length === 0 ? "positive" as const : "negative" as const })} />
          <Fact icon={ShieldCheckIcon} label="Services" value={String(summary.components.length)} detail={summary.overall === "none" ? "None published yet" : "Monitored"} />
          <Fact icon={ClockCounterClockwiseIcon} label="Page refresh" value={nextRefresh === null ? "—" : `${String(nextRefresh)} s`} detail="Updates every 30 s" />
        </dl>
      </Panel>
    </Shell>
  );
}

function Fact({ icon: IconComponent, label, value, detail, tone }: {
  icon: Icon; label: string; value: string; detail: string; tone?: "positive" | "negative";
}): React.JSX.Element {
  return (
    <Inset className="px-3.5 py-3">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <IconComponent weight="fill" aria-hidden="true" className="size-3.5" />
        {label}
      </dt>
      <dd className="mt-1 font-mono text-lg font-medium tracking-tight tabular-nums">{value}</dd>
      <dd className={cn("text-xs", tone === "negative" ? "text-negative" : tone === "positive" ? "text-positive" : "text-muted-foreground")}>{detail}</dd>
    </Inset>
  );
}

// ---- What is out ----

function Attention({ summary, now }: { summary: Summary; now: number }): React.JSX.Element | null {
  if (summary.attention.length === 0) return null;
  return (
    <Shell className="max-w-none">
      <ShellHeader as="h2" icon={WarningIcon} title="Affected right now"
        subtitle={`${String(summary.attention.length)} ${summary.attention.length === 1 ? "operation is" : "operations are"} not passing`} />
      <Panel className="divide-y divide-foreground/[0.06]">
        {summary.attention.map(({ component, check }) => (
          <div key={check.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
            <Pill shown={check.shown} size="sm" />
            <p className="min-w-0 flex-1 text-sm">
              <span className="font-medium">{check.name}</span>
              <span className="block text-muted-foreground sm:inline"><span className="hidden sm:inline"> · </span>{component}
                <span className="sm:hidden"> · checked {ago(check.checkedAt, now)}</span></span>
            </p>
            <p className="hidden text-xs text-muted-foreground tabular-nums sm:block">checked {ago(check.checkedAt, now)}</p>
          </div>
        ))}
      </Panel>
    </Shell>
  );
}

// ---- Headline numbers ----

function Overview({ summary }: { summary: Summary }): React.JSX.Element | null {
  const stats = summary.stats;
  if (stats === null || stats.total === 0) return null;
  const days = summary.components[0]?.history.length ?? 0;
  const dailyUptime = Array.from({ length: days }, (_, index) => {
    const values = summary.components.map((component) => component.history[index]?.uptime).filter((value): value is number => typeof value === "number");
    return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
  }).filter((value): value is number => value !== null);
  const hourly = mergedLatency(summary.components).values;
  const uptime = stats.uptime30;
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <StatGrid
        className="max-w-none"
        title="At a glance"
        subtitle="Across every listed service"
        data={[
          { id: "uptime", label: "Uptime · 30 days", value: percent(uptime), ...(dailyUptime.length > 1 ? { trend: dailyUptime } : {}) },
          { id: "latency", label: "Avg response · 24 h", value: ms(stats.latency24), higherIsBetter: false, ...(hourly.length > 1 ? { trend: hourly } : {}) },
          { id: "operational", label: "Operational now", value: `${String(stats.operational)}/${String(stats.total)}`,
            goal: { ratio: stats.total === 0 ? 0 : stats.operational / stats.total, label: `${String(stats.total)} services` } },
          { id: "incidents", label: "Incidents · 30 days", value: String(stats.incidents30), hint: stats.incidents30 === 0 ? "None recorded" : "Open and resolved" },
        ]}
      />
      <TickGauge
        className="max-w-none"
        title="Uptime target"
        subtitle="30-day mean"
        value={uptime === null ? 0 : uptime / 100}
        target={UPTIME_TARGET}
        targetLabel="Target 99.9%"
        format={(value) => (uptime === null ? "—" : `${(value * 100).toFixed(2)}%`)}
        caption={uptime === null ? "No runs yet" : uptime / 100 >= UPTIME_TARGET ? "Meeting the target" : "Below the target"}
        aside={uptime === null ? undefined : (
          <StatusPill size="sm" tone={uptime / 100 >= UPTIME_TARGET ? "positive" : "negative"}>{uptime / 100 >= UPTIME_TARGET ? "On target" : "Below"}</StatusPill>
        )}
      />
    </div>
  );
}

// ---- Services ----

const BAR: Readonly<Record<DayView["band"], string>> = {
  ok: "bg-positive", degraded: "bg-warning", down: "bg-negative", none: "bg-foreground/[0.08]",
};
const BAND_TEXT: Readonly<Record<DayView["band"], string>> = { ok: "Operational", degraded: "Degraded", down: "Outage", none: "No data" };

/** 30 days of daily uptime as bars; hovering a bar names the day. Screen readers get one summary sentence. */
function UptimeStrip({ component }: { component: ComponentView }): React.JSX.Element {
  const [hovered, setHovered] = useState<number | null>(null);
  const day = hovered === null ? undefined : component.history[hovered];
  const bad = component.history.filter((item) => item.band === "degraded" || item.band === "down").length;
  const label = `Daily uptime, last ${String(component.history.length)} days: ${percent(component.uptime.d30)} overall, `
    + `${bad === 0 ? "no day" : `${String(bad)} ${bad === 1 ? "day" : "days"}`} below 99.95%.`;
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{day === undefined ? "Daily uptime" : dayLabel(day.date)}</span>
        <span className="font-mono tabular-nums">
          {day === undefined ? percent(component.uptime.d30) : `${BAND_TEXT[day.band]} · ${percent(day.uptime)}`}
        </span>
      </div>
      <div role="img" aria-label={label} className="flex h-9 items-stretch gap-[3px]" onMouseLeave={() => { setHovered(null); }}>
        {component.history.map((item, index) => (
          <span
            key={item.date}
            onMouseEnter={() => { setHovered(index); }}
            className={cn("flex-1 rounded-[3px] transition-opacity duration-150", BAR[item.band], hovered !== null && hovered !== index && "opacity-40")}
          />
        ))}
      </div>
      <div aria-hidden="true" className="mt-1.5 flex justify-between text-[0.6875rem] text-muted-foreground">
        <span>{String(component.history.length)} days ago</span>
        <span>Today</span>
      </div>
    </div>
  );
}

function CheckRow({ check, now }: { check: CheckView; now: number }): React.JSX.Element {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", ORB[check.shown])} />
      <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">
        {check.name}
        <span className="sr-only">: {LABEL[check.shown]}, {check.kindLabel}</span>
      </span>
      <span className="w-14 text-right font-mono text-xs text-muted-foreground tabular-nums">{ms(check.latencyMs)}</span>
      <span className="w-20 text-right text-xs text-muted-foreground tabular-nums">{ago(check.checkedAt, now)}</span>
    </li>
  );
}

function ServiceCard({ component, now }: { component: ComponentView; now: number }): React.JSX.Element {
  const subtitle = component.note !== null
    ? `Maintenance ${component.note}`
    : `Checked ${ago(component.lastCheckedAt, now)}${component.since === null ? "" : ` · ${LABEL[component.shown].toLowerCase()} since ${dayLabel(component.since.slice(0, 10))}`}`;
  return (
    <Shell className="max-w-none">
      <ShellHeader as="h3" icon={ICON[component.shown]} title={component.name} subtitle={subtitle} aside={<Pill shown={component.shown} size="sm" />} />
      <Panel className="p-4">
        <dl className="mb-4 grid grid-cols-3 gap-1.5">
          {([["24 hours", component.uptime.h24], ["7 days", component.uptime.d7], ["30 days", component.uptime.d30]] as const).map(([label, value]) => (
            <Inset key={label} className="px-3 py-2">
              <dt className="text-[0.6875rem] text-muted-foreground">{label}</dt>
              <dd className="font-mono text-sm font-medium tabular-nums">{percent(value)}</dd>
            </Inset>
          ))}
        </dl>
        <UptimeStrip component={component} />
      </Panel>
      {component.checks.length === 0 ? null : (
        <Panel className="mt-1.5">
          <div className="flex items-center justify-between px-4 pt-3 pb-1 text-xs text-muted-foreground">
            <span>What is checked</span>
            <span className="hidden sm:inline">Response · Last run</span>
          </div>
          <ul aria-label={`Checks for ${component.name}`} className="divide-y divide-foreground/[0.06] pb-1">
            {component.checks.map((check) => <CheckRow key={check.id} check={check} now={now} />)}
          </ul>
        </Panel>
      )}
    </Shell>
  );
}

// ---- Response times ----

/** Hourly averages per component, trimmed to the hours any data exists for; a gap repeats the previous hour's value. */
function mergedLatency(components: readonly ComponentView[]): { labels: string[]; series: { id: string; label: string; values: number[] }[]; values: number[] } {
  const hours = components[0]?.latency.map((point) => point.hour) ?? [];
  const first = hours.findIndex((_, index) => components.some((component) => typeof component.latency[index]?.avgMs === "number"));
  if (first < 0) return { labels: [], series: [], values: [] };
  const series = components.slice(0, 4).map((component) => {
    let previous = 0;
    const values = hours.slice(first).map((_, offset) => {
      const value = component.latency[first + offset]?.avgMs;
      if (typeof value === "number") previous = Math.round(value);
      return previous;
    });
    return { id: component.id, label: component.name, values };
  });
  const values = hours.slice(first).map((_, offset) => {
    const present = components.map((component) => component.latency[first + offset]?.avgMs).filter((value): value is number => typeof value === "number");
    return present.length === 0 ? 0 : present.reduce((a, b) => a + b, 0) / present.length;
  });
  return { labels: hours.slice(first).map(hourLabel), series, values };
}

function ResponseTimes({ summary }: { summary: Summary }): React.JSX.Element | null {
  const merged = useMemo(() => mergedLatency(summary.components), [summary.components]);
  if (merged.labels.length < 2) return null;
  const latest = summary.components.map((component) => component.latencyNow).filter((value): value is number => value !== null);
  return (
    <ChartCard
      className="max-w-none"
      type="area"
      title="Response time"
      subtitle={`Hourly average · last ${String(merged.labels.length)} hours`}
      total={latest.length === 0 ? undefined : ms(latest.reduce((a, b) => a + b, 0) / latest.length)}
      format={(value) => `${String(Math.round(value))} ms`}
      data={{ labels: merged.labels, series: merged.series }}
    />
  );
}

// ---- Every check ----

type CheckRowData = { id: string; service: string; operation: string; kind: string; status: string; latency: number | null; checked: string | null; rank: number };
const RANK: Readonly<Record<string, number>> = { down: 0, degraded: 1, unknown: 2, ok: 3 };

function AllChecks({ summary, now }: { summary: Summary; now: number }): React.JSX.Element | null {
  const rows: CheckRowData[] = summary.components.flatMap((component) => component.checks.map((check) => ({
    id: check.id, service: component.name, operation: check.name, kind: check.kindLabel, status: check.shown, latency: check.latencyMs,
    checked: check.checkedAt, rank: RANK[check.shown] ?? 2,
  }))).sort((a, b) => a.rank - b.rank);
  if (rows.length === 0) return null;
  const columns: DataColumn<CheckRowData>[] = [
    { key: "operation", label: "Operation", sortable: true, priority: 1 },
    { key: "status", label: "Status", sortable: true, priority: 1,
      format: (value) => <Pill shown={value === "ok" || value === "degraded" || value === "down" ? value : "unknown"} size="sm" /> },
    { key: "service", label: "Service", sortable: true, priority: 2 },
    { key: "latency", label: "Response", align: "right", sortable: true, priority: 2, format: (value) => ms(typeof value === "number" ? value : null) },
    { key: "checked", label: "Last run", align: "right", sortable: true, priority: 3, format: (value) => ago(typeof value === "string" ? value : null, now) },
    { key: "kind", label: "Type", sortable: true, priority: 3 },
  ];
  const failing = rows.filter((row) => row.status === "down" || row.status === "degraded").length;
  return (
    <DataTable
      className="max-w-none"
      title="Every check"
      subtitle={`${String(rows.length)} operations · ${failing === 0 ? "all passing" : `${String(failing)} not passing`}`}
      data={rows}
      columns={columns}
      pageSize={8}
    />
  );
}

// ---- Incidents and maintenance ----

const INCIDENT_TONE: Readonly<Record<IncidentView["state"], Shown>> = { investigating: "down", acknowledged: "degraded", resolved: "ok" };
const INCIDENT_LABEL: Readonly<Record<IncidentView["state"], string>> = { investigating: "Investigating", acknowledged: "Acknowledged", resolved: "Resolved" };

function Incidents({ summary }: { summary: Summary }): React.JSX.Element {
  const timeline = summary.timeline;
  const all = timeline === null ? [] : [...timeline.open, ...timeline.past];
  return (
    <Shell className="max-w-none">
      <ShellHeader as="h2" icon={ClockCounterClockwiseIcon} title="Incidents"
        subtitle={timeline === null ? "Unavailable right now" : timeline.open.length > 0 ? `${String(timeline.open.length)} open` : "Last 30 days"} />
      <Panel className="p-1.5">
        {timeline === null ? (
          <EmptyState compact tone="error" title="Incident history could not be loaded" description="Retrying shortly." />
        ) : all.length === 0 ? (
          <EmptyState compact icon={CheckCircleIcon} title="No incidents in the last 30 days" description="When something goes wrong, it is listed here with how long it lasted." />
        ) : (
          <Accordion
            type="multiple"
            defaultValue={timeline.open.map((_, index) => `open-${String(index)}`)}
            items={all.map((incident, index) => ({
              id: index < timeline.open.length ? `open-${String(index)}` : `past-${String(index)}`,
              title: incident.title,
              meta: (
                <StatusPill size="sm" tone={TONE[INCIDENT_TONE[incident.state]]}>{INCIDENT_LABEL[incident.state]}</StatusPill>
              ),
              content: (
                <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
                  <dt className="text-muted-foreground">Service</dt><dd>{incident.component}</dd>
                  <dt className="text-muted-foreground">Started</dt><dd>{incident.started}</dd>
                  <dt className="text-muted-foreground">Status</dt><dd>{incident.detail}</dd>
                </dl>
              ),
            }))}
          />
        )}
      </Panel>
    </Shell>
  );
}

function Maintenance({ summary }: { summary: Summary }): React.JSX.Element | null {
  if (summary.maintenance.length === 0) return null;
  return (
    <Shell className="max-w-none">
      <ShellHeader as="h2" icon={CalendarDotsIcon} title="Scheduled maintenance" subtitle="Now and in the coming week" />
      <Panel className="divide-y divide-foreground/[0.06]">
        {summary.maintenance.map((window) => (
          <div key={`${window.components}-${window.when}`} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <StatusPill size="sm" tone={window.active ? "brand" : "neutral"} icon={WrenchIcon}>{window.active ? "In progress" : "Upcoming"}</StatusPill>
            <p className="min-w-0 flex-1 text-sm font-medium">{window.components}</p>
            <p className="text-xs text-muted-foreground">{window.when}</p>
          </div>
        ))}
      </Panel>
    </Shell>
  );
}

// ---- How status is decided ----

function HowItWorks({ summary }: { summary: Summary }): React.JSX.Element {
  const rules = summary.rules;
  const staleMinutes = Math.round(summary.staleAfterSeconds / 60);
  const items: [Icon, string, string][] = [
    [PulseIcon, "Checked from outside", "A separate monitor on Cloudflare's network runs every check on a schedule, independent of the services it watches."],
    [ListChecksIcon, "What is checked", "HTTP requests to each service, DNS lookups, and a signed health check in which a service reports on its own parts, such as its database and background work."],
    [WarningIcon, "When a service is marked down", rules === null
      ? "A run of failing checks in a row opens an incident; a run of passing checks closes it."
      : `${String(rules.openAfterFailures)} failing ${rules.openAfterFailures === 1 ? "run" : "runs"} in a row open an incident; ${String(rules.resolveAfterPasses)} passing ${rules.resolveAfterPasses === 1 ? "run closes" : "runs close"} it.`],
    [HeartbeatIcon, "If the monitor stops", `With no run for ${String(staleMinutes)} minutes, every status here shows Unknown rather than an old green.`],
    [GaugeIcon, "Reading the bars", "A day is green at 99.95% uptime or more, amber from 99%, and red below. Grey means no runs that day."],
  ];
  return (
    <Shell className="max-w-none">
      <ShellHeader as="h2" icon={ShieldCheckIcon} title="How status is decided" subtitle="The rules behind every pill on this page" />
      <Panel className="grid gap-1.5 p-1.5 sm:grid-cols-2">
        {items.map(([IconComponent, title, text], index) => (
          <Inset key={title} className={cn("flex gap-3 px-4 py-3.5", index === items.length - 1 && items.length % 2 === 1 && "sm:col-span-2")}>
            <IconComponent weight="fill" aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div>
              <h3 className="text-sm font-medium">{title}</h3>
              <p className="mt-0.5 text-[0.8125rem] text-pretty text-muted-foreground">{text}</p>
            </div>
          </Inset>
        ))}
      </Panel>
    </Shell>
  );
}

// ---- Page ----

/** One polite live region: it announces the overall headline only when it changes. "Last check" ticks outside it. */
function Announcer({ headline }: { headline: string }): React.JSX.Element {
  const [announced, setAnnounced] = useState(headline);
  useEffect(() => {
    setAnnounced(headline);
  }, [headline]);
  return <p id="announce" role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announced}</p>;
}

function Loading(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading status" className="space-y-3">
      <CardSkeleton className="max-w-none" />
      <CardSkeleton className="max-w-none" />
    </div>
  );
}

export function PublicView({ summary, loadedAt }: { summary: Summary | null; loadedAt: number | null }): React.JSX.Element {
  const now = useNow();
  if (summary === null) return <Loading />;
  const empty = summary.overall === "none";
  return (
    <section aria-labelledby="status-heading" className="space-y-3">
      <h2 id="status-heading" className="sr-only">Current status</h2>
      <Announcer headline={summary.headline} />
      <Hero summary={summary} now={now} loadedAt={loadedAt} />
      {empty ? null : (
        <>
          <Attention summary={summary} now={now} />
          <Overview summary={summary} />
          <section aria-labelledby="services-heading" className="space-y-3 pt-4">
            <div className="flex items-end justify-between gap-3 px-1">
              <div>
                <h2 id="services-heading" className="text-lg font-semibold tracking-tight">Services</h2>
                <p className="text-sm text-muted-foreground">Uptime over the last 30 days and every operation checked</p>
              </div>
              <Legend />
            </div>
            {summary.components.length === 0 ? (
              <Shell className="max-w-none"><Panel><EmptyState tone="error" title="Service status is unavailable right now" description="Retrying shortly." /></Panel></Shell>
            ) : (
              <div className="grid items-start gap-3 md:grid-cols-2">
                {summary.components.map((component) => <ServiceCard key={component.id} component={component} now={now} />)}
              </div>
            )}
          </section>
          <div className="space-y-3 pt-4">
            <ResponseTimes summary={summary} />
            <AllChecks summary={summary} now={now} />
            <Maintenance summary={summary} />
            <Incidents summary={summary} />
          </div>
        </>
      )}
      <div className="pt-4">
        <HowItWorks summary={summary} />
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 px-1 pt-6 text-xs text-muted-foreground">
        <span>Times are in your time zone. The page refreshes every 30 seconds.</span>
        <a className="underline-offset-4 hover:text-foreground hover:underline" href="https://github.com/nclusive-scan/status-monitor">Open-source status monitor</a>
      </footer>
    </section>
  );
}

function Legend(): React.JSX.Element {
  return (
    <ul aria-label="Legend" className="hidden items-center gap-3 text-xs text-muted-foreground sm:flex">
      {(["ok", "degraded", "down", "none"] as const).map((band) => (
        <li key={band} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("size-2.5 rounded-[3px]", BAR[band])} />
          {BAND_TEXT[band]}
        </li>
      ))}
    </ul>
  );
}
