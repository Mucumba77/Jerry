import React, { Component, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Archive,
  ArrowUpRight,
  Boxes,
  CheckCircle2,
  ChevronDown,
  ChevronsLeft,
  Command,
  Database,
  FileText,
  GitBranch,
  HelpCircle,
  Layers,
  LayoutDashboard,
  LogOut,
  MemoryStick,
  Menu,
  Moon,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sun,
  Terminal,
  Wifi,
  X,
} from "lucide-react";
import { api, formatDate, route, Row, setCsrf, url } from "./api";
import {
  appendHistory,
  HistoryContext,
  mergeHistory,
  PERIODS,
  periodMilliseconds,
} from "./history";
import { LANGUAGES, t, useI18n } from "./i18n";
import {
  ErrorBox,
  Loading,
  Modal,
  NotifyContext,
  SnapshotContext,
  UserContext,
} from "./components";
import {
  Dashboard,
  MemoryView,
  ConnectorsView,
  ProcessorsView,
  ThreadsView,
  SystemView,
  ClusterView,
  CertificatesView,
} from "./MonitoringViews";
import { ApplicationsView, DataSourcesView } from "./Applications";
import SqlWorkspace from "./SqlWorkspace";
import LogsView from "./LogsView";
import "./styles.css";

const navigation = [
  {
    label: "ÜBERSICHT",
    items: [
      ["dashboard", "Dashboard", LayoutDashboard],
      ["applications", "Anwendungen", Boxes],
    ],
  },
  {
    label: "MONITORING",
    items: [
      ["memory", "Speicher & GC", MemoryStick],
      ["processors", "Requestprozessoren", Activity],
      ["connectors", "Connectoren", Wifi],
      ["threads", "Threads", Layers],
      ["cluster", "Cluster", GitBranch],
    ],
  },
  {
    label: "WERKZEUGE",
    items: [
      ["sql", "SQL-Arbeitsplatz", Database],
      ["datasources", "Datenquellen", Server],
      ["logs", "Log-Explorer", Terminal],
    ],
  },
  {
    label: "ADMINISTRATION",
    items: [
      ["certificates", "Zertifikate", ShieldCheck],
      ["system", "System & Diagnose", Settings],
    ],
  },
];
class ErrorBoundary extends Component<
  { children: React.ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="fatal">
        <h1>{t("Die Ansicht konnte nicht angezeigt werden.")}</h1>
        <p>{this.state.error}</p>
        <button className="button primary" onClick={() => location.reload()}>
          {t("Jerry neu laden") + " "}
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function App() {
  const language = useI18n();
  const [me, setMe] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [hash, setHash] = useState(location.hash.slice(1) || "dashboard"),
    [snapshot, setSnapshot] = useState<Row | null>(null),
    [history, setHistory] = useState<Row[]>([]),
    [period, setPeriodValue] = useState(() => {
      const saved = localStorage.getItem("jerry.monitor.period");
      return PERIODS.some((item) => item.value === saved) ? saved! : "1h";
    }),
    [historyLoading, setHistoryLoading] = useState(false),
    [historyError, setHistoryError] = useState(""),
    [historyRetry, setHistoryRetry] = useState(0),
    [live, setLive] = useState(false),
    [mobile, setMobile] = useState(false),
    [help, setHelp] = useState(false),
    [theme, setTheme] = useState(
      localStorage.getItem("jerry.theme") || "light",
    ),
    [toasts, setToasts] = useState<
      { id: number; text: string; type: string }[]
    >([]);
  const page = hash.split("?")[0],
    params = new URLSearchParams(hash.split("?")[1] || ""),
    [sqlMounted, setSqlMounted] = useState(page === "sql");
  const monitored = [
    "dashboard",
    "memory",
    "connectors",
    "cluster",
    "datasources",
  ].includes(page);
  const periodRef = useRef(period);
  const historyVisibleRef = useRef(monitored);
  periodRef.current = period;
  historyVisibleRef.current = monitored;
  function setPeriod(value: string) {
    if (!PERIODS.some((item) => item.value === value)) return;
    localStorage.setItem("jerry.monitor.period", value);
    setPeriodValue(value);
  }
  const notify = (text: string, type = "success") => {
    const id = Date.now() + Math.random();
    setToasts((previous) => [...previous.slice(-3), { id, text, type }]);
    setTimeout(
      () => setToasts((previous) => previous.filter((t) => t.id !== id)),
      6500,
    );
  };
  useEffect(() => {
    api<Row>("/me")
      .then((data) => {
        setCsrf(data.csrf);
        setMe(data);
      })
      .catch((e) => setError(e.message));
    const listener = () => {
      const value = location.hash.slice(1) || "dashboard";
      setHash(value);
      setMobile(false);
      if (value.startsWith("sql")) setSqlMounted(true);
    };
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("jerry.theme", theme);
  }, [theme]);
  useEffect(() => {
    if (!me || !monitored) return;
    let disposed = false,
      pending = false;
    const duration = periodMilliseconds(period);
    setHistory([]);
    setHistoryLoading(true);
    setHistoryError("");
    async function refreshHistory() {
      if (pending) return;
      pending = true;
      const to = Date.now(),
        from = to - duration;
      try {
        const rows = await api<Row[]>(
          "/history?" +
            new URLSearchParams({
              from: String(from),
              to: String(to),
              points: "600",
            }),
        );
        if (!disposed) {
          setHistory((previous) =>
            mergeHistory(rows, previous, to, Date.now() - duration),
          );
          setHistoryError("");
        }
      } catch (e) {
        if (!disposed) setHistoryError((e as Error).message);
      } finally {
        pending = false;
        if (!disposed) setHistoryLoading(false);
      }
    }
    void refreshHistory();
    const timer = window.setInterval(
      refreshHistory,
      duration > 24 * 3_600_000 ? 300000 : 60000,
    );
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [me, monitored, period, historyRetry]);
  useEffect(() => {
    if (!me) return;
    let alive = true;
    const source = new EventSource(url("/events"));
    source.addEventListener("snapshot", (event) => {
      try {
        const value = JSON.parse((event as MessageEvent).data);
        setSnapshot(value);
        setLive(true);
        if (historyVisibleRef.current)
          setHistory((previous) =>
            appendHistory(
              previous,
              value,
              Date.now() - periodMilliseconds(periodRef.current),
            ),
          );
      } catch {}
    });
    source.onerror = () => setLive(false);
    const poll = window.setInterval(async () => {
      if (source.readyState === EventSource.OPEN) return;
      try {
        const value = await api<Row>("/summary");
        if (alive) {
          setSnapshot(value);
          if (historyVisibleRef.current)
            setHistory((previous) =>
              appendHistory(
                previous,
                value,
                Date.now() - periodMilliseconds(periodRef.current),
              ),
            );
        }
      } catch {}
    }, 10000);
    api<Row>("/summary")
      .then((value) => {
        if (alive) setSnapshot(value);
      })
      .catch((e) => setError(e.message));
    return () => {
      alive = false;
      source.close();
      clearInterval(poll);
    };
  }, [me]);
  if (error && !me)
    return (
      <div className="boot-error">
        <span className="brand-mark">J</span>
        <h1>{t("Jerry")}</h1>
        <ErrorBox error={error} />
        <a className="button primary" href="./">
          {t("Erneut versuchen") + " "}
        </a>
      </div>
    );
  if (!me)
    return (
      <div className="boot">
        <span className="brand-mark">J</span>
        <Loading />
      </div>
    );
  const menu = navigation
    .flatMap((g) => g.items)
    .find((item) => item[0] === page);
  const heading = t(String(menu?.[1] || "Dashboard"));
  return (
    <UserContext.Provider value={me}>
      <NotifyContext.Provider value={notify}>
        <SnapshotContext.Provider value={snapshot}>
          <HistoryContext.Provider
            value={{ period, setPeriod, loading: historyLoading }}
          >
            <div className="app-layout">
              <button
                className={"sidebar-shade " + (mobile ? "visible" : "")}
                aria-label={t("Menü schließen")}
                onClick={() => setMobile(false)}
              />
              <aside className={"sidebar " + (mobile ? "open" : "")}>
                <a className="brand" href="#dashboard">
                  <span className="brand-mark">
                    J<span />
                  </span>
                  <div>
                    <strong dir="ltr">
                      Jerry
                      <span className="brand-dot">.</span>
                    </strong>
                    <small dir="ltr">TOMCAT OPERATIONS</small>
                  </div>
                </a>
                <div className="instance-switch">
                  <span className="instance-icon">
                    <Server size={16} />
                  </span>
                  <div>
                    <strong title={me.server.host}>{me.server.host}</strong>
                    <small>{me.server.server}</small>
                  </div>
                  <span className="instance-dot" />
                </div>
                <nav>
                  {navigation.map((group) => (
                    <div className="nav-group" key={group.label}>
                      <div className="nav-label">{t(group.label)}</div>
                      {group.items.map(([id, label, Icon]) => {
                        const I = Icon as any;
                        return (
                          <a
                            key={String(id)}
                            href={"#" + id}
                            className={page === id ? "active" : ""}
                          >
                            <I size={18} />
                            <span>{t(String(label))}</span>
                            {page === id && <i />}
                          </a>
                        );
                      })}
                    </div>
                  ))}
                </nav>
                <div className="sidebar-bottom">
                  <button className="help-link" onClick={() => setHelp(true)}>
                    <HelpCircle size={17} />
                    <span>{t("Gut zu wissen")}</span>
                    <ArrowUpRight size={14} />
                  </button>
                  <div className="user-card">
                    <span className="avatar">
                      {String(me.user).slice(0, 2).toUpperCase()}
                    </span>
                    <div>
                      <strong>{me.user}</strong>
                      <small>
                        {me.permissions.admin
                          ? t("Administrator")
                          : me.permissions.operator
                            ? t("Operator")
                            : me.permissions.sql
                              ? t("Datenbankzugriff")
                              : t("Lesender Zugriff")}
                      </small>
                    </div>
                    <button
                      className="icon-button"
                      aria-label={t("Abmelden")}
                      title={t("Abmelden")}
                      onClick={async () => {
                        await api("/logout", {});
                        location.href = "./?reauth=" + Date.now().toString(36);
                      }}
                    >
                      <LogOut size={16} />
                    </button>
                  </div>
                </div>
              </aside>
              <div className="main-shell">
                <header className="topbar">
                  <div>
                    <button
                      className="icon-button mobile-menu"
                      aria-label={t("Menü öffnen")}
                      onClick={() => setMobile(!mobile)}
                    >
                      <Menu size={20} />
                    </button>
                    <span className="breadcrumb">
                      {t("Workspace")}
                      <span>/</span>
                      <strong>{heading}</strong>
                    </span>
                  </div>
                  <div className="topbar-actions">
                    <label className="language-picker">
                      <span className="sr-only">{t("Sprache")}</span>
                      <select
                        aria-label={t("Sprache")}
                        value={language.language}
                        onChange={(event) =>
                          language.setLanguage(event.target.value)
                        }
                      >
                        {LANGUAGES.map(([code, name]) => (
                          <option key={code} value={code}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <span
                      className={
                        "connection-indicator " + (live ? "connected" : "")
                      }
                    >
                      <i />
                      {live
                        ? t("Live verbunden")
                        : t("Polling / Wiederverbinden")}
                    </span>
                    <span className="topbar-separator" />
                    <button
                      className="icon-button"
                      title={
                        theme === "light"
                          ? t("Dunkles Design")
                          : t("Helles Design")
                      }
                      aria-label={t("Design umschalten")}
                      onClick={() =>
                        setTheme(theme === "light" ? "dark" : "light")
                      }
                    >
                      {theme === "light" ? (
                        <Moon size={17} />
                      ) : (
                        <Sun size={17} />
                      )}
                    </button>
                    <button
                      className="icon-button"
                      aria-label={t("Hilfe")}
                      onClick={() => setHelp(true)}
                    >
                      <HelpCircle size={18} />
                    </button>
                  </div>
                </header>
                <main key="main">
                  <div className="content-container">
                    {monitored && (
                      <div className="period-select">
                        <span>{t("Zeitraum für alle Grafiken")}</span>
                        <select
                          aria-label={t("Monitoring-Zeitraum")}
                          value={period}
                          onChange={(e) => setPeriod(e.target.value)}
                        >
                          {PERIODS.map((item) => (
                            <option key={item.value} value={item.value}>
                              {t(item.label)}
                            </option>
                          ))}
                        </select>
                        {historyLoading && (
                          <span role="status">
                            {t("Historie wird geladen …")}
                          </span>
                        )}
                      </div>
                    )}
                    {monitored && historyError && (
                      <div className="history-error" role="alert">
                        {t("Historie konnte nicht geladen werden:") + " "}
                        {historyError}{" "}
                        <button
                          className="text-button"
                          onClick={() => setHistoryRetry((value) => value + 1)}
                        >
                          {t("Erneut laden")}
                        </button>
                      </div>
                    )}
                    {page === "dashboard" && <Dashboard history={history} />}{" "}
                    {page === "applications" && (
                      <ApplicationsView
                        appId={params.get("app") || undefined}
                      />
                    )}{" "}
                    {page === "memory" && <MemoryView history={history} />}{" "}
                    {page === "connectors" && (
                      <ConnectorsView history={history} />
                    )}{" "}
                    {page === "processors" && <ProcessorsView />}{" "}
                    {page === "threads" && <ThreadsView />}{" "}
                    {page === "cluster" && <ClusterView history={history} />}{" "}
                    {page === "certificates" && <CertificatesView />}{" "}
                    {page === "system" && <SystemView />}{" "}
                    {page === "datasources" && (
                      <DataSourcesView history={history} />
                    )}{" "}
                    {page === "logs" && <LogsView />}
                    {sqlMounted && (
                      <div
                        style={{ display: page === "sql" ? "block" : "none" }}
                      >
                        <SqlWorkspace
                          source={
                            page === "sql"
                              ? params.get("source") || undefined
                              : undefined
                          }
                        />
                      </div>
                    )}
                    {!menu && <Dashboard history={history} />}
                    <footer className="page-footer">
                      <span>
                        {t("Jerry") + " "}
                        <span className="muted">/</span> {me.version}
                      </span>
                      <span>
                        {me.server.server} {t("· Java") + " "}
                        {me.server.java}
                      </span>
                      <span>{t("Deine Instanz. Deine Werkzeuge.")}</span>
                    </footer>
                  </div>
                </main>
              </div>
              <div className="toast-stack" aria-live="polite">
                {toasts.map((toast) => (
                  <div className={"toast " + toast.type} key={toast.id}>
                    <CheckCircle2 size={17} />
                    <span>{toast.text}</span>
                    <button
                      aria-label={t("Meldung schließen")}
                      onClick={() =>
                        setToasts((previous) =>
                          previous.filter((t) => t.id !== toast.id),
                        )
                      }
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
              {help && (
                <Modal
                  title={t("Willkommen bei Jerry")}
                  onClose={() => setHelp(false)}
                >
                  <div className="help-content">
                    <p>
                      {t(
                        "Jerry verwaltet und überwacht diese Tomcat-Instanz. Verfügbare Aktionen richten sich nach deiner Rolle und der Serverkonfiguration.",
                      ) + " "}
                    </p>
                    <h3>{t("SQL-Arbeitsplatz")}</h3>
                    <p>
                      {t(
                        "Autocommit ist standardmäßig aus. Commit und Rollback gelten pro verbundenem Tab. Strg+Enter führt eine Auswahl oder das aktuelle Statement aus; Strg+Umschalt+Enter das ganze Skript. Bei Oracle- und SQL-Server-Skripten führt Strg+Enter ohne Auswahl den gesamten Editor aus.",
                      ) + " "}
                    </p>
                    <h3>{t("Historische Logs")}</h3>
                    <p>
                      {t(
                        "Wähle links mehrere Dateien für eine gemeinsame Suche aus. GZIP-Archive, rotierte Dateien und mehrzeilige Stacktraces werden unterstützt. Datumsfilter verwenden die erkannte Ereigniszeit.",
                      ) + " "}
                    </p>
                    <h3>{t("Messwerte")}</h3>
                    <p>
                      {t(
                        "„—“ bedeutet nicht verfügbar. Requestprozessoren sind Momentaufnahmen; Histogramme messen abgeschlossene Requests seit dem Start von Jerry. Die Perzentile sind Bucket-Obergrenzen.",
                      ) + " "}
                    </p>
                    <p>
                      {t(
                        "Der Zeitraum kann oben oder an jeder Grafik geändert werden und gilt gemeinsam für alle Grafiken. Die Auswahl bleibt in diesem Browser gespeichert. Mit den Pfeiltasten lassen sich Messpunkte auswählen; CSV exportiert die angezeigten Messpunkte als Zahlen und Zeitstempel in UTC. Lücken und erkannte Neustarts unterbrechen den Verlauf. Lange Zeiträume verwenden ausgedünnte Historienwerte.",
                      ) + " "}
                    </p>
                    <h3>{t("Berechtigungen")}</h3>
                    <p>
                      {t(
                        "Lesen: jerry-viewer · Verwaltung: jerry-operator · SQL: jerry-sql · SQL-Lesen: jerry-sql-read mit erzwungenen Datenbankrechten · Vollzugriff: jerry-admin.",
                      ) + " "}
                    </p>
                  </div>
                </Modal>
              )}
            </div>
          </HistoryContext.Provider>
        </SnapshotContext.Provider>
      </NotifyContext.Provider>
    </UserContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
