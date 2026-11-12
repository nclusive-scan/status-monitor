// The public status, for someone who wants to know one thing: is it working, and is there anything I should know.
// Top to bottom: the status in one sentence, current notices (open problems and maintenance), every service with its
// last 30 days, and past problems. Every value from the API is rendered as text (React escapes it).
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ago, clock, dayLabel, percent, TONE_TEXT } from "./format.ts";
import { useNow } from "./hooks.ts";
import type { Icon } from "./icons/index.tsx";
import { AlertTriangle, CheckCircle, HelpCircle, Info, Wrench, XCircle } from "./icons/index.tsx";
import type { ComponentView, DayView, IncidentView, MaintenanceView, Shown, Summary } from "./model.ts";
import { LABEL, notWorking, UNAVAILABLE_HEADLINE } from "./model.ts";

const ICON: Readonly<Record<Shown, Icon>> = {
  ok: CheckCircle, degraded: AlertTriangle, down: XCircle, unknown: HelpCircle, maintenance: Wrench, none: Info,
};
const impactText = (impact: IncidentView["impact"]): string => (impact === "down" ? "outage" : "partial outage");

function Time({ iso, children }: { iso: string; children: React.ReactNode }): React.JSX.Element {
  return <time dateTime={iso}>{children}</time>;
}

/** One polite live region: it announces the headline only when it changes. "Updated …" ticks outside it. */
function Announcer({ headline }: { headline: string }): React.JSX.Element {
  const [announced, setAnnounced] = useState(headline);
  useEffect(() => {
    setAnnounced(headline);
  }, [headline]);
  return <p id="announce" role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announced}</p>;
}

function Banner({ summary, now }: { summary: Summary; now: number }): React.JSX.Element {
  const StatusIcon = ICON[summary.overall];
  const unavailable = summary.headline === UNAVAILABLE_HEADLINE;
  // Services in trouble that no open incident below already names (an incident opens after a few failing runs).
  const announced = new Set((summary.timeline?.open ?? []).map((incident) => incident.component));
  const affected = summary.components.filter((component) => (component.shown === "down" || component.shown === "degraded") && !announced.has(component.name))
    .map((component) => component.name);
  let line: React.ReactNode = null;
  if (unavailable || summary.overall === "none") line = summary.freshness === "" ? null : summary.freshness;
  else if (summary.stale) line = summary.lastRunAt === null ? null : <>Last confirmed <Time iso={summary.lastRunAt}>{ago(summary.lastRunAt, now)}</Time></>;
  else if (summary.lastRunAt !== null) line = <>Updated <Time iso={summary.lastRunAt}>{ago(summary.lastRunAt, now)}</Time></>;
  return (
    <div className="flex items-start gap-3.5">
      <StatusIcon className={cn("mt-0.5 size-8 shrink-0", TONE_TEXT[summary.overall])} />
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-[1.75rem] sm:leading-9">{summary.headline}</h1>
        {affected.length > 0 ? <p className="mt-1 text-[0.9375rem] text-pretty">Affected: {affected.join(", ")}</p> : null}
        {line === null ? null : <p className="mt-1 text-sm text-muted-foreground">{line}</p>}
      </div>
    </div>
  );
}

// ---- Current notices ----

function IncidentNotice({ incident, now }: { incident: IncidentView; now: number }): React.JSX.Element {
  const working = incident.state === "acknowledged";
  return (
    <li className="flex gap-3 p-4">
      <span aria-hidden="true" className={cn("mt-2 size-2 shrink-0 rounded-full", incident.impact === "down" ? "bg-bad" : "bg-warn")} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="font-medium">{incident.component} {impactText(incident.impact)}</h3>
          <Badge variant="outline" className="font-normal">{working ? "Being fixed" : "Problem detected"}</Badge>
        </div>
        <p className="mt-1 text-sm text-pretty">
          {working ? "Our team is working on a fix." : `We know ${incident.component} isn't working normally and are looking into it.`}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">Started <Time iso={incident.startedAt}>{clock(incident.startedAt, now)}</Time></p>
      </div>
    </li>
  );
}

function MaintenanceNotice({ window, now }: { window: MaintenanceView; now: number }): React.JSX.Element {
  return (
    <li className="flex gap-3 p-4">
      <Wrench className={cn("mt-1 size-4 shrink-0", TONE_TEXT.maintenance)} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="font-medium">Scheduled maintenance</h3>
          <Badge variant="outline" className="font-normal">{window.active ? "In progress" : "Upcoming"}</Badge>
        </div>
        <p className="mt-1 text-sm text-pretty">
          {window.components} may be unavailable {window.active ? "until " : "from "}
          {window.active ? null : <><Time iso={window.startsAt}>{clock(window.startsAt, now)}</Time> to </>}
          <Time iso={window.endsAt}>{clock(window.endsAt, now)}</Time>.
        </p>
      </div>
    </li>
  );
}

function Notices({ summary, now }: { summary: Summary; now: number }): React.JSX.Element | null {
  const open = summary.timeline?.open ?? [];
  const windows = summary.maintenance.toSorted((a, b) => Number(b.active) - Number(a.active));
  if (open.length === 0 && windows.length === 0) return null;
  return (
    <section aria-labelledby="notices-heading" className="space-y-3">
      <h2 id="notices-heading" className="text-base font-semibold">Current notices</h2>
      <ul className="divide-y rounded-xl border bg-card">
        {open.toSorted((a, b) => Number(a.impact === "degraded") - Number(b.impact === "degraded"))
          .map((incident) => <IncidentNotice key={incident.id} incident={incident} now={now} />)}
        {windows.map((window) => <MaintenanceNotice key={`${window.components}-${window.startsAt}`} window={window} now={now} />)}
      </ul>
    </section>
  );
}

