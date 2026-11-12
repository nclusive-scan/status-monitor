// The status page script (built to dist/app.js by scripts/build-status-page.ts). No external resources, no innerHTML:
// every value from the API is written with textContent. The operator key lives only in sessionStorage for this tab and
// is sent only as an Authorization header to /api/private.
//
// Screen readers: the overall headline is mirrored into a polite live region (#announce) only when it changes. The
// "Last checked" line is rewritten every refresh, so it sits outside any live region.
import type { ComponentView, Shown, Summary } from "./model.ts";
import { asStatus, isPublicStatus, LABEL, siteName, summarize, unavailable } from "./model.ts";
import { focusAfterSwap, monitorFacts, refreshFailedText, str, warningText } from "./operator.ts";

const KEY_STORAGE = "status-monitor-operator-key";
const REFRESH_MS = 30_000;

const byId = <T extends HTMLElement>(id: string, type: new () => T): T => {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Missing #${id}`);
  return element;
};

function el(tag: string, text?: string, attributes: Record<string, string> = {}): HTMLElement {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

const when = (iso: string | null): string => (iso === null ? "—" : new Date(iso).toLocaleString());
/** The public view's times: "Nov 11, 9:53 PM" (no seconds, no year), in the viewer's locale and time zone. */
const SHORT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
const short = (iso: string | null): string => (iso === null ? "—" : new Date(iso).toLocaleString(undefined, SHORT));
const percent = (value: number | null): string => (value === null ? "—" : `${value.toFixed(value === 100 ? 0 : 2)}%`);

function pill(status: Shown, label: string): HTMLElement {
  return el("span", label, { class: "pill", "data-status": status });
}

function replace(container: HTMLElement, children: Node[], empty: string): void {
  container.replaceChildren(...(children.length > 0 ? children : [el("li", empty, { class: "muted" })]));
}

// ---- Public view ----

let lastGood: Summary | null = null;
let announced = "";

function componentRow(component: ComponentView): HTMLElement {
  const row = el("tr");
  const status = el("td");
  status.append(pill(component.shown, component.label));
  if (component.note !== null) status.append(el("span", component.note, { class: "note muted" }));
  row.append(
    el("th", component.name, { scope: "row" }), status, el("td", percent(component.uptime.h24)), el("td", percent(component.uptime.d7)),
    el("td", percent(component.uptime.d30)),
  );
  return row;
}

function incidentItem(lines: readonly string[]): HTMLElement {
  const li = el("li");
  li.append(el("div", lines[0] ?? "", { class: "title" }), el("div", lines[1] ?? "", { class: "muted" }));
  return li;
}

function render(summary: Summary): void {
  byId("overall", HTMLDivElement).dataset["status"] = summary.overall;
  const heading = byId("overall-heading", HTMLHeadingElement);
  if (heading.textContent !== summary.headline) heading.textContent = summary.headline;
  if (announced !== summary.headline) {
    announced = summary.headline;
    byId("announce", HTMLParagraphElement).textContent = summary.headline;
  }
  byId("freshness", HTMLParagraphElement).textContent = summary.freshness;
  // The empty state (no public component) is the banner alone: no empty tables or incident lists under it.
  for (const id of ["components-section", "open-section", "history-section"]) byId(id, HTMLElement).hidden = summary.overall === "none";

  const rows = summary.components.map(componentRow);
  if (rows.length === 0) {
    const text = summary.incidents === null ? "Component status is unavailable right now." : "No components are monitored.";
    rows.push(el("tr"));
    rows[0]?.append(el("td", text, { colspan: "5", class: "muted" }));
  }
  byId("components", HTMLTableSectionElement).replaceChildren(...rows);

  const section = byId("maintenance-section", HTMLElement);
  section.hidden = summary.maintenance.length === 0;
  byId("maintenance", HTMLUListElement).replaceChildren(...summary.maintenance.map((window) => {
    const li = el("li", undefined, { "data-active": String(window.active) });
    li.append(el("div", window.components, { class: "title" }), el("div", window.when, { class: "muted" }));
    return li;
  }));

  const openList = byId("open-incidents", HTMLUListElement);
  const history = byId("history", HTMLUListElement);
  if (summary.incidents === null) {
    for (const list of [openList, history]) list.replaceChildren(el("li", "Incident information is unavailable right now.", { class: "muted" }));
    return;
  }
  replace(openList, summary.incidents.open.map(incidentItem), "No open incidents.");
  replace(history, summary.incidents.past.map(incidentItem), "No incidents in the past 35 days.");
}

/**
 * The brand from /api/status names the page: the title, the masthead ("Acme <muted>status</muted>") and the
 * description. index.html holds the neutral fallback ("Status") until the first answer.
 */
function showBrand(name: string): void {
  if (document.title !== name) document.title = name;
  const masthead = byId("brand", HTMLParagraphElement);
  if (masthead.dataset["name"] === name) return;
  masthead.dataset["name"] = name;
  const brand = name.endsWith(" status") ? name.slice(0, -" status".length) : null;
  masthead.replaceChildren(...(brand === null ? [name] : [`${brand} `, el("span", "status")]));
  document.querySelector('meta[name="description"]')?.setAttribute("content", brand === null ? "Live service status." : `Live service status for ${brand}.`);
}

async function loadPublic(): Promise<void> {
  try {
    const response = await fetch("/api/status", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(String(response.status));
    const data: unknown = await response.json();
    if (!isPublicStatus(data)) throw new Error("shape");
    showBrand(siteName(data.brand));
    lastGood = summarize(data, short);
    render(lastGood);
  } catch {
    render(unavailable(lastGood));
  }
}

// ---- Operator view ----

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
    // Storage blocked: the key lives only in the form field.
  }
}

