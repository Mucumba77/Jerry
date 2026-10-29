import { createContext } from "react";
import type { Row } from "./api";

export const PERIODS = [
  { value: "15m", label: "Letzte 15 Minuten", milliseconds: 15 * 60_000 },
  { value: "1h", label: "Letzte Stunde", milliseconds: 3_600_000 },
  { value: "6h", label: "Letzte 6 Stunden", milliseconds: 6 * 3_600_000 },
  { value: "12h", label: "Letzte 12 Stunden", milliseconds: 12 * 3_600_000 },
  { value: "24h", label: "Letzte 24 Stunden", milliseconds: 24 * 3_600_000 },
  { value: "7d", label: "Letzte 7 Tage", milliseconds: 7 * 24 * 3_600_000 },
  { value: "30d", label: "Letzte 30 Tage", milliseconds: 30 * 24 * 3_600_000 },
] as const;
export const periodMilliseconds = (period: string) =>
  PERIODS.find((item) => item.value === period)?.milliseconds ?? 3_600_000;
export const HistoryContext = createContext<{
  period: string;
  setPeriod: (period: string) => void;
  loading: boolean;
} | null>(null);

/** Keep newer live points received while the historical request was in flight. */
export function mergeHistory(
  rows: Row[],
  previous: Row[],
  requestedTo: number,
  from: number,
) {
  const result = [
    ...rows,
    ...previous.filter((row) => row.time > requestedTo && row.time >= from),
  ]
    .filter((row) => Number.isFinite(row.time) && row.time >= from)
    .sort((a, b) => a.time - b.time);
  return result
    .filter(
      (row, index) =>
        index === result.length - 1 || row.time !== result[index + 1].time,
    )
    .slice(-1000);
}
export function appendHistory(rows: Row[], value: Row, from: number) {
  if (!Number.isFinite(value.time) || value.time < from) return rows;
  return [
    ...rows.filter((row) => row.time !== value.time && row.time >= from),
    value,
  ]
    .sort((a, b) => a.time - b.time)
    .slice(-1000);
}
