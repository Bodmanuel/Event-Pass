/**
 * Thin HTTP client for the EventPass API. The plugin sandbox is stateless, so
 * every fact about inventory, orders and tickets has to come from the API.
 */

const REQUEST_TIMEOUT_MS = 4_000;

export type ApiFailure = {
  ok: false;
  kind: "unreachable" | "http" | "malformed";
  message: string;
  status?: number;
};

export type ApiSuccess<T> = { ok: true; data: T };

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

/**
 * Where the EventPass API lives.
 *
 * The portal's Variables & Secrets should set `EVENTPASS_API_URL`; these are the
 * fallbacks it falls back to.
 *
 * The deployed API is the *default* and local development opts in explicitly,
 * because a hosted sandbox does not reliably set NODE_ENV. Keying the fallback
 * off `NODE_ENV !== "production"` got this backwards: a hosted run that had not
 * set the variable resolved to 127.0.0.1, which is not reachable from a sandbox,
 * so the plugin quietly answered from its bundled catalogue instead of live
 * inventory. Targeting the deployment is the safe default — an unreachable host
 * is reported as unreachable, which is the honest failure.
 */
const DEPLOYED_API_URL = "https://eventpass-api.vercel.app";
const LOCAL_API_URL = "http://127.0.0.1:8787";

export function resolveApiUrl(): string {
  const configured = process.env.EVENTPASS_API_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  // `pnpm dev` against `pnpm start` in the API repo. Explicit, so a hosted
  // runtime can never reach it by accident.
  if (process.env.EVENTPASS_LOCAL === "1") return LOCAL_API_URL;
  return DEPLOYED_API_URL;
}

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const url = `${resolveApiUrl()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { accept: "application/json", ...(init?.body === undefined ? {} : { "content-type": "application/json" }), ...init?.headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? `timed out after ${REQUEST_TIMEOUT_MS} ms` : "could not be reached";
    return { ok: false, kind: "unreachable", message: `EventPass API at ${resolveApiUrl()} ${reason}.` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, kind: "malformed", message: `EventPass API returned a non-JSON response (HTTP ${response.status}).`, status: response.status };
  }

  if (!response.ok) {
    const detail = typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
      ? payload.error
      : `HTTP ${response.status}`;
    return { ok: false, kind: "http", message: detail, status: response.status };
  }
  return { ok: true, data: payload as T };
}

export function apiGet<T>(path: string): Promise<ApiResult<T>> {
  return request<T>(path);
}

export function apiPost<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}