const field = (record: unknown, key: string): unknown => (typeof record === "object" && record !== null ? Reflect.get(record, key) : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const isoField = (record: unknown, key: string): string | null => {
  const value = field(record, key);
  return typeof value === "string" ? value : null;
};

function tableRows(tbodyId: string, rows: unknown[], cells: (row: unknown) => (string | Node)[], empty: string, columns: number): void {
  const body = byId(tbodyId, HTMLTableSectionElement);
  const rendered = rows.map((row) => {
    const tr = el("tr");
    for (const [index, content] of cells(row).entries()) {
      const cell = index === 0 ? el("th", undefined, { scope: "row" }) : el("td");
      cell.append(content);
      tr.append(cell);
    }
    return tr;
  });
  if (rendered.length === 0) {
    const tr = el("tr");
    tr.append(el("td", empty, { colspan: String(columns), class: "muted" }));
    rendered.push(tr);
  }
  body.replaceChildren(...rendered);
}

const componentsText = (value: unknown): string => (value === "all" ? "All components" : list(value).map(str).join(", "));

function renderPrivate(data: unknown): void {
  const monitor = field(data, "monitor");
  const facts = byId("private-monitor", HTMLElement);
  facts.replaceChildren();
  for (const [label, value] of monitorFacts(monitor, when)) facts.append(el("dt", label), el("dd", value));

  const warnings = list(field(monitor, "warnings")).filter((warning) => typeof warning === "string");
  replace(byId("private-warnings", HTMLUListElement), warnings.map((warning) => {
    const li = el("li", undefined, { "data-warning": warning.split(":")[0] ?? "" });
    li.append(el("div", warningText(warning), { class: "title" }), el("div", warning, { class: "muted code" }));
    return li;
  }), "No warnings.");

  tableRows("private-checks", list(field(data, "checks")), (check) => {
    const latency = field(check, "latencyMs");
    return [
      str(field(check, "id")), str(field(check, "component")), pill(asStatus(field(check, "status")), LABEL[asStatus(field(check, "status"))]),
      str(field(check, "detail")),
      typeof latency === "number" ? `${String(latency)} ms` : "—", when(isoField(check, "observedAt")),
    ];
  }, "No check results yet.", 6);

  tableRows("private-contacts", list(field(data, "contactHealth")), (row) => [
    str(field(row, "contactId")), str(field(row, "channel")), str(field(row, "state")), str(field(row, "code")), when(isoField(row, "since")),
  ], "Every contact's channels are working.", 5);

  replace(byId("private-maintenance", HTMLUListElement), list(field(data, "maintenanceWindows")).map((window) => {
    const li = el("li");
    li.append(
      el("div", `${componentsText(field(window, "components"))} · ${when(isoField(window, "startsAt"))} to ${when(isoField(window, "endsAt"))}`, {
        class: "title",
      }),
      el("div", `${str(field(window, "id"))}${typeof field(window, "note") === "string" ? ` · ${str(field(window, "note"))}` : ""}`, { class: "muted" }),
    );
    return li;
  }), "No maintenance windows.");

  const escalation = list(field(data, "escalation")).map((entry) => {
    const li = el("li");
    li.append(el("div", `${str(field(entry, "incidentId"))} · ${str(field(entry, "phase"))}`, { class: "title" }));
    li.append(el("div", `cycle ${str(field(entry, "cycle"))}, tier ${str(field(entry, "tierIndex"))} · ack code ${str(field(entry, "ackCode"))} · ` +
      `acknowledged by ${str(field(entry, "acknowledgedBy"))} · next step ${when(isoField(entry, "nextStepAt"))}`, { class: "muted" }));
    return li;
  });
  replace(byId("private-escalation", HTMLUListElement), escalation, "No incidents.");

  replace(byId("private-drills", HTMLUListElement), list(field(data, "drills")).map((drill) => {
    const li = el("li");
    li.append(
      el("div", `${str(field(drill, "contactId"))} · ${str(field(drill, "outcome") ?? (isoField(drill, "resolvedAt") === null ? "waiting" : "done"))}`, {
        class: "title",
      }),
      el("div", `${when(isoField(drill, "openedAt"))}${
        typeof field(drill, "acknowledgedVia") === "string" ? ` · acknowledged by ${str(field(drill, "acknowledgedVia"))}` : ""
      }`, { class: "muted" }),
    );
    return li;
  }), "No drills yet.");

  tableRows("private-log", list(field(data, "notifications")), (entry) => {
    const error = field(entry, "lastError");
    const provider = field(entry, "provider");
    const logged = typeof provider === "string" && provider.startsWith("log:") ? " · logged, not sent" : "";
    const delivery = field(entry, "deliveryStatus");
    const code = field(entry, "deliveryCode");
    return [
      when(isoField(entry, "createdAt")), str(field(entry, "kind")), `${str(field(entry, "contact"))} (${str(field(entry, "to"))})`,
      str(field(entry, "channel")),
      `${str(field(entry, "status"))} ×${str(field(entry, "attempts"))}${typeof error === "string" ? ` · ${error}` : ""}${logged}`,
      typeof delivery === "string" ? `${delivery}${typeof code === "string" ? ` · ${code}` : ""}` : "—",
    ];
  }, "No notifications yet.", 6);

  const deep = list(field(data, "checks")).filter((check) => field(check, "type") === "deep" && !str(field(check, "id")).includes("."));
  byId("private-deep", HTMLPreElement).textContent = JSON.stringify(deep.map((check) => field(check, "data")), null, 2);
}

/** When the operator data on screen was loaded (null: none yet). */
let privateLoadedAt: string | null = null;

async function loadPrivate(): Promise<void> {
  const key = storedKey();
  const error = byId("key-error", HTMLParagraphElement);
  // Inside the data, so a failed refresh is seen (and announced) while the key form is hidden.
  const refreshError = byId("private-error", HTMLParagraphElement);
  const content = byId("private-content", HTMLDivElement);
  const form = byId("key-form", HTMLFormElement);
  /** Shows one part, hides the other, and hands focus over when it was inside the part now hidden (focusAfterSwap). */
  const swap = (shown: "form" | "data"): void => {
    const hidden = shown === "form" ? content : form;
    const target = focusAfterSwap(shown, hidden.hidden === false && hidden.contains(document.activeElement));
    content.hidden = shown === "form";
    form.hidden = shown === "data";
    if (target !== null) byId(target, HTMLElement).focus();
  };
  const locked = (): void => {
    swap("form");
    refreshError.textContent = "";
    privateLoadedAt = null;
  };
  if (key === null) {
    locked();
    return;
  }
  try {
    const response = await fetch("/api/private", { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, cache: "no-store" });
    if (response.status === 401) {
      storeKey(null);
      locked();
      error.textContent = "That key was not accepted.";
      return;
    }
    if (!response.ok) throw new Error(String(response.status));
    const data: unknown = await response.json();
    renderPrivate(data);
    privateLoadedAt = new Date().toISOString();
    error.textContent = "";
    refreshError.textContent = "";
    swap("data");
  } catch {
    if (content.hidden !== false) error.textContent = "The operator view could not be loaded. Try again.";
    else {
      // Older data stays on screen, with a visible (and announced) note that it could not be refreshed and from when it is.
      refreshError.textContent = refreshFailedText(privateLoadedAt, when);
    }
  }
}

function showView(view: "public" | "private"): void {
  byId("public-view", HTMLElement).hidden = view !== "public";
  byId("private-view", HTMLElement).hidden = view !== "private";
  byId("show-public", HTMLButtonElement).setAttribute("aria-pressed", String(view === "public"));
  byId("show-private", HTMLButtonElement).setAttribute("aria-pressed", String(view === "private"));
  if (view === "private") void loadPrivate();
  byId("main", HTMLElement).focus();
}

function start(): void {
  byId("show-public", HTMLButtonElement).addEventListener("click", () => {
    showView("public");
  });
  byId("show-private", HTMLButtonElement).addEventListener("click", () => {
    showView("private");
  });
  byId("key-form", HTMLFormElement).addEventListener("submit", (event) => {
    event.preventDefault();
    const input = byId("view-key", HTMLInputElement);
    storeKey(input.value.trim());
    input.value = "";
    void loadPrivate();
  });
  byId("forget-key", HTMLButtonElement).addEventListener("click", () => {
    storeKey(null);
    void loadPrivate();
  });
  byId("refresh-private", HTMLButtonElement).addEventListener("click", () => void loadPrivate());
  void loadPublic();
  setInterval(() => void loadPublic(), REFRESH_MS);
}

start();
