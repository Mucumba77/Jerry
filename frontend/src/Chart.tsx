import { useContext, useEffect, useId, useRef, useState } from "react";
import { Download } from "lucide-react";
import { formatDate, formatNumber } from "./api";
import type { Row } from "./api";
import { HistoryContext, PERIODS, periodMilliseconds } from "./history";
import { chartCsv, chartSegments, withEpochBreaks } from "./chartData";
import { locale, t, tr } from "./i18n";

export function Chart({
  points,
  value,
  color = "var(--chart-primary)",
  height = 220,
  format = (number: number) =>
    formatNumber(
      number,
      Math.abs(number) >= 100 ? 0 : Math.abs(number) >= 10 ? 1 : 2,
    ),
  label = "Wert",
  exportLabel,
  cursor,
  onCursor,
}: {
  points: Row[];
  value: (point: Row) => number | null | undefined;
  color?: string;
  height?: number;
  format?: (value: number) => string;
  label?: string;
  exportLabel?: string;
  cursor?: number | null;
  onCursor?: (time: number | null) => void;
}) {
  const ref = useRef<SVGSVGElement>(null),
    container = useRef<HTMLDivElement>(null);
  const gradientId = "chart-fill-" + useId().replace(/:/g, "");
  const history = useContext(HistoryContext);
  const [local, setLocal] = useState<number | null>(null),
    [width, setWidth] = useState(720);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = () =>
      setWidth(Math.max(240, Math.round(element.clientWidth - 36)));
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const duration = periodMilliseconds(history?.period || "1h");
  const samples = points
    .map((point) => {
      const result = value(point);
      return {
        time: typeof point.time === "number" ? point.time : NaN,
        value:
          result != null && Number.isFinite(Number(result))
            ? Number(result)
            : null,
        processStarted: point.processStarted,
        uptime: point.uptime,
      };
    })
    .filter((point) => Number.isFinite(point.time));
  const segments = chartSegments(withEpochBreaks(samples), duration / 600);
  const data = segments.flat();
  const minTime = data[0]?.time ?? 0,
    maxTime = data[data.length - 1]?.time ?? 0;
  const max = Math.max(...data.map((point) => point.value!), 1) * 1.15;
  const left = 12,
    right = Math.max(left + 30, width - 82),
    bottom = height - 30;
  const x = (time: number) =>
    left + ((time - minTime) / Math.max(1, maxTime - minTime)) * (right - left);
  const y = (v: number) => bottom - (v / max) * (height - 48);
  const pathFor = (segment: typeof data) =>
    segment
      .map(
        (point, index) =>
          (index ? "L" : "M") +
          x(point.time).toFixed(2) +
          "," +
          y(point.value!).toFixed(2),
      )
      .join(" ");
  const at = cursor ?? local;
  const selected =
    at == null || !data.length
      ? null
      : data.reduce(
          (best, point) =>
            Math.abs(point.time - at) < Math.abs(best.time - at) ? point : best,
          data[0],
        );
  function selectTime(time: number | null) {
    setLocal(time);
    onCursor?.(time);
  }
  function hover(event: React.MouseEvent) {
    const rect = ref.current!.getBoundingClientRect();
    const fraction = Math.max(
      0,
      Math.min(
        1,
        (((event.clientX - rect.left) / rect.width) * width - left) /
          (right - left),
      ),
    );
    selectTime(minTime + fraction * (maxTime - minTime));
  }
  function keyboard(event: React.KeyboardEvent) {
    if (
      !data.length ||
      !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    )
      return;
    event.preventDefault();
    const current = selected ? data.indexOf(selected) : data.length - 1;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? data.length - 1
          : Math.max(
              0,
              Math.min(
                data.length - 1,
                current + (event.key === "ArrowLeft" ? -1 : 1),
              ),
            );
    selectTime(data[next].time);
  }
  function exportCsv() {
    const blob = new Blob([chartCsv(samples, exportLabel || label)], {
      type: "text/csv;charset=utf-8",
    });
    const address = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = address;
    link.download = `jerry-${(exportLabel || label).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "diagramm"}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(address), 1000);
  }
  function axisTime(time: number) {
    return new Date(time).toLocaleString(
      locale(),
      Math.max(duration, maxTime - minTime) > 24 * 3_600_000
        ? {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          }
        : { hour: "2-digit", minute: "2-digit" },
    );
  }
  return (
    <div className="chart-container">
      <div className="chart-tools">
        {history && (
          <label>
            {t("Zeitraum") + " "}
            <select
              aria-label={tr("Zeitraum {0}", label)}
              value={history.period}
              onChange={(event) => history.setPeriod(event.target.value)}
            >
              {PERIODS.map((item) => (
                <option key={item.value} value={item.value}>
                  {t(item.label)}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          className="text-button"
          aria-label={tr("CSV exportieren · {0}", label)}
          disabled={!data.length}
          onClick={exportCsv}
        >
          <Download size={15} /> {t("CSV")}
        </button>
      </div>
      <div className="chart-wrap" ref={container}>
        {!data.length ? (
          <div className="chart-empty" style={{ height }}>
            {history?.loading
              ? t("Messwerte werden geladen …")
              : t("Für diesen Zeitraum liegen noch keine Messwerte vor.")}
          </div>
        ) : (
          <>
            <svg
              ref={ref}
              viewBox={`0 0 ${width} ${height}`}
              height={height}
              role="img"
              tabIndex={0}
              aria-label={tr(
                "{0}. Mit den Pfeiltasten Messpunkte auswählen.",
                label,
              )}
              onMouseMove={hover}
              onMouseLeave={() => selectTime(null)}
              onKeyDown={keyboard}
              onFocus={() => {
                if (local == null) selectTime(maxTime);
              }}
              onBlur={() => selectTime(null)}
            >
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity=".2" />
                  <stop offset="100%" stopColor={color} stopOpacity="0" />
                </linearGradient>
              </defs>
              {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                <g key={f}>
                  <line
                    x1={left}
                    x2={right}
                    y1={y(max * f)}
                    y2={y(max * f)}
                    stroke="var(--line)"
                    strokeDasharray="3 5"
                  />
                  <text
                    x={width - 2}
                    y={y(max * f) - 4}
                    textAnchor="end"
                    className="chart-label"
                  >
                    {format(max * f)}
                  </text>
                </g>
              ))}
              {segments.map((segment, index) => {
                const path = pathFor(segment);
                return (
                  <g key={index}>
                    {segment.length > 1 && (
                      <path
                        d={`${path} L${x(segment[segment.length - 1].time)},${bottom} L${x(segment[0].time)},${bottom} Z`}
                        fill={`url(#${gradientId})`}
                      />
                    )}
                    <path
                      d={path}
                      stroke={color}
                      strokeWidth="2.5"
                      fill="none"
                      strokeLinejoin="round"
                    />
                    {segment.length === 1 && (
                      <circle
                        cx={x(segment[0].time)}
                        cy={y(segment[0].value!)}
                        r="3"
                        fill={color}
                      />
                    )}
                  </g>
                );
              })}
              {selected && (
                <g>
                  <line
                    x1={x(selected.time)}
                    x2={x(selected.time)}
                    y1={5}
                    y2={bottom}
                    stroke={color}
                    strokeDasharray="3 3"
                  />
                  <circle
                    cx={x(selected.time)}
                    cy={y(selected.value!)}
                    r="4"
                    fill={color}
                  />
                </g>
              )}
              <text x={left} y={height - 4} className="chart-label">
                {axisTime(minTime)}
              </text>
              {maxTime !== minTime && (
                <text
                  x={right}
                  y={height - 4}
                  textAnchor="end"
                  className="chart-label"
                >
                  {axisTime(maxTime)}
                </text>
              )}
            </svg>
            {selected && (
              <div className="chart-tooltip" role="status">
                {formatDate(selected.time)}
                <strong>
                  {label}: {format(selected.value!)}
                </strong>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
