// The operator view: everything /api/private returns, behind STATUS_VIEW_KEY. The key lives only in sessionStorage for
// this tab and is sent only as an Authorization header to /api/private. Contacts arrive masked from the Worker.
import { ArrowClockwiseIcon, KeyIcon, LockKeyIcon, SignOutIcon, WarningIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/action-button";
import type { DataColumn, DataRow } from "@/components/ui/data-table";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusPill } from "@/components/ui/status-pill";
import { Inset, Panel, Shell, ShellHeader } from "@/components/ui/surface";
import { Tab, TabList, TabPanel, Tabs } from "@/components/ui/tab-panels";
import { TextField } from "@/components/ui/text-field";
import { TONE, when } from "./format.ts";
import { asStatus, checkName, LABEL } from "./model.ts";
import { focusAfterSwap, monitorFacts, refreshFailedText, str, warningText } from "./operator.ts";

const KEY_STORAGE = "status-monitor-operator-key";

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
const text = (value: unknown): string => str(value);

function StatusCell({ value }: { value: unknown }): React.JSX.Element {
  const status = asStatus(value);
  return <StatusPill size="sm" tone={TONE[status]}>{LABEL[status]}</StatusPill>;
}

function Table<R extends DataRow>({ title, subtitle, rows, columns, empty }: {
  title: string; subtitle?: string; rows: R[]; columns: DataColumn<R>[]; empty: string;
}): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <Shell className="max-w-none">
        <ShellHeader as="h3" title={title} />
        <Panel><EmptyState compact title={empty} /></Panel>
      </Shell>
    );
  }
  return <DataTable className="max-w-none" title={title} {...(subtitle === undefined ? {} : { subtitle })} data={rows} columns={columns} pageSize={10} />;
}

