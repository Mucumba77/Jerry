type Metric = Record<string, unknown>;
/** A total is unavailable if any participating value is missing or unsupported. */
export function completeTotal(
  rows: Metric[] | undefined,
  key: string,
): number | null {
  if (
    !rows?.length ||
    rows.some(
      (row) =>
        typeof row[key] !== "number" ||
        !Number.isFinite(row[key]) ||
        (row[key] as number) < 0,
    )
  )
    return null;
  return rows.reduce((sum, row) => sum + (row[key] as number), 0);
}
