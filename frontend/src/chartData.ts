type ChartPoint = { time: number; value: number | null };
type EpochPoint = ChartPoint & {
  processStarted?: number | null;
  uptime?: number | null;
};
/** A JVM restart is a break even when the gap is shorter than the sampling interval. */
export function withEpochBreaks(points: EpochPoint[]): ChartPoint[] {
  const ordered = [...points]
    .filter((point) => Number.isFinite(point.time))
    .sort((a, b) => a.time - b.time);
  const result: ChartPoint[] = [];
  let previous: EpochPoint | undefined;
  for (const point of ordered) {
    if (
      previous &&
      ((point.processStarted != null &&
        previous.processStarted != null &&
        point.processStarted !== previous.processStarted) ||
        (point.uptime != null &&
          previous.uptime != null &&
          point.uptime < previous.uptime))
    )
      result.push({ time: point.time, value: null });
    result.push(point);
    previous = point;
  }
  return result;
}
/** Null values and unusually large sampling gaps remain visible as breaks. */
export function chartSegments(
  points: ChartPoint[],
  nominalMilliseconds: number,
): ChartPoint[][] {
  const chronological = [...points]
    .filter((p) => Number.isFinite(p.time))
    .sort((a, b) => a.time - b.time);
  const deltas: number[] = [];
  for (let i = 1; i < chronological.length; i++)
    if (chronological[i].time > chronological[i - 1].time)
      deltas.push(chronological[i].time - chronological[i - 1].time);
  deltas.sort((a, b) => a - b);
  const median = deltas.length >= 3 ? deltas[Math.floor(deltas.length / 2)] : 0;
  const maxGap = Math.max(30_000, nominalMilliseconds * 3, median * 3);
  const segments: ChartPoint[][] = [];
  let current: ChartPoint[] = [],
    previous: ChartPoint | null = null;
  for (const point of chronological) {
    if (point.value === null || !Number.isFinite(point.value)) {
      if (current.length) segments.push(current);
      current = [];
      previous = null;
      continue;
    }
    if (previous && point.time - previous.time > maxGap) {
      segments.push(current);
      current = [];
    }
    current.push(point);
    previous = point;
  }
  if (current.length) segments.push(current);
  return segments;
}
export function chartCsv(points: ChartPoint[], label: string) {
  const quote = (text: string) => '"' + text.replace(/"/g, '""') + '"';
  const safeLabel = /^[\s]*[=+\-@\t\r]/.test(label) ? "'" + label : label;
  const rows = points
    .filter(
      (point) =>
        Number.isFinite(point.time) && Math.abs(point.time) <= 8640000000000000,
    )
    .map(
      (point) =>
        `${quote(new Date(point.time).toISOString())};${point.value != null && Number.isFinite(point.value) ? point.value : ""}`,
    );
  return (
    "\ufeff" +
    [`${quote("Zeitpunkt (UTC)")};${quote(safeLabel)}`, ...rows].join("\r\n") +
    "\r\n"
  );
}