function Overview({ data }: { data: unknown }): React.JSX.Element {
  const monitor = field(data, "monitor");
  const warnings = list(field(monitor, "warnings")).filter((warning): warning is string => typeof warning === "string");
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Shell className="max-w-none">
        <ShellHeader as="h3" title="Monitor" subtitle="Configuration, delivery and the platform link" />
        <Panel className="p-1.5">
          <dl className="grid grid-cols-1 gap-1.5">
            {monitorFacts(monitor, when).map(([label, value]) => (
              <Inset key={label} className="grid gap-0.5 px-3.5 py-2.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3">
                <dt className="text-xs text-muted-foreground sm:text-[0.8125rem]">{label}</dt>
                <dd className="text-sm [overflow-wrap:anywhere]">{value}</dd>
              </Inset>
            ))}
          </dl>
        </Panel>
      </Shell>
      <Shell className="max-w-none">
        <ShellHeader as="h3" icon={WarningIcon} title="Warnings" subtitle={warnings.length === 0 ? "Nothing needs attention" : `${String(warnings.length)} to look at`} />
        <Panel className="p-1.5">
          {warnings.length === 0 ? (
            <EmptyState compact title="No warnings" description="Configuration, channels and the heartbeat all look right." />
          ) : (
            <ul className="space-y-1.5">
              {warnings.map((warning) => (
                <li key={warning} className="rounded-xl bg-foreground/[0.04] px-3.5 py-3">
                  <p className="text-sm text-pretty">{warningText(warning)}</p>
                  <p className="mt-1 font-mono text-[0.6875rem] text-muted-foreground">{warning}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </Shell>
    </div>
  );
}

type CheckRowData = { id: string; check: string; component: string; status: string; detail: string; latency: number | null; observed: string | null };
type LogRowData = { id: string; at: string | null; kind: string; to: string; channel: string; result: string; delivery: string };
type ContactRowData = { id: string; contact: string; channel: string; state: string; code: string; since: string | null };

function Checks({ data }: { data: unknown }): React.JSX.Element {
  const rows: CheckRowData[] = list(field(data, "checks")).map((check) => ({
    id: text(field(check, "id")), check: checkName(text(field(check, "id"))), component: text(field(check, "component")),
    status: text(field(check, "status")), detail: text(field(check, "detail")),
    latency: typeof field(check, "latencyMs") === "number" ? Number(field(check, "latencyMs")) : null, observed: isoField(check, "observedAt"),
  }));
  return (
    <Table title="Latest result per check" rows={rows} empty="No check results yet." columns={[
      { key: "check", label: "Check", sortable: true, priority: 1 },
      { key: "status", label: "Status", sortable: true, priority: 1, format: (value) => <StatusCell value={value} /> },
      { key: "detail", label: "Detail", sortable: true, priority: 2, format: (value) => <span className="font-mono text-xs">{text(value)}</span> },
      { key: "component", label: "Component", sortable: true, priority: 2 },
      { key: "latency", label: "Latency", align: "right", sortable: true, priority: 3, format: (value) => (typeof value === "number" ? `${String(value)} ms` : "—") },
      { key: "observed", label: "Observed", align: "right", sortable: true, priority: 3, format: (value) => when(typeof value === "string" ? value : null) },
    ]} />
  );
}

function Notifications({ data }: { data: unknown }): React.JSX.Element {
  const rows: LogRowData[] = list(field(data, "notifications")).map((entry, index) => {
    const error = field(entry, "lastError"), provider = field(entry, "provider"), delivery = field(entry, "deliveryStatus"), code = field(entry, "deliveryCode");
    const logged = typeof provider === "string" && provider.startsWith("log:") ? " · logged, not sent" : "";
    return {
      id: `${text(field(entry, "incidentId"))}-${String(index)}`, at: isoField(entry, "createdAt"), kind: text(field(entry, "kind")),
      to: `${text(field(entry, "contact"))} (${text(field(entry, "to"))})`, channel: text(field(entry, "channel")),
      result: `${text(field(entry, "status"))} ×${text(field(entry, "attempts"))}${typeof error === "string" ? ` · ${error}` : ""}${logged}`,
      delivery: typeof delivery === "string" ? `${delivery}${typeof code === "string" ? ` · ${code}` : ""}` : "—",
    };
  });
  return (
    <Table title="Notification log" rows={rows} empty="No notifications yet." columns={[
      { key: "at", label: "Created", sortable: true, priority: 1, format: (value) => when(typeof value === "string" ? value : null) },
      { key: "kind", label: "Kind", sortable: true, priority: 1 },
      { key: "to", label: "To", sortable: true, priority: 2 },
      { key: "channel", label: "Channel", sortable: true, priority: 2 },
      { key: "result", label: "Result", priority: 3 },
      { key: "delivery", label: "Delivery", priority: 3 },
    ]} />
  );
}

function Contacts({ data }: { data: unknown }): React.JSX.Element {
  const rows: ContactRowData[] = list(field(data, "contactHealth")).map((row, index) => ({
    id: `${text(field(row, "contactId"))}-${text(field(row, "channel"))}-${String(index)}`, contact: text(field(row, "contactId")),
    channel: text(field(row, "channel")), state: text(field(row, "state")), code: text(field(row, "code")), since: isoField(row, "since"),
  }));
  return (
    <Table title="Contact channel health" rows={rows} empty="Every contact's channels are working." columns={[
      { key: "contact", label: "Contact", sortable: true },
      { key: "channel", label: "Channel", sortable: true },
      { key: "state", label: "State", sortable: true },
      { key: "code", label: "Code" },
      { key: "since", label: "Since", align: "right", format: (value) => when(typeof value === "string" ? value : null) },
    ]} />
  );
}

function Lines({ title, subtitle, items, empty }: { title: string; subtitle?: string; items: [string, string][]; empty: string }): React.JSX.Element {
  return (
    <Shell className="max-w-none">
      <ShellHeader as="h3" title={title} subtitle={subtitle} />
      <Panel className="p-1.5">
        {items.length === 0 ? <EmptyState compact title={empty} /> : (
          <ul className="space-y-1.5">
            {items.map(([head, detail], index) => (
              <li key={`${head}-${String(index)}`} className="rounded-xl bg-foreground/[0.04] px-3.5 py-2.5">
                <p className="text-sm font-medium [overflow-wrap:anywhere]">{head}</p>
                <p className="mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">{detail}</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </Shell>
  );
}

function Incidents({ data }: { data: unknown }): React.JSX.Element {
  const escalation = list(field(data, "escalation")).map((entry): [string, string] => [
    `${text(field(entry, "incidentId"))} · ${text(field(entry, "phase"))}`,
    `cycle ${text(field(entry, "cycle"))}, tier ${text(field(entry, "tierIndex"))} · ack code ${text(field(entry, "ackCode"))} · `
    + `acknowledged by ${text(field(entry, "acknowledgedBy"))} · next step ${when(isoField(entry, "nextStepAt"))}`,
  ]);
  const drills = list(field(data, "drills")).map((drill): [string, string] => [
    `${text(field(drill, "contactId"))} · ${text(field(drill, "outcome") ?? (isoField(drill, "resolvedAt") === null ? "waiting" : "done"))}`,
    `${when(isoField(drill, "openedAt"))}${typeof field(drill, "acknowledgedVia") === "string" ? ` · acknowledged by ${text(field(drill, "acknowledgedVia"))}` : ""}`,
  ]);
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Lines title="Escalation" subtitle="Every incident's paging state" items={escalation} empty="No incidents." />
      <Lines title="Paging drills" items={drills} empty="No drills yet." />
    </div>
  );
}

function Maintenance({ data }: { data: unknown }): React.JSX.Element {
  const components = (value: unknown): string => (value === "all" ? "All components" : list(value).map(text).join(", "));
  const windows = list(field(data, "maintenanceWindows")).map((window): [string, string] => [
    `${components(field(window, "components"))} · ${when(isoField(window, "startsAt"))} to ${when(isoField(window, "endsAt"))}`,
    `${text(field(window, "id"))}${typeof field(window, "note") === "string" ? ` · ${text(field(window, "note"))}` : ""}`,
  ]);
  return <Lines title="Maintenance windows" subtitle="Every configured window, with its note" items={windows} empty="No maintenance windows." />;
}

function DeepPayload({ data }: { data: unknown }): React.JSX.Element {
  const deep = list(field(data, "checks")).filter((check) => field(check, "type") === "deep" && !text(field(check, "id")).includes("."));
  return (
    <Shell className="max-w-none">
      <ShellHeader as="h3" title="Deep health payload" subtitle="As the platform last returned it" />
      <Panel className="p-1.5">
        <Inset className="overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed">{JSON.stringify(deep.map((check) => field(check, "data")), null, 2)}</pre>
        </Inset>
      </Panel>
    </Shell>
  );
}

export function OperatorView(): React.JSX.Element {
  const [data, setData] = useState<unknown>(null);
  const [shown, setShown] = useState<"form" | "data">(storedKey() === null ? "form" : "data");
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

  const load = useCallback(async () => {
    const key = storedKey();
    const locked = (): void => {
      swap("form");
      setRefreshError("");
      loadedAt.current = null;
      setData(null);
    };
    if (key === null) {
      locked();
      return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/private", { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, cache: "no-store" });
      if (response.status === 401) {
        storeKey(null);
        locked();
        setKeyError("That key was not accepted.");
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      const body: unknown = await response.json();
      setData(body);
      loadedAt.current = new Date().toISOString();
      setKeyError("");
      setRefreshError("");
      swap("data");
    } catch {
      if (loadedAt.current === null) {
        swap("form");
        setKeyError("The operator view could not be loaded. Try again.");
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

  if (shown === "form" || data === null) {
    return (
      <div className="mx-auto max-w-md pt-6">
        <h1 className="sr-only">Operator view</h1>
        <Shell>
          <ShellHeader as="h2" icon={LockKeyIcon} title="Operator view" subtitle="Every check, escalation and notification" />
          <Panel className="p-5">
            <form
              ref={formRef}
              id="key-form"
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                const input = new FormData(event.currentTarget).get("key");
                if (typeof input !== "string" || input.trim() === "") return;
                storeKey(input.trim());
                event.currentTarget.reset();
                void load();
              }}
            >
              <TextField
                id="view-key"
                name="key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                label="Operator key"
                description="Kept in this tab only and sent only to this site."
                {...(keyError === "" ? {} : { error: keyError })}
              />
              <Button type="submit" variant="primary" size="md" icon={KeyIcon} loading={loading} className="w-full">Open operator view</Button>
            </form>
          </Panel>
        </Shell>
      </div>
    );
  }

  return (
    <div ref={contentRef} id="private-content" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3 px-1">
        <div>
          <h1 id="private-monitor-heading" tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">Operator view</h1>
          <p className="text-sm text-muted-foreground">Loaded {when(loadedAt.current)}</p>
        </div>
        <div className="flex gap-1.5">
          <Button icon={ArrowClockwiseIcon} iconWeight="bold" loading={loading} onClick={() => void load()}>Refresh</Button>
          <Button variant="quiet" icon={SignOutIcon} onClick={() => { storeKey(null); void load(); }}>Forget key</Button>
        </div>
      </div>
      <p id="private-error" role="alert" className={refreshError === "" ? "sr-only" : "rounded-xl bg-negative/10 px-4 py-2.5 text-sm text-negative"}>{refreshError}</p>
      <Tabs defaultValue="overview" variant="pills">
        <TabList label="Operator sections">
          <Tab value="overview">Overview</Tab>
          <Tab value="checks" count={list(field(data, "checks")).length}>Checks</Tab>
          <Tab value="incidents" count={list(field(data, "escalation")).length}>Incidents</Tab>
          <Tab value="log" count={list(field(data, "notifications")).length}>Notifications</Tab>
          <Tab value="contacts">Contacts</Tab>
          <Tab value="maintenance">Maintenance</Tab>
          <Tab value="deep">Deep payload</Tab>
        </TabList>
        <div className="pt-3">
          <TabPanel value="overview"><Overview data={data} /></TabPanel>
          <TabPanel value="checks" lazy><Checks data={data} /></TabPanel>
          <TabPanel value="incidents" lazy><Incidents data={data} /></TabPanel>
          <TabPanel value="log" lazy><Notifications data={data} /></TabPanel>
          <TabPanel value="contacts" lazy><Contacts data={data} /></TabPanel>
          <TabPanel value="maintenance" lazy><Maintenance data={data} /></TabPanel>
          <TabPanel value="deep" lazy><DeepPayload data={data} /></TabPanel>
        </div>
      </Tabs>
    </div>
  );
}
