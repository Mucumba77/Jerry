import { t, tr } from "./i18n";
import { ReactNode, useEffect, useState } from "react";
import { Activity, Clock, ShieldCheck } from "lucide-react";
import { api, formatDate, formatNumber, Row } from "./api";
import {
  Badge,
  Code,
  DataTable,
  Empty,
  ErrorBox,
  KeyValues,
  Loading,
  Panel,
  useLoad,
  useNotify,
  useUser,
} from "./components";

export function modeLabel(mode?: string) {
  return t(
    mode === "DIAGNOSTIC"
      ? "Diagnose"
      : mode === "EXTENDED"
        ? "Erweitert"
        : "Basis",
  );
}
const choices = [
  {
    mode: "BASIC",
    title: "Basis",
    icon: ShieldCheck,
    text: "Standard für jede Anwendung. Gemeinsame JVM-, Request-, Connector- und Poolwerte; keine anwendungsbezogenen Detailereignisse.",
  },
  {
    mode: "EXTENDED",
    title: "Erweitert",
    icon: Activity,
    text: "Servlet- und Quartz-Laufzeiten, Framework-Zustände sowie optional eingebundene HTTP-, JMS- und SQL-Operationen. Pro Anwendung freischaltbar.",
  },
  {
    mode: "DIAGNOSTIC",
    title: "Diagnose",
    icon: Clock,
    text: "Zusätzliche Einzelmessungen mit Sampling und begrenztem Speicher. Endet automatisch und kehrt zur vorherigen Betriebsart zurück.",
  },
];
function MonitoringSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="monitor-component-section" aria-label={title}>
      <div className="monitor-section-head">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {children}
    </section>
  );
}
export function ApplicationMonitoring({
  id,
  onChange,
}: {
  id: string;
  onChange: () => Promise<void>;
}) {
  const data = useLoad<Row>(`/applications/${id}/monitoring`, [], 3000),
    user = useUser(),
    notify = useNotify();
  const [seconds, setSeconds] = useState(300),
    [busy, setBusy] = useState(false),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const profile = data.data?.profile,
    telemetry = data.data?.telemetry,
    collection = data.data?.collection,
    components = collection?.components;
  useEffect(() => {
    if (profile?.maxDiagnosticSeconds)
      setSeconds((value) => Math.min(value, profile.maxDiagnosticSeconds));
  }, [profile?.maxDiagnosticSeconds]);
  async function change(body: Row) {
    setBusy(true);
    try {
      const updated = await api<Row>(`/applications/${id}/monitoring`, body);
      setNow(Date.now());
      data.setData(updated);
      await onChange();
      notify(t("Monitoring-Betriebsart aktualisiert."));
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  if (data.loading) return <Loading />;
  const remaining = profile?.expiresAt
    ? Math.min(
        profile.remainingSeconds,
        Math.max(0, Math.ceil((profile.expiresAt - now) / 1000)),
      )
    : 0;
  const columns = (keys: [string, string][]) =>
    keys.map(([key, label]) => ({
      key,
      label,
      render: (v: any) =>
        typeof v === "boolean"
          ? v
            ? t("Ja")
            : t("Nein")
          : v == null
            ? "—"
            : typeof v === "number"
              ? formatNumber(v, key.endsWith("Ms") ? 3 : 0)
              : String(v),
    }));
  return (
    <div className="monitoring-profile">
      <ErrorBox error={data.error} />
      <Panel
        title={t("Betriebsart dieser Anwendung")}
        subtitle={t(
          "Ein gemeinsamer Collector versorgt alle Ansichten. Das Öffnen dieser Seite aktiviert keine zusätzliche Erfassung.",
        )}
        actions={
          <Badge tone={profile?.mode === "DIAGNOSTIC" ? "orange" : "blue"}>
            {modeLabel(profile?.mode)}
          </Badge>
        }
      >
        <div className="monitor-mode-grid">
          {choices.map(({ mode, title, icon: Icon, text }) => (
            <div
              key={mode}
              className={`monitor-mode ${profile?.mode === mode ? "selected" : ""}`}
            >
              <Icon size={23} />
              <h3>{t(title)}</h3>
              <p>{t(text)}</p>
              {mode === "DIAGNOSTIC" && (
                <label>
                  {t("Laufzeit") + " "}
                  <select
                    aria-label={t("Diagnosedauer")}
                    value={seconds}
                    onChange={(event) => setSeconds(Number(event.target.value))}
                  >
                    {[
                      ...new Set([
                        10,
                        30,
                        60,
                        300,
                        600,
                        900,
                        profile?.maxDiagnosticSeconds || 900,
                      ]),
                    ]
                      .filter(
                        (s) => s <= (profile?.maxDiagnosticSeconds || 900),
                      )
                      .sort((a, b) => a - b)
                      .map((s) => (
                        <option key={s} value={s}>
                          {s < 60
                            ? tr("{0} Sekunden", s)
                            : `${s / 60} ${s === 60 ? t("Minute") : t("Minuten")}`}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {user.permissions.admin && (
                <button
                  className={`button ${profile?.mode === mode ? "" : "primary"}`}
                  disabled={busy || profile?.mode === mode}
                  onClick={() => void change({ mode, seconds })}
                >
                  {profile?.mode === mode
                    ? t("Aktiv")
                    : mode === "DIAGNOSTIC"
                      ? t("Diagnose starten")
                      : mode === "BASIC"
                        ? t("Basis aktivieren")
                        : t("Erweitert aktivieren")}
                </button>
              )}
            </div>
          ))}
        </div>
        {profile?.mode === "DIAGNOSTIC" && (
          <div className="monitor-lease">
            <Clock size={18} />
            <span>
              {t("Noch") + " "}
              {remaining} {t("Sekunden · danach") + " "}
              {modeLabel(profile.baseline)} {t("· Ende") + " "}
              {formatDate(profile.expiresAt)}
            </span>
            {user.permissions.admin && (
              <button
                className="button"
                disabled={busy}
                onClick={() => void change({ action: "stop" })}
              >
                {t("Diagnose beenden")}
              </button>
            )}
          </div>
        )}
        {!user.permissions.admin && (
          <p>{t("Die Betriebsart kann ein Administrator ändern.")}</p>
        )}
        <p className="muted">
          {t(
            "Erweitert bleibt nach einem Neustart aktiv. Diagnosen werden niemals fortgesetzt. Maximal",
          ) + " "}
          {profile?.maxDiagnosticApplications}{" "}
          {t("parallele Diagnosen, höchstens") + " "}
          {profile?.maxDiagnosticSeconds / 60} {t("Minuten pro Lauf.")}
        </p>
      </Panel>
      <Panel
        title={t("Optionales HTTP-, JMS- und SQL-Monitoring")}
        description={t(
          "Die Anwendung muss den Jerry-Adapter selbst einbinden und ihre Clients beziehungsweise Datenquelle umschließen. Jerry greift nicht eigenständig in Anwendungscode ein. Im Basisbetrieb werden keine zusätzlichen Operationen erfasst; Erweitert aggregiert Laufzeiten und Fehler, Diagnose ergänzt zeitlich begrenzte Einzelmessungen.",
        )}
      >
        <div className="panel-padding">
          <p>
            {t("Verbindung zur Anwendung:") + " "}
            {profile?.mode === "BASIC"
              ? t("im Basisbetrieb deaktiviert")
              : data.data?.instrumentation?.bridgeReady
                ? t("bereit")
                : t("wird vorbereitet oder ist nicht verfügbar")}
            {t(
              ". Erfasst werden weder URLs noch SQL-Texte, Parameter, Nachrichten oder Inhalte.",
            )}
          </p>
          <p>
            <a href="instrumentation/jerry-instrumentation-2.0.0.jar" download>
              {t("Adapter-JAR herunterladen")}
            </a>
            {/Apache Tomcat\/(10|11)\./.test(user.server?.server || "") && (
              <>
                {" "}
                ·{" "}
                <a
                  href="instrumentation/jerry-instrumentation-2.0.0-legacy-jms.jar"
                  download
                >
                  {t("Adapter für älteres javax.jms herunterladen")}
                </a>
              </>
            )}{" "}
            {t(
              "· Die Integrationsbeispiele stehen in der mitgelieferten Dokumentation",
            ) + " "}
            <strong>docs/instrumentation.md</strong>.
          </p>
        </div>
      </Panel>
      {profile?.mode === "BASIC" ? (
        <Panel title={t("Basis-Monitoring aktiv")}>
          <Empty
            title={t("Keine zusätzliche Detailerfassung")}
            detail={t(
              "Speicher, GC, Requests, Connectoren und Datenquellen stehen weiterhin in den Monitoring-Ansichten bereit. Erweitert kann gezielt für diese Anwendung aktiviert werden.",
            )}
          />
        </Panel>
      ) : (
        <>
          <Panel
            title={t("Operationen & Laufzeiten")}
            subtitle={tr(
              "Messfenster ab {0} · maximal {1} Gruppen · P95/P99 als Histogramm-Obergrenzen",
              formatDate(telemetry?.since),
              telemetry?.operationLimit,
            )}
          >
            <p className="monitor-description">
              {t(
                "Vergleicht Aufrufe, Fehler und Laufzeiten von HTTP-Servlets und Quartz-Jobs sowie optional angebundenen HTTP-, JMS- und SQL-Clients. P95 und P99 zeigen Histogramm-Obergrenzen seit Beginn des Messfensters.",
              )}
            </p>
            <DataTable
              id="app-operations"
              rows={telemetry?.operations || []}
              columns={columns([
                ["operation", "Operation"],
                ["calls", "Aufrufe"],
                ["errors", "Fehler"],
                ["averageMs", "Ø ms"],
                ["maxMs", "Max. ms"],
                ["p95UpperMs", "P95 ≤ ms"],
                ["p99UpperMs", "P99 ≤ ms"],
              ])}
            />
          </Panel>
          <Panel
            className="monitor-components"
            title={t("Anwendungskomponenten")}
            subtitle={
              collection?.collectedAt
                ? tr(
                    "Gemeinsamer Snapshot vom {0} · Abfrage alle 10 Sekunden",
                    formatDate(collection.collectedAt),
                  )
                : t(
                    "Warte auf den nächsten Collector-Lauf (bis zu 10 Sekunden).",
                  )
            }
          >
            <p className="monitor-description">
              {t(
                "Zeigt die erkannten Framework-Komponenten und ihren aktuellen Zustand in dieser Anwendung. Die Übersicht darunter fasst Umfang und mögliche Begrenzungen der Erfassung zusammen.",
              )}
            </p>
            <ErrorBox error={collection?.error || ""} />
            {components ? (
              <>
                <KeyValues
                  data={{
                    "Spring-Kontexte": components.spring?.length,
                    "Untersuchte Singletons": components.inspectedBeans,
                    "Erfassung begrenzt": components.truncated ? "Ja" : "Nein",
                  }}
                />
                <MonitoringSection
                  title={t("Spring-Kontexte")}
                  description={t(
                    "Zeigt die aktiven Spring-Anwendungskontexte und die Anzahl ihrer bereits initialisierten Singleton-Beans. Lazy Beans werden beim Auslesen nicht initialisiert.",
                  )}
                >
                  <DataTable
                    id="app-spring"
                    rows={components.spring || []}
                    columns={columns([
                      ["name", "Kontext"],
                      ["active", "Aktiv"],
                      ["singletons", "Initialisierte Singletons"],
                    ])}
                  />
                </MonitoringSection>
                <MonitoringSection
                  title={t("Quartz · dieser JVM-Knoten")}
                  description={t(
                    "Zeigt Scheduler-Zustand, laufende Jobs und bisherige Ausführungen auf diesem JVM-Knoten. Standby pausiert die Ausführung; „Historie aktiv“ bestätigt die Erfassung neuer Job-Ereignisse.",
                  )}
                >
                  <DataTable
                    id="app-quartz"
                    rows={components.quartz || []}
                    columns={columns([
                      ["name", "Scheduler"],
                      ["started", "Gestartet"],
                      ["standby", "Standby"],
                      ["running", "Jobs aktiv"],
                      ["executed", "Ausführungen"],
                      ["clustered", "Cluster"],
                      ["listenersAttached", "Historie aktiv"],
                    ])}
                  />
                </MonitoringSection>
                <MonitoringSection
                  title={t("JMS · lokale Spring-Listener")}
                  description={t(
                    "Zeigt Destination, aktive Consumer und die eingestellten Consumer-Grenzen der lokalen JMS-Clients. Reconnect weist auf eine Verbindungswiederherstellung hin. Die Queue-Tiefe des Brokers wird hier nicht erfasst.",
                  )}
                >
                  <DataTable
                    id="app-jms"
                    rows={components.jms || []}
                    columns={columns([
                      ["name", "Listener"],
                      ["destination", "Destination"],
                      ["running", "Läuft"],
                      ["consumers", "Consumer aktiv"],
                      ["minConsumers", "Min."],
                      ["maxConsumers", "Max."],
                      ["recovering", "Reconnect"],
                    ])}
                  />
                </MonitoringSection>
                <MonitoringSection
                  title={t("Spring-Executoren")}
                  description={t(
                    "Zeigt die Auslastung der Spring-Threadpools: belegte und vorhandene Threads, maximale Kapazität, wartende Aufgaben und abgeschlossene Ausführungen.",
                  )}
                >
                  <DataTable
                    id="app-executors"
                    rows={components.executors || []}
                    columns={columns([
                      ["name", "Executor"],
                      ["active", "Belegt"],
                      ["threads", "Threads"],
                      ["max", "Max."],
                      ["queued", "Wartend"],
                      ["completed", "Abgeschlossen"],
                    ])}
                  />
                </MonitoringSection>
                <MonitoringSection
                  title={t("Hibernate · vorhandene Statistik")}
                  description={t(
                    "Liest vorhandene Hibernate-Zähler für Abfragen, geladene Objekte und den Second-Level-Cache. Die Statistik muss bereits in der Anwendung aktiviert sein; Jerry schaltet sie nicht selbst ein.",
                  )}
                >
                  <DataTable
                    id="app-orm"
                    rows={components.orm || []}
                    columns={columns([
                      ["name", "SessionFactory"],
                      ["source", "Anbindung"],
                      ["enabled", "Statistik aktiv"],
                      ["queries", "Queries"],
                      ["entityLoads", "Entity Loads"],
                      ["cacheHits", "Cache-Treffer"],
                      ["cacheMisses", "Cache-Misses"],
                      ["transactions", "Transaktionen"],
                      ["maxQueryMs", "Max. Query ms"],
                    ])}
                  />
                  <div className="monitor-section-head">
                    <details>
                      <summary>{t("Hibernate-Monitoring einrichten")}</summary>
                      <p>
                        {t(
                          "1. In dieser Anwendung „Erweitert“ aktivieren. 2. In den Hibernate-Einstellungen der Anwendung die Statistik einschalten:",
                        )}
                      </p>
                      <Code value="hibernate.generate_statistics=true" />
                      <p>
                        {t(
                          "Bei Spring gehört die Eigenschaft in hibernateProperties der LocalSessionFactoryBean oder in jpaProperties der EntityManagerFactoryBean. Bei Spring Boot lautet die Einstellung:",
                        )}
                      </p>
                      <Code value="spring.jpa.properties.hibernate.generate_statistics=true" />
                      <p>
                        {t(
                          "Jerry erkennt bereits initialisierte SessionFactory-Beans und Spring-JPA-FactoryBeans in Root- und DispatcherServlet-Kontexten. Nach der Änderung die Anwendung neu starten und den nächsten Collector-Lauf abwarten (bis zu 10 Sekunden). Lazy Beans werden nicht initialisiert. Die Statistik verursacht zusätzlichen Aufwand in Hibernate; Jerry aktiviert sie nicht selbst. Ein JMX-Export ist dafür nicht erforderlich. Eigene exportierte MBeans stehen im Reiter JMX.",
                        )}
                      </p>
                    </details>
                  </div>
                </MonitoringSection>
                <p className="muted">
                  {components.note}{" "}
                  {t(
                    "Leere Tabellen bedeuten: keine unterstützte, initialisierte Komponente erkannt. Jerry initialisiert keine Lazy Beans und aktiviert keine Hibernate-Statistik.",
                  )}
                </p>
              </>
            ) : (
              <Loading />
            )}
          </Panel>
          <Panel
            title={t("Quartz-Ausführungshistorie")}
            subtitle={tr(
              "Begrenzter Ringpuffer: {0} Ereignisse pro Anwendung. Keine Job-Parameter oder Payloads.",
              telemetry?.eventLimit,
            )}
          >
            <p className="monitor-description">
              {t(
                "Zeigt die zuletzt erfassten Job-Abschlüsse und verpassten Trigger mit Zeitpunkt und Laufzeit. Status 200 steht für Erfolg, 500 für einen Jobfehler und 409 für einen verpassten Trigger (Misfire).",
              )}
            </p>
            <DataTable
              id="app-job-history"
              rows={[...(telemetry?.jobs || [])].reverse()}
              columns={[
                { key: "time", label: t("Zeit"), render: formatDate },
                ...columns([
                  ["operation", "Job / Trigger"],
                  ["status", "Status"],
                  ["durationMs", "Dauer ms"],
                ]),
              ]}
            />
          </Panel>
          {profile?.mode === "DIAGNOSTIC" && (
            <Panel
              title={t("Diagnose · Einzelmessungen")}
              subtitle={tr(
                "{0}% der erfolgreichen Aufrufe; Fehler werden bevorzugt erfasst. Höchstens {1} Ereignisse. Keine URLs, SQL-Parameter, Header oder Inhalte.",
                telemetry?.samplePercent,
                telemetry?.eventLimit,
              )}
            >
              <p className="monitor-description">
                {t(
                  "Zeigt stichprobenartig HTTP-Aufrufe und optional angebundene JMS- und SQL-Operationen. Status 200/500 steht bei JMS und SQL für Erfolg beziehungsweise Fehler. Die Stichprobe ist nur während der Diagnose sichtbar.",
                )}
              </p>
              <DataTable
                id="app-diagnostic-events"
                rows={[...(telemetry?.details || [])].reverse()}
                columns={[
                  { key: "time", label: t("Zeit"), render: formatDate },
                  ...columns([
                    ["operation", "Operation"],
                    ["status", "Status"],
                    ["durationMs", "Dauer ms"],
                  ]),
                ]}
              />
            </Panel>
          )}
          <p className="muted">
            {t("Verworfene oder durch neuere ersetzte Detailereignisse:") + " "}
            {formatNumber(telemetry?.dropped)}
            {t(
              ". Zähler bleiben bei überfülltem Detailpuffer aktiv. Ein Betriebsartwechsel beginnt ein neues Messfenster.",
            )}
          </p>
        </>
      )}
    </div>
  );
}
