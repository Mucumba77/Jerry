import { locale, t } from "./i18n";
export type Row = Record<string, any>;
let csrf = "";
export function setCsrf(token: string) {
  csrf = token;
}
export function url(path: string, query?: Row) {
  const base = new URL("./api" + path, window.location.href.split("#")[0]);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null)
      base.searchParams.set(key, String(value));
  });
  return base.toString();
}
export async function api<T = any>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const response = await fetch(url(path), {
    method,
    credentials: "same-origin",
    headers:
      body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.redirected || response.status === 401) {
    const login = new URL("./", window.location.href.split("#")[0]);
    // A cached entry page must not send an expired session back into a reload loop.
    login.searchParams.set("reauth", Date.now().toString(36));
    window.location.replace(login.toString());
    throw new Error(t("Sitzung abgelaufen."));
  }
  if (
    !(response.headers.get("content-type") || "").includes("application/json")
  )
    throw new Error(t("Unerwartete Serverantwort. Bitte neu anmelden."));
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error ? t(result.error) : `HTTP ${response.status}`);
  return result;
}
export async function upload(path: string, file: File) {
  const response = await fetch(url(path), {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-CSRF-Token": csrf,
    },
    body: file,
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(t(result.error || "Upload fehlgeschlagen."));
  return result;
}
export function route(page: string, query?: Row) {
  location.hash =
    page + (query ? "?" + new URLSearchParams(query).toString() : "");
}
export function formatBytes(value: number | null | undefined): string {
  if (value == null || value < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  while (value >= 1024 && index < 4) {
    value /= 1024;
    index++;
  }
  return `${value.toLocaleString(locale(), { maximumFractionDigits: index ? 1 : 0 })} ${units[index]}`;
}
export function formatNumber(value: any, digits = 0): string {
  return value == null || Number.isNaN(Number(value))
    ? "—"
    : Number(value).toLocaleString(locale(), { maximumFractionDigits: digits });
}
export function formatDate(time: number | null | undefined): string {
  return time ? new Date(time).toLocaleString(locale()) : "—";
}
export function duration(ms: number): string {
  if (ms < 1000) return `${formatNumber(ms)} ms`;
  if (ms < 60000) return `${formatNumber(ms / 1000, 1)} s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)} min`;
  return `${Math.floor(ms / 3600000)} h ${Math.floor((ms % 3600000) / 60000)} min`;
}
export function short(value: any): string {
  return value == null
    ? "—"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
}
