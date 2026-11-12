// What a provider call returns. Provider error bodies can echo message contents or account details, so only the
// status code ever leaves a sender, as a short code.
export type DeliveryResult =
  | { readonly ok: true; readonly providerId: string }
  | { readonly ok: false; readonly retryable: boolean; readonly code: string };

/** 429 and 5xx are worth retrying; any other 4xx is a request or configuration problem that will not fix itself. */
export const failure = (prefix: string, status: number): DeliveryResult => ({
  ok: false,
  retryable: status === 408 || status === 429 || status >= 500,
  code: `${prefix}_http_${String(status)}`,
});

export const thrown = (prefix: string, error: unknown): DeliveryResult => ({
  ok: false,
  retryable: true,
  code: error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? `${prefix}_timeout` : `${prefix}_network`,
});
