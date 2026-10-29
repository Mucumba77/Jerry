import { locale, t } from "./i18n";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  RefreshCw,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { api, formatDate, formatNumber, Row, short } from "./api";

export const UserContext = createContext<Row>({ permissions: {} });
export const useUser = () => useContext(UserContext);
export const SnapshotContext = createContext<Row | null>(null);
export const useSnapshot = () => useContext(SnapshotContext);
export const NotifyContext = createContext<
  (text: string, type?: "success" | "error") => void
>(() => {});
export const useNotify = () => useContext(NotifyContext);
export function useLoad<T = any>(
  path: string | null,
  deps: unknown[] = [],
  interval = 0,
) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!path) {
      setLoading(false);
      return;
    }
    const current = ++generation.current;
    try {
      const value = await api<T>(path);
      if (current === generation.current) {
        setData(value);
        setError("");
      }
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [path, ...deps]);
  useEffect(() => {
    setLoading(true);
    setData(null);
    void refresh();
    const timer = interval ? window.setInterval(refresh, interval) : undefined;
    return () => {
      generation.current++;
      if (timer) clearInterval(timer);
    };
  }, [refresh, interval]);
  return { data, setData, error, loading, refresh };
}
export function ErrorBox({ error }: { error: string }) {
  return error ? (
    <div className="error-box" role="alert">
      <AlertCircle size={17} />
      <span>{t(error)}</span>
    </div>
  ) : null;
}
export function Loading() {
  return (
    <div className="loading">
      <Loader2 size={23} className="spin" />
      <span>{t("Wird geladen …")}</span>
    </div>
  );
}
export function Empty({
  title = "Noch keine Daten",
  detail = "Hier erscheinen die Daten, sobald sie verfügbar sind.",
  children,
}: {
  title?: string;
  detail?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-orbit">
        <Search size={24} />
      </span>
      <h3>{t(title)}</h3>
      <p>{t(detail)}</p>
      {children}
    </div>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return (
    <span className={"badge " + tone}>
      <i />
      {children}
    </span>
  );
}
export function PageTitle({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      <div className="page-actions">{actions}</div>
    </div>
  );
}
export function Panel({
  title,
  subtitle,
  description,
  actions,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={"panel " + className}>
      {(title || actions) && (
        <div className="panel-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <div className="panel-actions">{actions}</div>
        </div>
      )}
      {description && <p className="panel-description">{description}</p>}
      {children}
    </section>
  );
}
export function Refresh({ onClick }: { onClick: () => void }) {
  return (
    <button className="button" onClick={onClick}>
      <RefreshCw size={15} />
      {t("Aktualisieren") + " "}
    </button>
  );
}
export function Tabs({
  value,
  onChange,
  items,
}: {
  value: string;
  onChange: (value: string) => void;
  items: [string, string][];
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map(([id, label]) => (
        <button
          key={id}
          role="tab"
          aria-selected={id === value}
          className={id === value ? "selected" : ""}
          onClick={() => onChange(id)}
        >
          {t(label)}
        </button>
      ))}
    </div>
  );
}
export function Code({ value }: { value: any }) {
  return (
    <pre className="code-view">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null),
    closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.focus();
    function key(e: KeyboardEvent) {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab") {
        const items = ref.current?.querySelectorAll<HTMLElement>(
          "button,input,select,textarea,a[href]",
        );
        if (!items?.length) return;
        const first = items[0],
          last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={"modal " + (wide ? "wide" : "")}
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label={t("Schließen")}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function Confirm({
  title,
  detail,
  onConfirm,
  onClose,
  danger = false,
}: {
  title: string;
  detail: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  danger?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title={title} onClose={onClose}>
      <p className="modal-description">{detail}</p>
      <ErrorBox error={error} />
      <div className="modal-actions">
        <button className="button" onClick={onClose}>
          {t("Abbrechen") + " "}
        </button>
        <button
          className={"button " + (danger ? "danger" : "primary")}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Loader2 size={15} className="spin" />}
          {t("Bestätigen") + " "}
        </button>
      </div>
    </Modal>
  );
}
export type Column = {
  key: string;
  label: string;
  render?: (value: any, row: Row) => React.ReactNode;
  sort?: (row: Row) => string | number;
  hidden?: boolean;
};
export function DataTable({
  rows,
  columns,
  id,
  searchable = true,
  onRow,
  empty = "Keine Einträge",
  pageSize = 25,
}: {
  rows: Row[];
  columns: Column[];
  id: string;
  searchable?: boolean;
  onRow?: (row: Row) => void;
  empty?: string;
  pageSize?: number;
}) {
  const [query, setQuery] = useState(""),
    [sort, setSort] = useState(""),
    [descending, setDescending] = useState(false),
    [page, setPage] = useState(0),
    [chooser, setChooser] = useState(false);
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      return (
        JSON.parse(localStorage.getItem("jerry.columns." + id) || "null") ||
        columns.filter((c) => c.hidden).map((c) => c.key)
      );
    } catch {
      return [];
    }
  });
  const filtered = useMemo(() => {
    let result = rows.filter(
      (row) =>
        !query ||
        Object.values(row).some((value) =>
          short(value).toLowerCase().includes(query.toLowerCase()),
        ),
    );
    const col = columns.find((c) => c.key === sort);
    if (col)
      result = [...result].sort((a, b) => {
        const av = col.sort ? col.sort(a) : a[sort],
          bv = col.sort ? col.sort(b) : b[sort];
        return (
          (typeof av === "number" && typeof bv === "number"
            ? av - bv
            : String(av ?? "").localeCompare(String(bv ?? ""), locale(), {
                numeric: true,
              })) * (descending ? -1 : 1)
        );
      });
    return result;
  }, [rows, query, sort, descending, columns, locale()]);
  const visible = columns.filter((c) => !hidden.includes(c.key));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pages - 1);
  function toggle(key: string) {
    const next = hidden.includes(key)
      ? hidden.filter((h) => h !== key)
      : [...hidden, key];
    if (columns.length - next.length < 1) return;
    setHidden(next);
    localStorage.setItem("jerry.columns." + id, JSON.stringify(next));
  }
  return (
    <div className="data-table">
      {searchable && (
        <div className="table-toolbar">
          <label className="search-input">
            <Search size={16} />
            <input
              placeholder={t("Einträge filtern …")}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
              aria-label={t("Tabelle filtern")}
            />
          </label>
          <span className="table-count">
            {formatNumber(filtered.length)} {t("Einträge") + " "}
          </span>
          <div className="column-selector">
            <button
              className="icon-button"
              aria-label={t("Spalten auswählen")}
              onClick={() => setChooser(!chooser)}
            >
              <Settings2 size={17} />
            </button>
            {chooser && (
              <div className="popover">
                {columns.map((col) => (
                  <label key={col.key}>
                    <input
                      type="checkbox"
                      checked={!hidden.includes(col.key)}
                      onChange={() => toggle(col.key)}
                    />
                    {t(col.label)}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {visible.map((col) => (
                <th
                  key={col.key}
                  aria-sort={
                    sort === col.key
                      ? descending
                        ? "descending"
                        : "ascending"
                      : undefined
                  }
                >
                  <button
                    onClick={() => {
                      setSort(col.key);
                      setDescending(sort === col.key ? !descending : false);
                    }}
                  >
                    {t(col.label)}
                    {sort === col.key ? (
                      descending ? (
                        <ArrowDown size={12} />
                      ) : (
                        <ArrowUp size={12} />
                      )
                    ) : null}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered
              .slice(current * pageSize, (current + 1) * pageSize)
              .map((row, index) => (
                <tr
                  key={String(row.id ?? row.objectName ?? row.name ?? index)}
                  className={onRow ? "clickable" : ""}
                  onClick={() => onRow?.(row)}
                  tabIndex={onRow ? 0 : undefined}
                  onKeyDown={(e) => {
                    if (
                      onRow &&
                      e.target === e.currentTarget &&
                      (e.key === "Enter" || e.key === " ")
                    ) {
                      e.preventDefault();
                      onRow(row);
                    }
                  }}
                >
                  {visible.map((col) => (
                    <td key={col.key}>
                      {col.render
                        ? col.render(row[col.key], row)
                        : short(row[col.key])}
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
        {!filtered.length && (
          <Empty
            title={t(empty)}
            detail={
              query
                ? t("Passe den Suchbegriff an.")
                : t("Es sind derzeit keine Einträge vorhanden.")
            }
          />
        )}
      </div>
      {pages > 1 && (
        <div className="pagination">
          <span>
            {current * pageSize + 1}–
            {Math.min((current + 1) * pageSize, filtered.length)} {t("von")}{" "}
            {filtered.length}
          </span>
          <div>
            <button
              className="icon-button"
              disabled={!current}
              onClick={() => setPage(current - 1)}
              aria-label={t("Vorherige Seite")}
            >
              <ChevronLeft size={17} />
            </button>
            <span>
              {current + 1} / {pages}
            </span>
            <button
              className="icon-button"
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
              aria-label={t("Nächste Seite")}
            >
              <ChevronRight size={17} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
export function KeyValues({ data }: { data: Row }) {
  return (
    <dl className="key-values">
      {Object.entries(data).map(([key, value]) => (
        <div key={key}>
          <dt>{t(key)}</dt>
          <dd>{short(value)}</dd>
        </div>
      ))}
    </dl>
  );
}
export { Chart } from "./Chart";
export function DownloadLink({
  href,
  children,
}: {
  href: string;
  children?: React.ReactNode;
}) {
  return (
    <a className="button" href={href} download>
      <Download size={14} />
      {children || t("Herunterladen")}
    </a>
  );
}