// ---- Services ----

const BAR: Readonly<Record<DayView["band"], string>> = { ok: "bg-ok", degraded: "bg-warn", down: "bg-bad", none: "bg-muted" };
const BAND_TEXT: Readonly<Record<DayView["band"], string>> = { ok: "Operational", degraded: "Partial outage", down: "Outage", none: "No data" };

/** The last 30 days as bars. Hovering one names the day in the caption; screen readers get one sentence instead. */
function UptimeBars({ component }: { component: ComponentView }): React.JSX.Element {
  const [hovered, setHovered] = useState<number | null>(null);
  const day = hovered === null ? undefined : component.history[hovered];
  const bad = component.history.filter((item) => item.band === "degraded" || item.band === "down").length;
  const label = `Past ${String(component.history.length)} days: ${percent(component.uptime.d30)} uptime, `
    + `${bad === 0 ? "no days" : `${String(bad)} ${bad === 1 ? "day" : "days"}`} with problems.`;
  return (
    <div className="mt-3">
      <div role="img" aria-label={label} className="flex h-7 items-stretch gap-[2px]" onMouseLeave={() => { setHovered(null); }}>
        {component.history.map((item, index) => (
          <span key={item.date} onMouseEnter={() => { setHovered(index); }}
            className={cn("flex-1 rounded-[2px] transition-opacity", BAR[item.band], hovered !== null && hovered !== index && "opacity-35")} />
        ))}
      </div>
      <div aria-hidden="true" className="mt-1.5 flex justify-between gap-3 text-xs text-muted-foreground tabular-nums">
        <span>{String(component.history.length)} days ago</span>
        <span className="text-foreground/80">
          {day === undefined ? `${percent(component.uptime.d30)} uptime` : `${dayLabel(day.date)}: ${day.band === "none" ? "no data" : `${percent(day.uptime)} uptime`}`}
        </span>
        <span>Today</span>
      </div>
    </div>
  );
}

function ServiceRow({ component, now }: { component: ComponentView; now: number }): React.JSX.Element {
  const StatusIcon = ICON[component.shown];
  const trouble = component.shown === "down" || component.shown === "degraded";
  const failing = notWorking(component);
  return (
    <li className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 className="font-medium">{component.name}</h3>
        <span className={cn("inline-flex items-center gap-1.5 text-sm", TONE_TEXT[component.shown])}>
          <StatusIcon className="size-4" />
          {component.note === null ? LABEL[component.shown] : `Maintenance ${component.note}`}
        </span>
      </div>
      {trouble ? (
        <p className="mt-1 text-sm text-muted-foreground text-pretty">
          {component.since === null ? null : <>Since <Time iso={component.since}>{clock(component.since, now)}</Time>{failing.length > 0 ? " · " : ""}</>}
          {failing.length > 0 ? <>Not working: {failing.join(", ")}</> : null}
        </p>
      ) : null}
      <UptimeBars component={component} />
    </li>
  );
}

function Services({ summary, now }: { summary: Summary; now: number }): React.JSX.Element | null {
  if (summary.components.length === 0) return null;
  return (
    <section aria-labelledby="services-heading" className="space-y-3">
      <h2 id="services-heading" className="text-base font-semibold">Services</h2>
      <ul className="divide-y rounded-xl border bg-card">
        {summary.components.map((component) => <ServiceRow key={component.id} component={component} now={now} />)}
      </ul>
      <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {(["ok", "degraded", "down", "none"] as const).map((band) => (
          <li key={band} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cn("size-2.5 rounded-[2px]", BAR[band])} />
            {BAND_TEXT[band]}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- Past problems ----

function PastIncidents({ summary }: { summary: Summary }): React.JSX.Element | null {
  const timeline = summary.timeline;
  if (timeline === null) return null;
  return (
    <section aria-labelledby="past-heading" className="space-y-3">
      <h2 id="past-heading" className="text-base font-semibold">Past incidents</h2>
      {timeline.past.length === 0 ? (
        <p className="text-sm text-muted-foreground">None in the past 30 days.</p>
      ) : (
        <ul className="divide-y rounded-xl border bg-card text-sm">
          {timeline.past.map((incident) => (
            <li key={incident.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-3">
              <Time iso={incident.startedAt}><span className="inline-block w-14 text-muted-foreground tabular-nums">{dayLabel(incident.startedAt.slice(0, 10))}</span></Time>
              <span className="min-w-0 flex-1 font-medium">{incident.component} {impactText(incident.impact)}</span>
              <span className="text-muted-foreground">{incident.lasted === null ? "Resolved" : `Resolved after ${incident.lasted}`}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Loading(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading status" className="space-y-12">
      <div className="flex gap-3.5"><Skeleton className="size-8 rounded-full" /><div className="flex-1 space-y-2"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-4 w-40" /></div></div>
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}

export function PublicView({ summary }: { summary: Summary | null }): React.JSX.Element {
  const now = useNow(15_000);
  if (summary === null) return <Loading />;
  const empty = summary.overall === "none";
  return (
    <div className="space-y-12">
      <Announcer headline={summary.headline} />
      <Banner summary={summary} now={now} />
      {empty ? null : (
        <>
          <Notices summary={summary} now={now} />
          <Services summary={summary} now={now} />
          <PastIncidents summary={summary} />
        </>
      )}
    </div>
  );
}
