import { t } from "./i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Braces,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Database,
  Download,
  FileCode2,
  FilePlus2,
  Folder,
  History,
  KeyRound,
  Loader2,
  LockKeyhole,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Square,
  Table2,
  Trash2,
  Unlock,
  X,
} from "lucide-react";
import { format as formatSql } from "sql-formatter";
import Editor from "./Editor";
import {
  api,
  duration,
  formatBytes,
  formatDate,
  formatNumber,
  Row,
  url,
} from "./api";
import {
  Badge,
  Code,
  Confirm,
  DataTable,
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

type SqlTab = {
  id: string;
  title: string;
  text: string;
  session: Row;
  metadata?: Row;
  schema?: string;
  tables?: Row[];
  columns: Record<string, string[]>;
};
type Preferences = { scripts: Row[]; history: Row[] };
const busy = (tab?: SqlTab) =>
  ["QUEUED", "RUNNING"].includes(tab?.session.job?.state);
export default function SqlWorkspace({ source }: { source?: string }) {
  const user = useUser(),
    notify = useNotify(),
    sources = useLoad<Row[]>("/datasources");
  const [tabs, setTabs] = useState<SqlTab[]>([]),
    [active, setActive] = useState(""),
    [selectedSource, setSelectedSource] = useState(source || ""),
    [connecting, setConnecting] = useState(false),
    [error, setError] = useState("");
  const [preferences, setPreferences] = useState<Preferences>({
      scripts: [],
      history: [],
    }),
    [library, setLibrary] = useState<"scripts" | "history" | null>(null),
    [exportResult, setExportResult] = useState<Row | null>(null),
    [confirm, setConfirm] = useState<{ kind: string; tab: SqlTab } | null>(
      null,
    ),
    [save, setSave] = useState(false),
    [scriptName, setScriptName] = useState("");
  const [browserTab, setBrowserTab] = useState("schema"),
    [schemaOpen, setSchemaOpen] = useState(false),
    [selectedTable, setSelectedTable] = useState<Row | null>(null),
    [tableDetails, setTableDetails] = useState<Row | null>(null),
    [metadataBusy, setMetadataBusy] = useState(false),
    [resultKey, setResultKey] = useState(""),
    [rowLimit, setRowLimit] = useState(100000),
    [queryTimeout, setQueryTimeout] = useState(60);
  const prefsRef = useRef(preferences),
    loaded = useRef(false),
    autoSource = useRef("");
  const metadataGeneration = useRef(0);
  prefsRef.current = preferences;
  const tab = tabs.find((t) => t.id === active);
  function update(id: string, patch: Partial<SqlTab>) {
    setTabs((previous) =>
      previous.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
  }
  async function persist(next: Preferences) {
    setPreferences(next);
    try {
      await api("/preferences", next);
    } catch (e) {
      notify("Speichern fehlgeschlagen: " + (e as Error).message, "error");
    }
  }
  useEffect(() => {
    if (!user.permissions.sql || loaded.current) return;
    loaded.current = true;
    api<Preferences>("/preferences")
      .then(setPreferences)
      .catch((e) => notify(e.message, "error"));
    api<Row[]>("/sql")
      .then((sessions) => {
        setTabs((previous) => [
          ...previous,
          ...sessions
            .filter((s) => !previous.some((tab) => tab.id === s.id))
            .map((s) => ({
              id: s.id,
              title: s.source,
              text: "-- SQL-Sitzung nach Neuladen wiederhergestellt.\n-- Die bestehende Transaktion bleibt erhalten.\n",
              session: s,
              columns: {},
            })),
        ]);
        if (sessions[0]) setActive((current) => current || sessions[0].id);
      })
      .catch((e) => notify(e.message, "error"));
  }, [user.permissions.sql]);
  useEffect(() => {
    if (!sources.data) return;
    setTabs((previous) => {
      let changed = false;
      const next = previous.map((current) => {
        const found = sources.data?.find(
          (source) => source.id === current.session.source,
        );
        if (
          found &&
          (current.title === current.session.source || current.title === "SQL")
        ) {
          changed = true;
          return { ...current, title: found.name };
        }
        return current;
      });
      return changed ? next : previous;
    });
  }, [sources.data, tabs.length]);
  async function connect(id: string) {
    if (!id) return;
    setConnecting(true);
    setError("");
    try {
      const session = await api<Row>("/sql", { source: id });
      const sourceRow = sources.data?.find((s) => s.id === id);
      const next: SqlTab = {
        id: session.id,
        title: sourceRow?.name || "SQL",
        text:
          session.dialect === "oracle" ? "SELECT 1 FROM DUAL;" : "SELECT 1;",
        session,
        columns: {},
      };
      setTabs((previous) => [...previous, next]);
      setActive(next.id);
      setSelectedSource(id);
      notify(t("Verbindung geöffnet. Autocommit ist aus."));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setConnecting(false);
    }
  }
  useEffect(() => {
    if (source && sources.data && autoSource.current !== source) {
      autoSource.current = source;
      setSelectedSource(source);
      const existing = tabs.find((t) => t.session.source === source);
      if (existing) setActive(existing.id);
      else void connect(source);
    }
  }, [source, sources.data]);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const id = active;
    let timer: number;
    async function poll() {
      try {
        const session = await api<Row>("/sql/" + id + "?preview=false");
        if (alive) update(id, { session });
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
      if (alive)
        timer = window.setTimeout(
          poll,
          busy(tabs.find((t) => t.id === id)) ? 700 : 3000,
        );
    }
    timer = window.setTimeout(poll, 700);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [active, tab?.session.job?.state]);
  useEffect(() => {
    if (tab && !tab.metadata && !busy(tab)) void loadMetadata(tab);
  }, [active, tab?.session.job?.state]);
  async function loadMetadata(current: SqlTab, schema?: string) {
    const generation = ++metadataGeneration.current;
    const requestedSchema = schema === undefined ? current.schema : schema;
    setMetadataBusy(true);
    try {
      const metadata = await api<Row>(
        "/sql/" +
          current.id +
          "/metadata" +
          (requestedSchema === undefined
            ? ""
            : "?schema=" + encodeURIComponent(requestedSchema)),
      );
      if (generation !== metadataGeneration.current) return;
      update(current.id, {
        tables: metadata.tables || [],
        schema: metadata.selectedSchema || "",
        metadata: { ...current.metadata, ...metadata },
      });
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      if (generation === metadataGeneration.current) setMetadataBusy(false);
    }
  }
  async function execute(sql: string) {
    if (!tab || busy(tab)) return;
    if (!sql.trim()) {
      notify(t("SQL-Statement auswählen oder eingeben."), "error");
      return;
    }
    setError("");
    setResultKey("");
    const id = tab.id;
    try {
      const session = await api<Row>("/sql/" + id + "/execute", {
        sql,
        requestId: crypto.randomUUID().replaceAll("-", ""),
        timeout: queryTimeout,
        rowLimit,
        previewRows: 200,
      });
      update(id, { session });
      const next = {
        ...prefsRef.current,
        history: [
          { sql, source: tab.title, time: Date.now() },
          ...prefsRef.current.history,
        ].slice(0, 100),
      };
      void persist(next);
    } catch (e) {
      setError(
        (e as Error).message +
          " Bei einem Verbindungsfehler den Sitzungsstatus prüfen, bevor du die Abfrage erneut startest.",
      );
    }
  }
  async function control(kind: string, input: Row = {}) {
    if (!tab) return;
    setError("");
    try {
      const session = await api<Row>("/sql/" + tab.id + "/" + kind, input);
      update(tab.id, { session });
      if (kind === "schema") await loadMetadata(tab, tab.schema);
      notify(
        kind === "commit"
          ? "Commit erfolgreich."
          : kind === "rollback"
            ? "Rollback erfolgreich."
            : "Verbindungszustand aktualisiert.",
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function closeTab(current: SqlTab) {
    await api("/sql/" + current.id, {}, "DELETE");
    setTabs((previous) => previous.filter((t) => t.id !== current.id));
    if (active === current.id)
      setActive(tabs.find((t) => t.id !== current.id)?.id || "");
  }
  async function showTable(row: Row) {
    if (!tab) return;
    setSelectedTable(row);
    setTableDetails(null);
    try {
      const schema = row.TABLE_SCHEM || tab.schema || "";
      const result = await api<Row>(
        "/sql/" +
          tab.id +
          "/metadata?" +
          new URLSearchParams({ schema, table: row.TABLE_NAME }),
      );
      setTableDetails(result);
      update(tab.id, {
        columns: {
          ...tab.columns,
          [row.TABLE_NAME]: result.columns.map((c: Row) => c.COLUMN_NAME),
        },
      });
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }
  function tableQuery(row: Row) {
    if (!tab) return;
    const quote = String(tab.metadata?.quote || '"').trim() || '"';
    const close = quote === "[" ? "]" : quote;
    const escape = (s: string) =>
      quote + s.replaceAll(close, close + close) + close;
    const name = [row.TABLE_SCHEM || tab.schema, row.TABLE_NAME]
      .filter(Boolean)
      .map(escape)
      .join(".");
    update(tab.id, { text: "SELECT *\nFROM " + name + ";" });
    setSelectedTable(null);
  }
  const outputs = useMemo(() => {
    const result: Row[] = [];
    tab?.session.job?.steps?.forEach((step: Row) =>
      step.results?.forEach((output: Row, index: number) => {
        if (output.type === "rows")
          result.push({
            key: step.index + "-" + index,
            label: `Ergebnis ${step.index}${index ? "." + (index + 1) : ""}`,
            step,
            ...output.result,
          });
      }),
    );
    return result;
  }, [tab?.session.job]);
  const result = outputs.find((r) => r.key === resultKey) || outputs[0];
  if (!user.permissions.sql)
    return (
      <Empty
        title={t("SQL-Berechtigung erforderlich")}
        detail={t(
          "Für den Datenbankarbeitsplatz wird die Rolle jerry-sql, jerry-sql-read oder jerry-admin benötigt.",
        )}
      />
    );
  return (
    <>
      <PageTitle
        eyebrow={t("DATENBANKEN / WORKSPACE")}
        title={t("SQL-Arbeitsplatz")}
        description={t("Ein Tab, eine Verbindung, eine explizite Transaktion.")}
        actions={
          <>
            <button className="button" onClick={() => setLibrary("history")}>
              <History size={15} />
              {t("Verlauf") + " "}
            </button>
            <button className="button" onClick={() => setLibrary("scripts")}>
              <Folder size={15} />
              {t("Skripte") + " "}
            </button>
          </>
        }
      />
      <ErrorBox error={error || sources.error} />
      <div className="connection-bar">
        <Database size={17} />
        <select
          aria-label={t("Datenquelle auswählen")}
          value={selectedSource}
          onChange={(e) => setSelectedSource(e.target.value)}
        >
          <option value="">{t("Datenquelle auswählen …")}</option>
          {sources.data?.map((row) => (
            <option key={row.id} value={row.id}>
              {row.application} · {row.name}
            </option>
          ))}
        </select>
        <button
          className="button primary"
          disabled={connecting || !selectedSource || tabs.length >= 4}
          onClick={() => connect(selectedSource)}
        >
          {connecting ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <Plus size={15} />
          )}
          {t("Verbinden") + " "}
        </button>
        <span className="muted">{tabs.length} / 4 Tabs</span>
      </div>
      <p className="connection-help">
        {t(
          "Datenquelle auswählen und verbinden: Jeder Tab erhält eine eigene Verbindung mit ausgeschaltetem Autocommit. Commit bestätigt Änderungen, Rollback verwirft sie für diesen Tab.",
        )}
      </p>
      {!tabs.length ? (
        <Panel>
          <Empty
            title={t("Deine nächste Abfrage beginnt hier.")}
            detail={t(
              "Verbinde eine Datenquelle. Jerry öffnet jede Sitzung mit ausgeschaltetem Autocommit. Offene Transaktionen werden bei Ablauf zurückgerollt.",
            )}
          />
        </Panel>
      ) : (
        <div className="sql-shell">
          <div className="sql-tabbar">
            {tabs.map((item, index) => (
              <div
                key={item.id}
                className={"sql-tab " + (item.id === active ? "selected" : "")}
              >
                <button
                  onClick={() => {
                    setActive(item.id);
                    setResultKey("");
                    setError("");
                  }}
                >
                  <Database size={13} />
                  {item.title} <span>{index + 1}</span>
                  {item.session.transactionOpen && (
                    <i className="transaction-dot" />
                  )}
                </button>
                <button
                  aria-label={t("SQL-Tab schließen")}
                  onClick={() =>
                    item.session.transactionOpen || busy(item)
                      ? setConfirm({ kind: "close", tab: item })
                      : void closeTab(item).catch((e) => setError(e.message))
                  }
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
          {tab && (
            <>
              <div className="sql-status">
                <span className="connection-status">
                  <i />
                  {tab.session.product}
                </span>
                <span>
                  {tab.session.readOnly ? (
                    <>
                      <LockKeyhole size={13} />
                      {t("Nur Lesen") + " "}
                    </>
                  ) : (
                    <>
                      <Unlock size={13} />
                      {t("Schreibzugriff") + " "}
                    </>
                  )}
                </span>
                <span
                  className={
                    tab.session.autoCommit ? "warning-text" : "success-text"
                  }
                >
                  {tab.session.autoCommit
                    ? t("Autocommit AN")
                    : t("Autocommit AUS")}
                </span>
                <span>
                  {tab.session.transactionOpen
                    ? "Transaktion offen seit " +
                      new Date(tab.session.transactionSince).toLocaleTimeString(
                        "de-DE",
                      )
                    : t("Keine offene Transaktion")}
                </span>
                <button
                  className="text-button"
                  disabled={busy(tab)}
                  onClick={() => setConfirm({ kind: "autocommit", tab })}
                >
                  {t("Umschalten") + " "}
                </button>
              </div>
              {tab.session.requiresRollback && (
                <div className="sql-warning">
                  <RotateCcw size={16} />
                  {t(
                    "Die Ausführung ist fehlgeschlagen. Vor weiteren Statements ist ein Rollback oder die Rückkehr zu einem Savepoint erforderlich.",
                  ) + " "}
                </div>
              )}
              <button
                className="button schema-toggle"
                aria-expanded={schemaOpen}
                aria-controls="sql-schema-browser"
                onClick={() => setSchemaOpen((open) => !open)}
              >
                {t("Datenbankbrowser") + " "}
                {schemaOpen ? t("ausblenden") : t("anzeigen")}
              </button>
              <div className="sql-main">
                <aside
                  id="sql-schema-browser"
                  className={
                    "schema-browser " + (schemaOpen ? "mobile-open" : "")
                  }
                >
                  <div className="schema-title">
                    <span>{t("DATENBANK")}</span>
                    <button
                      className="icon-button"
                      aria-label={t("Schema aktualisieren")}
                      onClick={() => loadMetadata(tab, tab.schema)}
                      disabled={busy(tab) || metadataBusy}
                    >
                      <RefreshCw
                        size={13}
                        className={metadataBusy ? "spin" : ""}
                      />
                    </button>
                  </div>
                  <p className="workspace-description">
                    {t(
                      "Tabellen und Spalten der verbundenen Datenbank erkunden. Ein Tabellenklick öffnet die Strukturdetails.",
                    )}
                  </p>
                  {tab.metadata && (
                    <p className="workspace-description">
                      {tab.metadata.currentSchema ? (
                        <>
                          {t("Verbindungsschema:") + " "}
                          <strong>{tab.metadata.currentSchema}</strong> ·{" "}
                          {t(tab.metadata.schemaOrigin)}
                          {t(". Die Auswahl filtert nur den Browser.")}
                        </>
                      ) : (
                        <>
                          {t(
                            "Kein eindeutiges Schema vom Treiber gemeldet. Bitte ein Schema auswählen.",
                          )}
                        </>
                      )}
                    </p>
                  )}
                  <select
                    aria-label={t("Schema")}
                    value={tab.schema ?? ""}
                    disabled={busy(tab) || metadataBusy}
                    onChange={(e) => loadMetadata(tab, e.target.value)}
                  >
                    <option value="">
                      {metadataBusy
                        ? t("Schema wird ermittelt …")
                        : t("Schema auswählen …")}
                    </option>
                    {(tab.metadata?.schemas || []).map((s: Row) => (
                      <option key={s.TABLE_SCHEM} value={s.TABLE_SCHEM}>
                        {s.TABLE_SCHEM}
                      </option>
                    ))}
                  </select>
                  {!(tab.metadata?.schemas || []).length && (
                    <button
                      className="text-button"
                      onClick={() => loadMetadata(tab, "")}
                      disabled={busy(tab)}
                    >
                      {t("Tabellen laden") + " "}
                    </button>
                  )}
                  <Tabs
                    value={browserTab}
                    onChange={setBrowserTab}
                    items={[
                      ["schema", "Tabellen"],
                      ["procedures", "Routinen"],
                    ]}
                  />
                  {tab.schema !== undefined && (
                    <button
                      className="text-button"
                      disabled={busy(tab) || tab.session.transactionOpen}
                      onClick={() => control("schema", { schema: tab.schema })}
                    >
                      {t("Als aktuelles Schema setzen") + " "}
                    </button>
                  )}
                  <div className="schema-items">
                    {browserTab === "schema"
                      ? (tab.tables || []).map((table, index) => (
                          <button
                            key={index}
                            className="schema-item"
                            disabled={busy(tab)}
                            onClick={() => showTable(table)}
                          >
                            <Table2 size={14} />
                            <span>{table.TABLE_NAME}</span>
                            <small>
                              {table.TABLE_TYPE === "VIEW" ? "V" : ""}
                            </small>
                          </button>
                        ))
                      : (tab.metadata?.procedures || []).map(
                          (proc: Row, index: number) => (
                            <div className="schema-item" key={index}>
                              <Braces size={13} />
                              {proc.PROCEDURE_NAME}
                            </div>
                          ),
                        )}
                    {!tab.tables?.length && browserTab === "schema" && (
                      <p className="schema-help">
                        {t(
                          "Schema auswählen, um Tabellen und Views zu durchsuchen.",
                        ) + " "}
                      </p>
                    )}
                  </div>
                  <div className="schema-footer">
                    {tab.metadata?.ddlCommits && (
                      <span className="warning-text">
                        {t("DDL kann implizit committen.") + " "}
                      </span>
                    )}
                    <span>
                      {t("Isolation:")}{" "}
                      {(
                        {
                          1: "Read uncommitted",
                          2: "Read committed",
                          4: "Repeatable read",
                          8: "Serializable",
                        } as Row
                      )[tab.metadata?.isolation] || "—"}
                    </span>
                    <select
                      aria-label={t("Transaktionsisolation")}
                      disabled={busy(tab) || tab.session.transactionOpen}
                      value={tab.metadata?.isolation || 2}
                      onChange={(e) =>
                        void control("isolation", {
                          level: Number(e.target.value),
                        }).then(() => loadMetadata(tab))
                      }
                    >
                      {[
                        [1, "Read uncommitted"],
                        [2, "Read committed"],
                        [4, "Repeatable read"],
                        [8, "Serializable"],
                      ].map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </div>
                </aside>
                <div className="editor-results">
                  <div className="workspace-section-head">
                    <h3>{t("SQL ausführen & Transaktionen")}</h3>
                    <p>
                      {t(
                        "Mehrere Befehle durch Semikolon trennen. „Skript ausführen“ verarbeitet den gesamten Editor. Solange Autocommit aus ist, bleiben Änderungen bis Commit oder Rollback offen.",
                      )}
                    </p>
                  </div>
                  <div className="editor-toolbar">
                    <div>
                      <button
                        className="button primary small"
                        disabled={busy(tab) || tab.session.requiresRollback}
                        title={t("Gesamtes Skript · Strg+Umschalt+Enter")}
                        onClick={() => execute(tab.text)}
                      >
                        <Play size={14} />
                        {t("Skript ausführen") + " "}
                      </button>
                      <button
                        className="button small"
                        disabled={!busy(tab)}
                        onClick={async () => {
                          try {
                            await api("/sql/" + tab.id + "/cancel", {});
                            notify(t("Abbruch angefordert."));
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        <Square size={13} />
                        {t("Abbrechen") + " "}
                      </button>
                      <span className="toolbar-divider" />
                      <button
                        className="button small"
                        disabled={
                          busy(tab) ||
                          tab.session.autoCommit ||
                          !tab.session.transactionOpen ||
                          tab.session.requiresRollback
                        }
                        onClick={() => control("commit")}
                      >
                        <Check size={14} />
                        {t("Commit") + " "}
                      </button>
                      <button
                        className="button small"
                        disabled={
                          busy(tab) ||
                          tab.session.autoCommit ||
                          !tab.session.transactionOpen
                        }
                        onClick={() => control("rollback")}
                      >
                        <RotateCcw size={14} />
                        {t("Rollback") + " "}
                      </button>
                    </div>
                    <div>
                      <button
                        className="icon-button"
                        title={t("SQL formatieren")}
                        onClick={() => {
                          try {
                            const dialect =
                              (
                                {
                                  postgresql: "postgresql",
                                  mysql: "mysql",
                                  mariadb: "mariadb",
                                  oracle: "plsql",
                                  sqlserver: "transactsql",
                                } as Row
                              )[tab.session.dialect] || "sql";
                            update(tab.id, {
                              text: formatSql(tab.text, { language: dialect }),
                            });
                          } catch (e) {
                            notify((e as Error).message, "error");
                          }
                        }}
                      >
                        <Code2 size={16} />
                      </button>
                      <button
                        className="icon-button"
                        title={t("Skript speichern")}
                        onClick={() => {
                          setScriptName(tab.title);
                          setSave(true);
                        }}
                      >
                        <Save size={16} />
                      </button>
                    </div>
                  </div>
                  <Editor
                    key={tab.id}
                    value={tab.text}
                    dialect={tab.session.dialect}
                    schema={tab.columns}
                    onChange={(text) => update(tab.id, { text })}
                    onExecute={execute}
                    onExecuteAll={() => execute(tab.text)}
                  />
                  <div className="editor-foot">
                    <span>
                      {t(
                        "Strg+Enter: Auswahl / Statement · Strg+Umschalt+Enter: Skript",
                      ) + " "}
                    </span>
                    <span className="query-limits">
                      <label>
                        {t("Timeout")}{" "}
                        <input
                          type="number"
                          min="1"
                          max="600"
                          value={queryTimeout}
                          onChange={(e) =>
                            setQueryTimeout(
                              Math.max(
                                1,
                                Math.min(600, Number(e.target.value)),
                              ),
                            )
                          }
                        />{" "}
                        s
                      </label>
                      <label>
                        {t("Max. Zeilen")}{" "}
                        <input
                          type="number"
                          min="1"
                          max="1000000"
                          value={rowLimit}
                          onChange={(e) =>
                            setRowLimit(
                              Math.max(
                                1,
                                Math.min(1000000, Number(e.target.value)),
                              ),
                            )
                          }
                        />
                      </label>
                      <span>{tab.session.dialect.toUpperCase()}</span>
                    </span>
                  </div>
                  <div className="savepoints">
                    <button
                      className="text-button"
                      disabled={
                        busy(tab) ||
                        tab.session.autoCommit ||
                        tab.session.requiresRollback
                      }
                      onClick={() => {
                        const name = window.prompt(
                          "Savepoint-Name",
                          "sp_" + ((tab.session.savepoints?.length || 0) + 1),
                        );
                        if (name) void control("savepoint", { name });
                      }}
                    >
                      <Plus size={12} />
                      {t("Savepoint") + " "}
                    </button>
                    {tab.session.savepoints?.map((name: string) => (
                      <button
                        key={name}
                        className="tag-button"
                        disabled={busy(tab)}
                        onClick={() => control("rollback-savepoint", { name })}
                        title={t("Zu diesem Savepoint zurückrollen")}
                      >
                        <RotateCcw size={11} />
                        {name}
                      </button>
                    ))}
                  </div>
                  <div className="query-output">
                    <p className="workspace-description">
                      {t(
                        "Ergebnisse werden je Statement angezeigt. SELECT-Ergebnisse können seitenweise gelesen und als CSV exportiert werden; der Export führt die Abfrage nicht erneut aus.",
                      )}
                    </p>
                    <div className="output-header">
                      <span>{t("ERGEBNISSE")}</span>
                      {tab.session.job && (
                        <Badge
                          tone={
                            tab.session.job.state === "DONE"
                              ? "green"
                              : tab.session.job.state === "ERROR"
                                ? "red"
                                : "orange"
                          }
                        >
                          {busy(tab) && <Loader2 size={12} className="spin" />}
                          {tab.session.job.state}
                        </Badge>
                      )}
                      {tab.session.job?.finished > 0 && (
                        <small>
                          {duration(
                            tab.session.job.finished - tab.session.job.started,
                          )}
                        </small>
                      )}
                      {result && (
                        <button
                          className="button small"
                          onClick={() => setExportResult(result)}
                        >
                          <Download size={13} />
                          {t("CSV exportieren") + " "}
                        </button>
                      )}
                    </div>
                    {tab.session.job?.error && (
                      <div className="query-error">
                        <strong>{tab.session.job.error}</strong>
                        <span>
                          {t("SQLState:") + " "}
                          {tab.session.job.sqlState || "—"}{" "}
                          {t("· Fehlercode:") + " "}
                          {tab.session.job.vendorCode || "—"}
                        </span>
                      </div>
                    )}
                    {outputs.length > 1 && (
                      <Tabs
                        value={result?.key || ""}
                        onChange={setResultKey}
                        items={outputs.map((r) => [r.key, r.label])}
                      />
                    )}
                    {result ? (
                      <ResultGrid
                        key={tab.session.job?.id + result.id}
                        tab={tab}
                        result={result}
                      />
                    ) : tab.session.job ? (
                      <div className="statement-results">
                        {tab.session.job.steps?.map((step: Row) => (
                          <div key={step.index}>
                            <Badge
                              tone={step.state === "ERROR" ? "red" : "green"}
                            >
                              {t("Statement") + " "}
                              {step.index}
                            </Badge>
                            <span>
                              {step.results
                                ?.filter((r: Row) => r.type === "update")
                                .map(
                                  (r: Row) =>
                                    formatNumber(r.count) + " Zeilen betroffen",
                                )
                                .join(" · ") ||
                                step.error ||
                                "In Ausführung …"}
                            </span>
                            <small>
                              {step.durationMs != null
                                ? duration(step.durationMs)
                                : ""}
                            </small>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <Empty
                        title={t("Platz für deine Ergebnisse")}
                        detail={t(
                          "Führe ein Statement oder mehrere durch Semikolon getrennte Statements aus.",
                        )}
                      />
                    )}
                    {tab.session.job?.steps?.some(
                      (step: Row) => step.warnings?.length > 0,
                    ) && (
                      <div className="sql-warning">
                        {tab.session.job.steps
                          .flatMap((step: Row) => step.warnings || [])
                          .join(" · ")}
                      </div>
                    )}
                    {outputs.length > 0 && (
                      <details className="execution-details">
                        <summary>
                          {t("Ausführungsdetails ·")}{" "}
                          {tab.session.job?.steps?.length || 0}{" "}
                          {t("Statements") + " "}
                        </summary>
                        {tab.session.job?.steps?.map((step: Row) => (
                          <div key={step.index}>
                            <strong>
                              {t("Statement") + " "}
                              {step.index} · {step.state || "RUNNING"} ·{" "}
                              {duration(step.durationMs || 0)}
                            </strong>
                            <pre>{step.sql}</pre>
                            {step.results
                              ?.filter((r: Row) => r.type === "update")
                              .map((r: Row, i: number) => (
                                <p key={i}>
                                  {r.count} {t("Zeilen betroffen")}
                                </p>
                              ))}
                          </div>
                        ))}
                      </details>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
      {exportResult && tab && (
        <CsvModal
          tab={tab}
          result={exportResult}
          onClose={() => setExportResult(null)}
        />
      )}
      {confirm && (
        <Confirm
          title={
            confirm.kind === "close"
              ? t("SQL-Sitzung schließen?")
              : t("Autocommit umschalten?")
          }
          detail={
            confirm.kind === "close"
              ? t(
                  "Laufende Abfragen werden abgebrochen und offene Transaktionen zurückgerollt. Ergebnisdateien werden entfernt.",
                )
              : confirm.tab.session.transactionOpen
                ? t(
                    "Zuerst Commit oder Rollback ausführen. Während einer offenen Transaktion ist kein Wechsel möglich.",
                  )
                : confirm.tab.session.autoCommit
                  ? t("Autocommit wird ausgeschaltet.")
                  : t("Autocommit wird eingeschaltet.")
          }
          danger={confirm.kind === "close"}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            if (confirm.kind === "close") await closeTab(confirm.tab);
            else {
              const session = await api<Row>(
                "/sql/" + confirm.tab.id + "/autocommit",
                { enabled: !confirm.tab.session.autoCommit },
              );
              update(confirm.tab.id, { session });
            }
          }}
        />
      )}
      {save && tab && (
        <Modal title={t("SQL-Skript speichern")} onClose={() => setSave(false)}>
          <div className="form-grid">
            <label>
              {t("Name") + " "}
              <input
                value={scriptName}
                maxLength={120}
                onChange={(e) => setScriptName(e.target.value)}
              />
            </label>
            <p className="muted">
              {t(
                "Das Skript wird in deinem persönlichen Jerry-Speicher auf dem Server abgelegt.",
              ) + " "}
            </p>
          </div>
          <div className="modal-actions">
            <button
              className="button primary"
              disabled={!scriptName.trim()}
              onClick={async () => {
                await persist({
                  ...preferences,
                  scripts: [
                    {
                      id: crypto.randomUUID(),
                      name: scriptName,
                      sql: tab.text,
                      time: Date.now(),
                    },
                    ...preferences.scripts,
                  ].slice(0, 200),
                });
                setSave(false);
                notify(t("Skript gespeichert."));
              }}
            >
              {t("Speichern") + " "}
            </button>
          </div>
        </Modal>
      )}
      {library && (
        <Modal
          title={
            library === "scripts"
              ? t("Gespeicherte SQL-Skripte")
              : t("Persönlicher Abfrageverlauf")
          }
          onClose={() => setLibrary(null)}
          wide
        >
          <p className="modal-description">
            {t(
              "Skripte und Verlauf lassen sich in einen SQL-Tab übernehmen. Das Übernehmen führt noch keine Abfrage aus.",
            )}
          </p>
          <DataTable
            id={"sql-library-" + library}
            rows={preferences[library]}
            columns={[
              {
                key: library === "scripts" ? "name" : "source",
                label: library === "scripts" ? "Name" : "Datenquelle",
              },
              { key: "time", label: t("Zeit"), render: formatDate },
              {
                key: "sql",
                label: t("SQL"),
                render: (v) => (
                  <span className="ellipsis" title={v}>
                    {v}
                  </span>
                ),
              },
              {
                key: "actions",
                label: "",
                render: (_, row) => (
                  <div className="row-actions">
                    <button
                      className="button small"
                      disabled={!tab}
                      onClick={() => {
                        if (tab) update(tab.id, { text: row.sql });
                        setLibrary(null);
                      }}
                    >
                      {t("Laden") + " "}
                    </button>
                    <button
                      className="icon-button danger-text"
                      aria-label={t("Eintrag löschen")}
                      onClick={() =>
                        persist({
                          ...preferences,
                          [library]: preferences[library].filter(
                            (r) => r !== row,
                          ),
                        })
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ),
              },
            ]}
          />
          <div className="modal-actions">
            <button
              className="button"
              onClick={() => persist({ ...preferences, [library]: [] })}
            >
              {t("Liste leeren") + " "}
            </button>
          </div>
        </Modal>
      )}
      {selectedTable && (
        <Modal
          title={selectedTable.TABLE_NAME}
          onClose={() => setSelectedTable(null)}
          wide
        >
          {tableDetails ? (
            <>
              <DataTable
                id="table-columns"
                rows={tableDetails.columns || []}
                columns={[
                  { key: "COLUMN_NAME", label: t("Spalte") },
                  { key: "TYPE_NAME", label: t("Typ") },
                  { key: "COLUMN_SIZE", label: t("Größe") },
                  { key: "IS_NULLABLE", label: t("Nullable") },
                  { key: "COLUMN_DEF", label: t("Default") },
                ]}
              />
              <details className="panel-padding">
                <summary>{t("Schlüssel und Indizes")}</summary>
                <h4>{t("Primärschlüssel")}</h4>
                <Code value={tableDetails.primaryKeys} />
                <h4>{t("Indizes")}</h4>
                <Code value={tableDetails.indexes} />
                <h4>{t("Fremdschlüssel")}</h4>
                <Code value={tableDetails.foreignKeys} />
              </details>
            </>
          ) : (
            <Loading />
          )}
          <div className="modal-actions">
            <button
              className="button primary"
              onClick={() => tableQuery(selectedTable)}
            >
              {t("SELECT in Editor übernehmen") + " "}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
function ResultGrid({ tab, result }: { tab: SqlTab; result: Row }) {
  const [rows, setRows] = useState<any[][]>(result.rows || []),
    [offset, setOffset] = useState(0),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [cell, setCell] = useState<string | null>(null);
  const limit = 200;
  async function page(next: number) {
    setLoading(true);
    try {
      const data = await api<Row>(
        "/sql/" +
          tab.id +
          "/results/" +
          result.id +
          "?" +
          new URLSearchParams({ offset: String(next), limit: String(limit) }),
      );
      setRows(data.rows);
      setOffset(next);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (!rows.length && result.rowCount > 0) void page(0);
  }, [result.id]);
  return (
    <>
      <ErrorBox error={error} />
      {result.truncated && (
        <div className="sql-warning">
          {t("Ergebnis begrenzt:") + " "}
          {formatNumber(result.rowCount)}{" "}
          {t(
            "Zeilen gespeichert. Für weitere Daten das Abfragelimit oder die Abfrage anpassen.",
          ) + " "}
        </div>
      )}
      {result.cellTruncated && (
        <div className="sql-warning">
          {t(
            "Mindestens ein Zellwert wurde am konfigurierten Größenlimit abgeschnitten. Dies gilt auch für den CSV-Export.",
          ) + " "}
        </div>
      )}
      <div className="result-grid table-scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              {result.columns.map((col: Row, i: number) => (
                <th key={i}>
                  <strong>{col.name}</strong>
                  <small>{col.type}</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                <td className="row-number">{offset + index + 1}</td>
                {row.map((value, i) => (
                  <td
                    key={i}
                    className={value === null ? "null-value" : ""}
                    onDoubleClick={() =>
                      setCell(value === null ? "NULL" : String(value))
                    }
                    title={value === null ? t("NULL") : String(value)}
                  >
                    {value === null ? t("NULL") : String(value)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <div className="zero-rows">{t("Abfrage erfolgreich · 0 Zeilen")}</div>
        )}
      </div>
      <div className="result-footer">
        <span>
          {formatNumber(result.rowCount)} {t("Zeilen ·") + " "}
          {result.columns.length} {t("Spalten ·") + " "}
          {formatBytes(result.bytes)}
        </span>
        <div>
          <button
            className="icon-button"
            disabled={loading || offset === 0}
            onClick={() => page(Math.max(0, offset - limit))}
            aria-label={t("Vorherige Ergebnisse")}
          >
            <ChevronLeft size={16} />
          </button>
          <span>
            {offset + Math.min(1, result.rowCount)}–
            {Math.min(offset + rows.length, result.rowCount)}
          </span>
          <button
            className="icon-button"
            disabled={loading || offset + rows.length >= result.rowCount}
            onClick={() => page(offset + rows.length)}
            aria-label={t("Weitere Ergebnisse")}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      {cell !== null && (
        <Modal title={t("Zellinhalt")} onClose={() => setCell(null)} wide>
          <Code value={cell} />
          <div className="modal-actions">
            <button
              className="button"
              onClick={() => navigator.clipboard.writeText(cell)}
            >
              {t("Kopieren") + " "}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
function CsvModal({
  tab,
  result,
  onClose,
}: {
  tab: SqlTab;
  result: Row;
  onClose: () => void;
}) {
  const [separator, setSeparator] = useState(";"),
    [encoding, setEncoding] = useState("UTF-8"),
    [bom, setBom] = useState(true),
    [header, setHeader] = useState(true),
    [safe, setSafe] = useState(true),
    [nullText, setNullText] = useState(""),
    [scope, setScope] = useState("all"),
    [datePattern, setDatePattern] = useState(""),
    [timestampPattern, setTimestampPattern] = useState("");
  const href = url("/sql/" + tab.id + "/results/" + result.id + "/csv", {
    separator,
    encoding,
    bom,
    header,
    safe,
    null: nullText,
    scope,
    datePattern,
    timestampPattern,
  });
  return (
    <Modal title={t("Ergebnis als CSV exportieren")} onClose={onClose}>
      <div className="form-grid two">
        <label>
          {t("Umfang") + " "}
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">
              {t("Alle gespeicherten Zeilen (")}
              {result.rowCount})
            </option>
            <option value="preview">
              {t("Erste Ergebnisvorschau (") + " "}
              {result.previewCount ?? result.rows.length})
            </option>
          </select>
        </label>
        <label>
          {t("Trennzeichen") + " "}
          <select
            value={separator}
            onChange={(e) => setSeparator(e.target.value)}
          >
            <option value=";">{t("Semikolon")}</option>
            <option value=",">{t("Komma")}</option>
            <option value={"\t"}>{t("Tabulator")}</option>
            <option value="|">{t("Pipe")}</option>
          </select>
        </label>
        <label>
          {t("Zeichensatz") + " "}
          <select
            value={encoding}
            onChange={(e) => setEncoding(e.target.value)}
          >
            <option>{t("UTF-8")}</option>
            <option>{t("UTF-16LE")}</option>
            <option>{t("windows-1252")}</option>
          </select>
        </label>
        <label>
          {t("NULL-Darstellung") + " "}
          <input
            value={nullText}
            onChange={(e) => setNullText(e.target.value)}
            placeholder={t("Leer")}
          />
        </label>
        <label>
          {t("Datumsformat") + " "}
          <input
            value={datePattern}
            onChange={(e) => setDatePattern(e.target.value)}
            placeholder={t("Original (z. B. dd.MM.yyyy)")}
          />
        </label>
        <label>
          {t("Zeitstempelformat") + " "}
          <input
            value={timestampPattern}
            onChange={(e) => setTimestampPattern(e.target.value)}
            placeholder={t("Original (z. B. dd.MM.yyyy HH:mm:ss)")}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={header}
            onChange={(e) => setHeader(e.target.checked)}
          />
          {t("Spaltennamen") + " "}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={bom}
            onChange={(e) => setBom(e.target.checked)}
          />
          {t("Byte Order Mark") + " "}
        </label>
        <label className="check full">
          <input
            type="checkbox"
            checked={safe}
            onChange={(e) => setSafe(e.target.checked)}
          />
          {t("Formelanfänge für Tabellenkalkulationen entschärfen") + " "}
        </label>
      </div>
      <p className="modal-description">
        {t(
          "Der Export verwendet das gespeicherte Ergebnis. Die SQL-Abfrage wird dafür nicht erneut ausgeführt.",
        ) + " "}
        {result.truncated ? t(" Das Ergebnis ist begrenzt.") : ""}
      </p>
      <div className="modal-actions">
        <a className="button primary" href={href} download="jerry-result.csv">
          <Download size={15} />
          {t("CSV herunterladen") + " "}
        </a>
      </div>
    </Modal>
  );
}
