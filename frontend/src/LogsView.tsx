import { locale, t } from "./i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowDown,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  FolderOpen,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Search,
  Settings2,
  Square,
  Terminal,
  WrapText,
  X,
} from "lucide-react";
import { api, formatBytes, formatDate, formatNumber, Row, url } from "./api";
import {
  Badge,
  Confirm,
  DataTable,
  DownloadLink,
  Empty,
  ErrorBox,
  KeyValues,
  Loading,
  Modal,
  PageTitle,
  Panel,
  Tabs,
  useLoad,
  useNotify,
  useUser,
} from "./components";

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase(),
    find = query.toLowerCase();
  const chunks: React.ReactNode[] = [];
  let start = 0,
    index;
  while ((index = lower.indexOf(find, start)) >= 0) {
    chunks.push(
      text.slice(start, index),
      <mark key={index}>{text.slice(index, index + query.length)}</mark>,
    );
    start = index + query.length;
    if (chunks.length > 100) break;
  }
  chunks.push(text.slice(start));
  return <>{chunks}</>;
}
function lineGroups(lines: Row[]) {
  const groups: Row[][] = [];
  for (const row of lines) {
    if (
      /^\s|^Caused by:|^Suppressed:|^\.\.\. \d+ more/.test(row.text) &&
      groups.length
    )
      groups[groups.length - 1].push(row);
    else groups.push([row]);
  }
  return groups;
}
export default function LogsView() {
  const files = useLoad<Row[]>("/logs", [], 30000),
    user = useUser(),
    notify = useNotify();
  const [selected, setSelected] = useState(""),
    [checked, setChecked] = useState<string[]>([]),
    [filter, setFilter] = useState(""),
    [encoding, setEncoding] = useState("UTF-8"),
    [page, setPage] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [tail, setTail] = useState(false),
    [wrap, setWrap] = useState(false),
    [query, setQuery] = useState(""),
    [level, setLevel] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [thread, setThread] = useState(""),
    [logger, setLogger] = useState(""),
    [search, setSearch] = useState<Row | null>(null),
    [searching, setSearching] = useState(false),
    [showFilters, setShowFilters] = useState(false),
    [loggers, setLoggers] = useState(false),
    [expanded, setExpanded] = useState<Set<number>>(new Set());
  const viewport = useRef<HTMLDivElement>(null),
    generation = useRef(0),
    pageRef = useRef<Row | null>(page);
  pageRef.current = page;
  const file = files.data?.find((f) => f.id === selected);
  const groups = useMemo(() => lineGroups(page?.lines || []), [page]);
  useEffect(() => {
    if (!selected && files.data?.length) setSelected(files.data[0].id);
  }, [files.data]);
  async function load(cursor = -1, direction?: string, append = false) {
    if (!selected) return;
    const current = ++generation.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        cursor: String(cursor),
        limit: "500",
        encoding,
        ...(direction ? { direction } : {}),
        ...(pageRef.current?.identity
          ? { identity: pageRef.current.identity }
          : {}),
      });
      const next = await api<Row>("/logs/" + selected + "?" + params);
      if (current !== generation.current) return;
      if (append && pageRef.current && !next.rotated) {
        next.lines = [...pageRef.current.lines, ...next.lines].slice(-2000);
        next.start = next.lines[0]?.offset ?? next.start;
      }
      setPage(next);
      setError("");
      if (append)
        requestAnimationFrame(() => {
          if (viewport.current)
            viewport.current.scrollTop = viewport.current.scrollHeight;
        });
      if (next.rotated)
        notify(
          t("Logrotation oder Kürzung erkannt. Ansicht wurde zurückgesetzt."),
        );
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    setPage(null);
    pageRef.current = null;
    setExpanded(new Set());
    setTail(false);
    void load();
    return () => {
      generation.current++;
    };
  }, [selected, encoding]);
  useEffect(() => {
    if (!tail || !selected) return;
    let alive = true,
      timer: number;
    async function tick() {
      if (!alive) return;
      await load(pageRef.current?.next ?? -1, undefined, true);
      if (alive) timer = window.setTimeout(tick, 2000);
    }
    timer = window.setTimeout(tick, 2000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [tail, selected, encoding]);
  useEffect(() => {
    if (!search?.id || !["RUNNING", "QUEUED"].includes(search.state)) return;
    let alive = true;
    const timer = window.setInterval(async () => {
      try {
        const next = await api<Row>("/logs/search/" + search.id);
        if (alive) setSearch(next);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    }, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [search?.id, search?.state]);
  async function runSearch() {
    setSearching(true);
    setTail(false);
    setError("");
    try {
      if (search?.id) await api("/logs/search/" + search.id, {}, "DELETE");
      const ids = checked.length ? checked : selected ? [selected] : [];
      const result = await api<Row>("/logs/search", {
        files: ids,
        query,
        level,
        from: from ? new Date(from).getTime() : 0,
        to: to ? new Date(to).getTime() : 0,
        thread,
        logger,
        encoding,
        context: 2,
        maxHits: 2000,
      });
      setSearch({ ...result, state: "QUEUED", hits: [] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  }
  function snippet() {
    const text = (
      search
        ? search.hits.map((r: Row) => r.name + ":" + r.line + " " + r.text)
        : page?.lines?.map((r: Row) => r.text) || []
    ).join("\r\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = "jerry-log-ausschnitt.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
  const filteredFiles = (files.data || []).filter((f) =>
    f.name.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <>
      <PageTitle
        eyebrow={t("DIAGNOSE / DATEIEN")}
        title={t("Log-Explorer")}
        description={t(
          "Aktuelle und archivierte Logs. Zusammenhängende Stacktraces. Suche über Rotationen.",
        )}
        actions={
          <>
            {user.permissions.admin && (
              <button className="button" onClick={() => setLoggers(true)}>
                <Settings2 size={15} />
                {t("Logger-Level") + " "}
              </button>
            )}
            <button className="button" onClick={files.refresh}>
              <RefreshCw size={15} />
              {t("Dateien") + " "}
            </button>
          </>
        }
      />
      <ErrorBox error={error || files.error} />
      <div className="log-shell">
        <aside className="log-files">
          <div className="schema-title">
            <span>{t("LOG-DATEIEN")}</span>
            <span>{files.data?.length || 0}</span>
          </div>
          <p className="workspace-description">
            {t(
              "Datei zum Lesen öffnen. Checkboxen markieren mehrere Dateien für eine gemeinsame Suche, einschließlich Rotationen und GZIP-Archiven.",
            )}
          </p>
          <label className="search-input">
            <Search size={14} />
            <input
              aria-label={t("Log-Dateien filtern")}
              placeholder={t("Dateien filtern …")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
          <div className="log-selection">
            <button
              className="text-button"
              onClick={() =>
                setChecked(
                  checked.length
                    ? []
                    : filteredFiles.slice(0, 50).map((f) => f.id),
                )
              }
            >
              {checked.length
                ? t("Auswahl aufheben")
                : t("Bis zu 50 auswählen")}
            </button>
            <span>{checked.length}</span>
          </div>
          <div className="log-file-list">
            {filteredFiles.map((item) => (
              <div
                key={item.id}
                className={
                  "log-file " + (item.id === selected ? "selected" : "")
                }
              >
                <input
                  type="checkbox"
                  checked={checked.includes(item.id)}
                  onChange={(e) =>
                    setChecked(
                      e.target.checked
                        ? [...checked, item.id]
                        : checked.filter((id) => id !== item.id),
                    )
                  }
                  aria-label={item.name + " für Suche auswählen"}
                />
                <button
                  onClick={() => {
                    setSelected(item.id);
                    if (search)
                      void api("/logs/search/" + search.id, {}, "DELETE").catch(
                        () => {},
                      );
                    setSearch(null);
                  }}
                >
                  {item.compressed ? (
                    <Archive size={17} />
                  ) : (
                    <FileText size={17} />
                  )}
                  <span>
                    <strong title={item.name}>{item.name}</strong>
                    <small>
                      {formatBytes(item.size)} ·{" "}
                      {new Date(item.modified).toLocaleDateString(locale())}
                    </small>
                  </span>
                </button>
              </div>
            ))}
            {!filteredFiles.length && (
              <p className="schema-help">
                {t("Keine Log-Dateien in den konfigurierten Verzeichnissen.") +
                  " "}
              </p>
            )}
          </div>
          <div className="schema-footer">
            {t(
              "Archive werden begrenzt entpackt. Die Suche liest GZIP-Dateien direkt.",
            ) + " "}
          </div>
        </aside>
        <div className="log-workspace">
          <div className="workspace-section-head">
            <h3>{t("Logs lesen & durchsuchen")}</h3>
            <p>
              {t(
                "Die Suche verwendet die markierten Dateien. Ohne Markierung wird die geöffnete Datei durchsucht. Suchfilter grenzen Zeit, Level, Thread und Logger ein.",
              )}
            </p>
          </div>
          <div className="log-search">
            <label className="search-input">
              <Search size={17} />
              <input
                aria-label={t("In Logs suchen")}
                placeholder={t("Text in ausgewählten Dateien suchen …")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runSearch();
                }}
              />
            </label>
            <button
              className="icon-button"
              title={t("Suchfilter")}
              onClick={() => setShowFilters(!showFilters)}
            >
              <Settings2 size={17} />
            </button>
            <button
              className="button primary"
              disabled={searching || (!checked.length && !selected)}
              onClick={runSearch}
            >
              {searching ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Search size={15} />
              )}
              {t("Suchen") + " "}
            </button>
          </div>
          {showFilters && (
            <div className="log-filter-grid">
              <label>
                {t("Level") + " "}
                <select
                  value={level}
                  onChange={(e) => setLevel(e.target.value)}
                >
                  <option value="">{t("Alle")}</option>
                  {["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"].map(
                    (v) => (
                      <option key={v}>{v}</option>
                    ),
                  )}
                </select>
              </label>
              <label>
                {t("Von") + " "}
                <input
                  type="datetime-local"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label>
                {t("Bis") + " "}
                <input
                  type="datetime-local"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
              <label>
                {t("Thread enthält") + " "}
                <input
                  value={thread}
                  onChange={(e) => setThread(e.target.value)}
                />
              </label>
              <label>
                {t("Logger enthält") + " "}
                <input
                  value={logger}
                  onChange={(e) => setLogger(e.target.value)}
                />
              </label>
            </div>
          )}
          <div className="log-toolbar">
            <div>
              <FileText size={15} />
              <strong>
                {search ? t("Suchergebnisse") : file?.name || "Datei auswählen"}
              </strong>
              {file?.compressed && !search && <Badge>{t("GZIP")}</Badge>}
              {search && (
                <Badge tone={search.state === "DONE" ? "green" : "orange"}>
                  {search.state}
                </Badge>
              )}
            </div>
            <div>
              <select
                value={encoding}
                aria-label={t("Log-Zeichensatz")}
                onChange={(e) => setEncoding(e.target.value)}
              >
                {[
                  "UTF-8",
                  "ISO-8859-1",
                  "windows-1252",
                  "UTF-16LE",
                  "UTF-16BE",
                ].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
              <button
                className={"icon-button " + (wrap ? "active" : "")}
                title={t("Zeilenumbruch")}
                onClick={() => setWrap(!wrap)}
              >
                <WrapText size={17} />
              </button>
              {!search && (
                <button
                  className={"button small " + (tail ? "primary" : "")}
                  disabled={!selected || file?.compressed}
                  onClick={() => setTail(!tail)}
                >
                  {tail ? <Pause size={13} /> : <Play size={13} />}
                  {t("Live") + " "}
                </button>
              )}
              {search && (
                <button
                  className="button small"
                  onClick={async () => {
                    await api("/logs/search/" + search.id, {});
                    notify(t("Suchabbruch angefordert."));
                  }}
                >
                  <Square size={12} />
                  {t("Stop") + " "}
                </button>
              )}
              <button
                className="icon-button"
                title={t("Angezeigten Ausschnitt herunterladen")}
                disabled={!page && !search}
                onClick={snippet}
              >
                <Download size={16} />
              </button>
              {selected && !search && (
                <a
                  className="button small"
                  href={url("/logs/" + selected + "/download")}
                  download
                >
                  {t("Original") + " "}
                </a>
              )}
            </div>
          </div>
          <p className="workspace-description">
            {t(
              "Stacktraces lassen sich aufklappen. „Live“ verfolgt die aktuelle Datei; ältere und komprimierte Logs werden über die Dateiauswahl geöffnet.",
            )}
          </p>
          <div
            ref={viewport}
            aria-label={t("Log-Inhalt")}
            className={"log-viewport " + (wrap ? "wrap" : "")}
            aria-live={tail ? "polite" : "off"}
          >
            {search ? (
              <>
                <ErrorBox error={search.error || ""} />
                {search.truncated && (
                  <div className="sql-warning">
                    {t(
                      "Suche am Ergebnis-, Größen- oder Zeitlimit beendet. Zeitraum oder Dateiauswahl eingrenzen.",
                    ) + " "}
                  </div>
                )}
                {search.hits?.map((hit: Row, index: number) => (
                  <div
                    className={
                      "search-hit " + (hit.match ? "match" : "context")
                    }
                    key={index}
                  >
                    <div className="hit-location">
                      <button
                        onClick={() => {
                          setSelected(hit.file);
                          setSearch(null);
                        }}
                      >
                        {hit.name}:{hit.line}
                      </button>
                      {hit.level && (
                        <Badge
                          tone={
                            hit.level === "ERROR" || hit.level === "FATAL"
                              ? "red"
                              : hit.level === "WARN"
                                ? "orange"
                                : "neutral"
                          }
                        >
                          {hit.level}
                        </Badge>
                      )}
                      <span>{formatDate(hit.time)}</span>
                    </div>
                    {hit.before?.map((line: string, i: number) => (
                      <div className="log-context-line" key={i}>
                        {line}
                      </div>
                    ))}
                    <pre>
                      <Highlight text={hit.text} query={query} />
                    </pre>
                  </div>
                ))}
                {!search.hits?.length && (
                  <Empty
                    title={
                      ["RUNNING", "QUEUED"].includes(search.state)
                        ? t("Dateien werden durchsucht …")
                        : t("Keine Treffer")
                    }
                    detail={
                      formatNumber(search.scannedLines || 0) + " Zeilen gelesen"
                    }
                  />
                )}
              </>
            ) : loading && !page ? (
              <Loading />
            ) : !selected ? (
              <Empty
                title={t("Wähle eine Log-Datei")}
                detail={t("Aktuelle und ältere Dateien findest du links.")}
              />
            ) : (
              groups.map((group, index) => {
                const row = group[0],
                  open = expanded.has(index);
                return (
                  <div
                    className={"log-event " + (row.level || "").toLowerCase()}
                    key={index}
                  >
                    <div className="log-line">
                      <span
                        className="log-line-number"
                        title={t("Byteposition")}
                      >
                        {formatNumber(row.offset)}
                      </span>
                      {group.length > 1 ? (
                        <button
                          className="log-fold"
                          title={t("Stacktrace ein-/ausklappen")}
                          onClick={() =>
                            setExpanded((previous) => {
                              const next = new Set(previous);
                              next.has(index)
                                ? next.delete(index)
                                : next.add(index);
                              return next;
                            })
                          }
                        >
                          {open ? (
                            <ChevronDown size={12} />
                          ) : (
                            <ChevronRight size={12} />
                          )}
                        </button>
                      ) : (
                        <span className="log-fold" />
                      )}
                      <pre>
                        <Highlight text={row.text} query={query} />
                        {row.truncated && (
                          <span className="warning-text">
                            {" "}
                            {t("… [Zeile begrenzt]") + " "}
                          </span>
                        )}
                      </pre>
                      {group.length > 1 && !open && (
                        <button
                          className="trace-count"
                          onClick={() =>
                            setExpanded(new Set([...expanded, index]))
                          }
                        >
                          {group.length - 1} {t("Zeilen") + " "}
                        </button>
                      )}
                    </div>
                    {open &&
                      group.slice(1).map((line, i) => (
                        <div className="log-line stack" key={i}>
                          <span className="log-line-number">
                            {formatNumber(line.offset)}
                          </span>
                          <span className="log-fold" />
                          <pre>
                            <Highlight text={line.text} query={query} />
                          </pre>
                        </div>
                      ))}
                  </div>
                );
              })
            )}
          </div>
          <div className="log-footer">
            {search ? (
              <>
                <span>
                  {formatNumber(search.hits?.length || 0)}{" "}
                  {t("Treffer / Kontextzeilen ·") + " "}
                  {formatNumber(search.scannedLines)}{" "}
                  {t("Zeilen durchsucht") + " "}
                </span>
                <button
                  className="text-button"
                  onClick={async () => {
                    await api("/logs/search/" + search.id, {}, "DELETE");
                    setSearch(null);
                  }}
                >
                  {t("Suche schließen") + " "}
                  <X size={13} />
                </button>
              </>
            ) : (
              <>
                <span>
                  {page
                    ? formatBytes(page.start) +
                      " – " +
                      formatBytes(page.next) +
                      " / " +
                      formatBytes(page.size)
                    : t("Keine Datei geladen")}
                  {loading && t(" · Lädt …")}
                </span>
                <div>
                  <button
                    className="button small"
                    disabled={loading || tail || !page?.start}
                    onClick={() => load(page?.start, "previous")}
                  >
                    {t("Ältere Einträge") + " "}
                  </button>
                  <button
                    className="button small"
                    disabled={loading || tail || page?.eof || !page}
                    onClick={() => load(page?.next)}
                  >
                    {t("Weitere") + " "}
                  </button>
                  <button
                    className="button small"
                    disabled={loading || !selected}
                    onClick={() => load(-1)}
                  >
                    <ArrowDown size={13} />
                    {t("Zum Ende") + " "}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {loggers && <LoggerModal onClose={() => setLoggers(false)} />}
    </>
  );
}
function LoggerModal({ onClose }: { onClose: () => void }) {
  const apps = useLoad<Row[]>("/applications");
  const [app, setApp] = useState("system"),
    [edit, setEdit] = useState<Row | null>(null),
    [level, setLevel] = useState("INFO");
  const data = useLoad<Row[]>("/loggers?app=" + encodeURIComponent(app)),
    notify = useNotify();
  return (
    <Modal title={t("Logger-Level")} onClose={onClose} wide>
      <p className="modal-description">
        {t(
          "Logger der JVM oder einer Anwendung auswählen und das Laufzeit-Level ändern. „INHERIT“ übernimmt das übergeordnete Level; Änderungen gelten für die laufende Instanz.",
        )}
      </p>
      <div className="panel-padding">
        <label className="inline-label">
          {t("Anwendung") + " "}
          <select value={app} onChange={(e) => setApp(e.target.value)}>
            <option value="system">{t("JVM / java.util.logging")}</option>
            {apps.data?.map((row) => (
              <option key={row.id} value={row.id}>
                {row.host} · {row.path || "ROOT"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorBox error={data.error} />
      <DataTable
        id="loggers"
        rows={data.data || []}
        columns={[
          { key: "name", label: t("Logger") },
          { key: "framework", label: t("Framework") },
          { key: "level", label: t("Level") },
          {
            key: "actions",
            label: "",
            render: (_, row) => (
              <button
                className="button small"
                onClick={() => {
                  setEdit(row);
                  setLevel(
                    row.level && row.level !== "null" ? row.level : "INHERIT",
                  );
                }}
              >
                {t("Ändern") + " "}
              </button>
            ),
          },
        ]}
      />
      {edit && (
        <div className="logger-edit">
          <strong>{edit.name || "Root-Logger"}</strong>
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            {(edit.framework === "JUL"
              ? [
                  "INHERIT",
                  "OFF",
                  "SEVERE",
                  "WARNING",
                  "INFO",
                  "CONFIG",
                  "FINE",
                  "FINER",
                  "FINEST",
                  "ALL",
                ]
              : [
                  "INHERIT",
                  "OFF",
                  "FATAL",
                  "ERROR",
                  "WARN",
                  "INFO",
                  "DEBUG",
                  "TRACE",
                  "ALL",
                ]
            ).map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
          <button
            className="button primary"
            onClick={async () => {
              try {
                await api("/loggers", {
                  app,
                  framework: edit.framework,
                  name: edit.name,
                  level,
                });
                setEdit(null);
                notify(t("Logger-Level aktualisiert."));
                await data.refresh();
              } catch (e) {
                notify((e as Error).message, "error");
              }
            }}
          >
            {t("Übernehmen") + " "}
          </button>
        </div>
      )}
      <p className="modal-description">
        {t(
          "Änderungen gelten für die laufende JVM. Eine dauerhafte Änderung erfolgt in der jeweiligen Logging-Konfiguration.",
        ) + " "}
      </p>
    </Modal>
  );
}
