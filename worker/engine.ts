// Folds one run's check results into a component's state. PURE. An incident opens only after
// targets.openAfterFailures consecutive failing runs (at least 2: never page on one blip) and resolves only after
// targets.resolveAfterPasses consecutive passing runs. A component that flaps (fails often but never twice in a row)
// also opens one: at least flapThreshold of the last flapWindow conclusive runs failed (4 of 8 by default, so an
// alternating fail/pass opens on its 7th run while a single blip never does). A run with no conclusive result for a
// component changes nothing for it.
import type { ComponentConfig } from "./config.ts";
import type { CheckResult, Status } from "./types.ts";
import { statusRank, worst } from "./types.ts";

export interface ComponentState {
  readonly id: string;
  readonly status: Status | "unknown";
  readonly consecutiveFailures: number;
  readonly consecutivePasses: number;
  readonly openIncidentId: string | null;
  /** When status last changed (epoch ms). */
  readonly since: number | null;
  readonly lastObservedAt: number | null;
  /**
   * The last conclusive run outcomes, oldest first: "F" failing, "P" passing. Cleared when an incident opens or resolves;
   * runs inside a maintenance window are not added.
   */
  readonly recent: string;
}

export type ComponentTransition = "open" | "resolve" | null;

export interface ComponentStep {
  readonly state: ComponentState;
  readonly transition: ComponentTransition;
  /** True when the run would have opened an incident but a maintenance window held it back. */
  readonly suppressed: boolean;
  /** The run's status for this component, or null when the run held no conclusive result for it. */
  readonly runStatus: Status | null;
}

export const initialComponentState = (id: string): ComponentState => ({
  id, status: "unknown", consecutiveFailures: 0, consecutivePasses: 0, openIncidentId: null, since: null, lastObservedAt: null, recent: "",
});

/** The flapping rule for the given consecutive-failure threshold: at least max(4, 2n) failures in twice that many runs. */
export function flapRule(openAfterFailures: number): { readonly threshold: number; readonly window: number } {
  const threshold = Math.max(4, 2 * openAfterFailures);
  return { threshold, window: 2 * threshold };
}

export const isFailing = (component: ComponentConfig, status: Status): boolean => statusRank(status) >= statusRank(component.pageOn);

export function stepComponent(
  component: ComponentConfig,
  state: ComponentState,
  results: readonly CheckResult[],
  rules: { readonly openAfterFailures: number; readonly resolveAfterPasses: number },
  now: number,
  options: { readonly suppressOpen?: boolean } = {},
): ComponentStep {
  const conclusive = results.filter((result) => result.componentId === component.id && !result.inconclusive);
  if (conclusive.length === 0) return { state, transition: null, runStatus: null, suppressed: false };
  const runStatus = worst(conclusive.map((result) => result.status));
  const failing = isFailing(component, runStatus);
  const consecutiveFailures = failing ? state.consecutiveFailures + 1 : 0;
  const consecutivePasses = failing ? 0 : state.consecutivePasses + 1;
  const flap = flapRule(rules.openAfterFailures);
  const recent = `${state.recent}${failing ? "F" : "P"}`.slice(-flap.window);
  const recentFailures = recent.replaceAll("P", "").length;
  let transition: ComponentTransition = null;
  if (state.openIncidentId === null && failing && (consecutiveFailures >= rules.openAfterFailures || recentFailures >= flap.threshold)) transition = "open";
  if (state.openIncidentId !== null && consecutivePasses >= rules.resolveAfterPasses) transition = "resolve";
  // Maintenance: the failure is counted (the next failing run after the window opens at once) but opens nothing.
  const suppressed = transition === "open" && options.suppressOpen === true;
  if (suppressed) transition = null;
  const next: ComponentState = {
    ...state,
    status: runStatus,
    consecutiveFailures,
    consecutivePasses,
    openIncidentId: transition === "resolve" ? null : state.openIncidentId,
    since: runStatus === state.status ? state.since : now,
    lastObservedAt: now,
    // A fresh window after each transition, so the failures that opened (or preceded) an incident cannot reopen one;
    // that includes an incident resolving inside a maintenance window. Other runs under maintenance stay out of it: a
    // window full of expected failures must not leave the flapping rule primed, or the first single blip after a
    // recovered window would page. consecutiveFailures still counts them, so a component still failing when its window
    // ends opens at once. (A suppressed open is no transition by now, so it keeps state.recent.)
    recent: transition !== null ? "" : options.suppressOpen === true ? state.recent : recent,
  };
  return { state: next, transition, runStatus, suppressed };
}
