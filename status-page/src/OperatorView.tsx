// The operator view at /operator: everything /api/private returns. Two ways in. With Cloudflare Access in front of
// /operator and /api/private, signing in there is enough: the request carries Access's token and the monitor verifies
// it. Otherwise (or as a break-glass) the operator key: kept in sessionStorage for this tab only and sent only as an
// Authorization header to /api/private. Contacts arrive masked from the Worker.
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartCard } from "@/components/ui/chart-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatGrid } from "@/components/ui/stat-grid";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TickGauge } from "@/components/ui/tick-gauge";
import { cn } from "@/lib/utils";
import { hourLabel, ms, percent, TONE_TEXT, when } from "./format.ts";
import { AlertTriangle, Lock, LogOut, Refresh } from "./icons/index.tsx";
import type { Summary } from "./model.ts";
import { asStatus, checkName, isPublicStatus, LABEL, summarize } from "./model.ts";
import { focusAfterSwap, monitorFacts, refreshFailedText, str, warningText } from "./operator.ts";

const KEY_STORAGE = "status-monitor-operator-key";
const UPTIME_TARGET = 0.999;

function storedKey(): string | null {
  try {
    return sessionStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

function storeKey(value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(KEY_STORAGE);
    else sessionStorage.setItem(KEY_STORAGE, value);
  } catch {
    // Storage blocked: the key lives only for this load.
  }
}

const field = (record: unknown, key: string): unknown => (typeof record === "object" && record !== null ? Reflect.get(record, key) : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const isoField = (record: unknown, key: string): string | null => {
  const value = field(record, key);
  return typeof value === "string" ? value : null;
};

function StatusBadge({ value }: { value: unknown }): React.JSX.Element {
  const status = asStatus(value);
  return <span className={cn("text-sm", TONE_TEXT[status])}>{LABEL[status]}</span>;
}

// ---- Overview: the charts ----

function Charts({ summary }: { summary: Summary }): React.JSX.Element | null {
  const stats = summary.stats;
  if (stats === null || stats.total === 0) return null;
  const hours = summary.components[0]?.latency.map((point) => point.hour) ?? [];
  const first = hours.findIndex((_, index) => summary.components.some((component) => typeof component.latency[index]?.avgMs === "number"));
  const series = first < 0 ? [] : summary.components.slice(0, 4).map((component) => {
    let previous = 0;
    return {
      id: component.id, label: component.name,
      values: hours.slice(first).map((_, offset) => {
        const value = component.latency[first + offset]?.avgMs;
        if (typeof value === "number") previous = Math.round(value);
        return previous;
      }),
    };
  });
  const uptime = stats.uptime30;
  const checks = summary.components.flatMap((component) => component.checks);
  const passing = checks.filter((check) => check.shown === "ok").length;
  return (
    <div className="space-y-4">
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <StatGrid className="max-w-none" data={[
          { id: "uptime", label: "Uptime, 30 days", value: percent(uptime) },
          { id: "latency", label: "Average response, 24 h", value: ms(stats.latency24), higherIsBetter: false },
          { id: "checks", label: "Checks passing", value: `${String(passing)}/${String(checks.length)}` },
          { id: "incidents", label: "Incidents, 30 days", value: String(stats.incidents30) },
        ]} />
        <TickGauge className="max-w-none" title="Uptime against target" subtitle="30-day mean" value={uptime === null ? 0 : uptime / 100}
          target={UPTIME_TARGET} targetLabel="99.9%" format={(value) => (uptime === null ? "—" : `${(value * 100).toFixed(2)}%`)} />
      </div>
      {series.length === 0 || hours.length - first < 2 ? null : (
        <ChartCard className="max-w-none" type="area" title="Response time" subtitle="Hourly average, ms"
          format={(value) => `${String(Math.round(value))} ms`} data={{ labels: hours.slice(first).map(hourLabel), series }} />
      )}
    </div>
  );
}

function Overview({ data, summary }: { data: unknown; summary: Summary | null }): React.JSX.Element {
  const monitor = field(data, "monitor");
  const warnings = list(field(monitor, "warnings")).filter((warning): warning is string => typeof warning === "string");
  return (
    <div className="space-y-4">
      {warnings.map((warning) => (
        <Alert key={warning}>
          <AlertTriangle className="text-warn" />
          <AlertTitle className="font-normal">{warningText(warning)}</AlertTitle>
          <AlertDescription className="font-mono text-xs">{warning}</AlertDescription>
        </Alert>
      ))}
      {summary === null ? null : <Charts summary={summary} />}
      <Card>
        <CardHeader><CardTitle id="private-monitor-title">Monitor</CardTitle></CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_minmax(0,1fr)]">
            {monitorFacts(monitor, when).map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="[overflow-wrap:anywhere]">{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

// ---- Tables ----

function DataCard({ title, description, empty, head, rows }: {
  title: string; description?: string; empty: string; head: string[]; rows: { key: string; cells: React.ReactNode[] }[];
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description === undefined ? null : <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : (
          <Table>
            <TableHeader><TableRow>{head.map((label) => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>{row.cells.map((cell, index) => <TableCell key={String(index)} className="whitespace-normal [overflow-wrap:anywhere]">{cell}</TableCell>)}</TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function Checks({ data }: { data: unknown }): React.JSX.Element {
  return (
    <DataCard title="Latest result per check" empty="No check results yet." head={["Check", "Component", "Status", "Detail", "Latency", "Observed"]}
      rows={list(field(data, "checks")).map((check) => ({
        key: str(field(check, "id")),
        cells: [checkName(str(field(check, "id"))), str(field(check, "component")), <StatusBadge key="s" value={field(check, "status")} />,
          <span key="d" className="font-mono text-xs">{str(field(check, "detail"))}</span>,
          typeof field(check, "latencyMs") === "number" ? `${str(field(check, "latencyMs"))} ms` : "—", when(isoField(check, "observedAt"))],
      }))} />
  );
}

function Incidents({ data }: { data: unknown }): React.JSX.Element {
  return (
    <div className="space-y-4">
      <DataCard title="Escalation" description="Every incident's paging state" empty="No incidents." head={["Incident", "Phase", "Tier", "ACK code", "Acknowledged by", "Next step"]}
        rows={list(field(data, "escalation")).map((entry) => ({
          key: str(field(entry, "incidentId")),
          cells: [<span key="i" className="font-mono text-xs">{str(field(entry, "incidentId"))}</span>, str(field(entry, "phase")),
            `cycle ${str(field(entry, "cycle"))}, tier ${str(field(entry, "tierIndex"))}`, str(field(entry, "ackCode")), str(field(entry, "acknowledgedBy")),
            when(isoField(entry, "nextStepAt"))],
        }))} />
      <DataCard title="Paging drills" empty="No drills yet." head={["Contact", "Outcome", "Opened", "Acknowledged by"]}
        rows={list(field(data, "drills")).map((drill, index) => ({
          key: `${str(field(drill, "incidentId"))}-${String(index)}`,
          cells: [str(field(drill, "contactId")), str(field(drill, "outcome") ?? (isoField(drill, "resolvedAt") === null ? "waiting" : "done")),
            when(isoField(drill, "openedAt")), str(field(drill, "acknowledgedVia"))],
        }))} />
    </div>
  );
}

function Notifications({ data }: { data: unknown }): React.JSX.Element {
  return (
    <DataCard title="Notifications" empty="No notifications yet." head={["Created", "Kind", "To", "Channel", "Result", "Delivery"]}
      rows={list(field(data, "notifications")).map((entry, index) => {
        const error = field(entry, "lastError"), provider = field(entry, "provider"), delivery = field(entry, "deliveryStatus"), code = field(entry, "deliveryCode");
        const logged = typeof provider === "string" && provider.startsWith("log:") ? " · logged, not sent" : "";
        return {
          key: `${str(field(entry, "incidentId"))}-${String(index)}`,
          cells: [when(isoField(entry, "createdAt")), str(field(entry, "kind")), `${str(field(entry, "contact"))} (${str(field(entry, "to"))})`,
            str(field(entry, "channel")), `${str(field(entry, "status"))} ×${str(field(entry, "attempts"))}${typeof error === "string" ? ` · ${error}` : ""}${logged}`,
            typeof delivery === "string" ? `${delivery}${typeof code === "string" ? ` · ${code}` : ""}` : "—"],
        };
      })} />
  );
}

function Contacts({ data }: { data: unknown }): React.JSX.Element {
  return (
    <DataCard title="Contact channel health" empty="Every contact's channels are working." head={["Contact", "Channel", "State", "Code", "Since"]}
      rows={list(field(data, "contactHealth")).map((row, index) => ({
        key: `${str(field(row, "contactId"))}-${str(field(row, "channel"))}-${String(index)}`,
        cells: [str(field(row, "contactId")), str(field(row, "channel")), str(field(row, "state")), str(field(row, "code")), when(isoField(row, "since"))],
      }))} />
  );
}

function Maintenance({ data }: { data: unknown }): React.JSX.Element {
  const components = (value: unknown): string => (value === "all" ? "All components" : list(value).map(str).join(", "));
  return (
    <DataCard title="Maintenance windows" description="Every configured window, with its private note" empty="No maintenance windows."
      head={["Components", "Starts", "Ends", "Note"]}
      rows={list(field(data, "maintenanceWindows")).map((window) => ({
        key: str(field(window, "id")),
        cells: [components(field(window, "components")), when(isoField(window, "startsAt")), when(isoField(window, "endsAt")), str(field(window, "note"))],
      }))} />
  );
}

function DeepPayload({ data }: { data: unknown }): React.JSX.Element {
  const deep = list(field(data, "checks")).filter((check) => field(check, "type") === "deep" && !str(field(check, "id")).includes("."));
  return (
    <Card>
      <CardHeader><CardTitle>Deep health payload</CardTitle><CardDescription>As the platform last returned it</CardDescription></CardHeader>
      <CardContent><pre className="overflow-x-auto rounded-md bg-muted p-4 font-mono text-xs leading-relaxed">{JSON.stringify(deep.map((check) => field(check, "data")), null, 2)}</pre></CardContent>
    </Card>
  );
}

// ---- Sign-in and loading ----

type Via = "access" | "key";

export function OperatorView(): React.JSX.Element {
  const [data, setData] = useState<unknown>(null);
  const [via, setVia] = useState<Via>("key");
  const [shown, setShown] = useState<"checking" | "form" | "data">("checking");
  const [keyError, setKeyError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [loading, setLoading] = useState(false);
  const loadedAt = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<"view-key" | "private-monitor-heading" | null>(null);

  /** Shows one part and hands focus over when it was inside the part now hidden (focusAfterSwap). */
  const swap = useCallback((next: "form" | "data") => {
    const hidden = next === "form" ? contentRef.current : formRef.current;
    pendingFocus.current = focusAfterSwap(next, hidden !== null && hidden.contains(document.activeElement));
    setShown(next);
  }, []);

  useEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target !== null) document.getElementById(target)?.focus();
  }, [shown]);

  /** Without a stored key the request relies on an Access sign-in; a 401 then just shows the key form, no error. */
  const load = useCallback(async () => {
    const key = storedKey();
    const locked = (): void => {
      swap("form");
      setRefreshError("");
      loadedAt.current = null;
      setData(null);
    };
    setLoading(true);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (key !== null) headers["authorization"] = `Bearer ${key}`;
      const response = await fetch("/api/private", { headers, cache: "no-store", credentials: "same-origin" });
      if (response.status === 401) {
        if (key !== null) {
          storeKey(null);
          setKeyError("That key was not accepted.");
        }
        locked();
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      const body: unknown = await response.json();
      setData(body);
      setVia(key === null ? "access" : "key");
      loadedAt.current = new Date().toISOString();
      setKeyError("");
      setRefreshError("");
      swap("data");
    } catch {
      if (loadedAt.current === null) {
        swap("form");
        if (key !== null) setKeyError("The operator view could not be loaded. Try again.");
      } else {
        // Older data stays on screen, with a visible (and announced) note that it could not be refreshed and from when it is.
        setRefreshError(refreshFailedText(loadedAt.current, when));
      }
    } finally {
      setLoading(false);
    }
  }, [swap]);

  useEffect(() => {
    void load();
  }, [load]);

  if (shown === "checking") return <p className="text-center text-sm text-muted-foreground" aria-busy="true">Loading…</p>;

  if (shown === "form" || data === null) {
    return (
      <Card className="mx-auto max-w-sm">
        <CardHeader>
          <CardTitle><h1 className="flex items-center gap-2 text-base font-semibold"><Lock />Operator sign-in</h1></CardTitle>
        </CardHeader>
        <CardContent>
          <form ref={formRef} id="key-form" className="space-y-4" onSubmit={(event) => {
            event.preventDefault();
            const input = new FormData(event.currentTarget).get("key");
            if (typeof input !== "string" || input.trim() === "") return;
            storeKey(input.trim());
            event.currentTarget.reset();
            void load();
          }}>
            <div className="space-y-2">
              <Label htmlFor="view-key">Operator key</Label>
              <Input id="view-key" name="key" type="password" autoComplete="off" spellCheck={false}
                aria-invalid={keyError === "" ? undefined : true} aria-describedby={keyError === "" ? "view-key-hint" : "view-key-error"} />
              {keyError === ""
                ? <p id="view-key-hint" className="text-xs text-muted-foreground">Forgotten when you close this tab.</p>
                : <p id="view-key-error" role="alert" className="text-xs text-bad">{keyError}</p>}
            </div>
            <Button type="submit" className="w-full" disabled={loading}>Open</Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  const summary = isPublicStatus(data) ? summarize(data, when) : null;
  return (
    <div ref={contentRef} id="private-content" className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 id="private-monitor-heading" tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">Operator view</h1>
          <p className="text-sm text-muted-foreground">
            Loaded {when(loadedAt.current)}
            {summary === null ? null : <> · <span className={TONE_TEXT[summary.overall]}>{summary.headline}</span></>}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}><Refresh />Refresh</Button>
          {via === "access" ? (
            <Button variant="ghost" size="sm" asChild><a href="/cdn-cgi/access/logout"><LogOut />Sign out</a></Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => { storeKey(null); void load(); }}><LogOut />Forget key</Button>
          )}
        </div>
      </div>
      <p id="private-error" role="alert" className={refreshError === "" ? "sr-only" : "rounded-md border border-bad/30 px-4 py-2.5 text-sm text-bad"}>{refreshError}</p>
      <Tabs defaultValue="overview">
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="checks">Checks <Badge variant="secondary">{list(field(data, "checks")).length}</Badge></TabsTrigger>
          <TabsTrigger value="incidents">Incidents <Badge variant="secondary">{list(field(data, "escalation")).length}</Badge></TabsTrigger>
          <TabsTrigger value="log">Notifications</TabsTrigger>
          <TabsTrigger value="contacts">Contacts</TabsTrigger>
          <TabsTrigger value="maintenance">Maintenance</TabsTrigger>
          <TabsTrigger value="deep">Deep payload</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="pt-2"><Overview data={data} summary={summary} /></TabsContent>
        <TabsContent value="checks" className="pt-2"><Checks data={data} /></TabsContent>
        <TabsContent value="incidents" className="pt-2"><Incidents data={data} /></TabsContent>
        <TabsContent value="log" className="pt-2"><Notifications data={data} /></TabsContent>
        <TabsContent value="contacts" className="pt-2"><Contacts data={data} /></TabsContent>
        <TabsContent value="maintenance" className="pt-2"><Maintenance data={data} /></TabsContent>
        <TabsContent value="deep" className="pt-2"><DeepPayload data={data} /></TabsContent>
      </Tabs>
    </div>
  );
}
