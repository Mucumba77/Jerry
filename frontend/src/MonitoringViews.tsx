import { locale, t, tr } from "./i18n";
import { useEffect, useState } from "react";
import { connectorTraffic } from "./connectorTraffic";
import { completeTotal } from "./monitorMath";
import { AlertList, AlertSettings } from "./Alerts";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  CircleDot,
  Cpu,
  Database,
  ExternalLink,
  GitBranch,
  HardDrive,
  Layers,
  MemoryStick,
  Play,
  RefreshCw,
  Server,
  Shield,
  Square,
  Terminal,
  TrendingUp,
  Wifi,
  Zap,
} from "lucide-react";
import {
  api,
  duration,
  formatBytes,
  formatDate,
  formatNumber,
  route,
  Row,
  short,
} from "./api";
import {
  Badge,
  Chart,
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
  Refresh,
  Tabs,
  useLoad,
  useNotify,
  useSnapshot,
  useUser,
} from "./components";

export function Stat({
  label,
  value,
  detail,
  icon: Icon,
  tone = "green",
  progress,
}: {
  label: string;
  value: string;
  detail: string;
  icon: any;
  tone?: string;
  progress?: number;
}) {
  return (
    <div className="stat-card">
      <div className="stat-top">
        <span>{label}</span>
        <span className={"stat-icon " + tone}>
          <Icon size={19} />
        </span>
      </div>
      <div className="stat-value">
        <bdi>{value}</bdi>
      </div>
      {progress != null && (
        <div className="meter">
          <i style={{ width: Math.min(100, progress) + "%" }} />
        </div>
      )}
      <div className="stat-detail">{detail}</div>
    </div>
  );
}
export function Dashboard({ history }: { history: Row[] }) {
  const data = useSnapshot(),
    apps = useLoad<Row[]>("/applications", [], 15000),
    user = useUser();
  const [cursor, setCursor] = useState<number | null>(null);
  if (!data) return <Loading />;
  const heap = data.heap || {},
    busy = data.connectorBusyWorkers,
    running = apps.data?.filter((a) => a.running).length ?? 0;
  const usage = heap.max ? (heap.used / heap.max) * 100 : undefined;
  const warning = (data.alerts?.active?.length || 0) > 0;
  return (
    <>
      <PageTitle
        eyebrow={t("DEINE TOMCAT-INSTANZ")}
        title={t("Alles im Blick.")}
        description={t(
          "Ressourcen, Anwendungen und Datenverkehr an einem Ort.",
        )}
        actions={
          <span className="live-pill">
            <i />
            {t("Live ·") + " "}
            {new Date(data.time).toLocaleTimeString(locale())}
          </span>
        }
      />
      <div className={"health-banner " + (warning ? "warning" : "")}>
        <span className="health-icon">
          {warning ? <Activity size={24} /> : <CheckCircle2 size={24} />}
        </span>
        <div>
          <strong>
            {warning
              ? `${data.alerts.active.length} ${t("Schwellenwertwarnungen aktiv.")}`
              : t("Jerry hat die Instanz im Blick.")}
          </strong>
          <p>
            {running} {t("von") + " "}
            {apps.data?.length ?? "—"}{" "}
            {t("Anwendungen laufen · JVM seit") + " "}
            {duration(data.uptime)} {t("aktiv") + " "}
          </p>
        </div>
        <button className="text-button" onClick={() => route("system")}>
          {t("Instanzdetails") + " "}
          <ArrowRight size={16} />
        </button>
      </div>
      <Panel
        title={t("Aktuelle Warnungen")}
        description={t(
          "Lokale Schwellenwerte für Heap, Connection Pools und HTTP-Fehler. Die Regeln lassen sich unter System & Diagnose konfigurieren.",
        )}
        actions={
          <button className="text-button" onClick={() => route("system")}>
            {t("Regeln") + " "}
            <ArrowRight size={14} />
          </button>
        }
      >
        <div className="panel-padding">
          <AlertList alerts={data.alerts} />
        </div>
      </Panel>
      <div className="stats-grid">
        <Stat
          label={t("Heap-Speicher")}
          value={formatBytes(heap.used)}
          detail={t("von") + " " + formatBytes(heap.max) + " " + t("maximal")}
          icon={MemoryStick}
          progress={usage}
        />
        <Stat
          label={t("Requests / Sekunde")}
          value={formatNumber(
            completeTotal(data.connectors, "requestCountRate"),
            1,
          )}
          detail={t("Über alle Connectoren")}
          icon={Activity}
        />
        <Stat
          label={t("Beschäftigte Connector-Worker")}
          value={formatNumber(busy)}
          detail={
            busy == null
              ? t("Für diesen Executor nicht verfügbar")
              : t("Gemeinsame Pools einmal gezählt")
          }
          icon={Layers}
          tone="orange"
        />
        <Stat
          label={t("Prozess-CPU")}
          value={
            data.os?.processCpu == null
              ? "—"
              : formatNumber(data.os.processCpu * 100, 1) + " %"
          }
          detail={data.os?.processors + " " + t("logische Prozessoren")}
          icon={Cpu}
          tone="purple"
        />
      </div>
      <div className="two-columns">
        <Panel
          title={t("Speicherentwicklung")}
          subtitle={t("Verwendeter JVM-Heap")}
          actions={
            <button className="text-button" onClick={() => route("memory")}>
              {t("Details") + " "}
              <ArrowRight size={14} />
            </button>
          }
        >
          <Chart
            points={history}
            value={(p) => p.heap?.used}
            format={formatBytes}
            label={t("Heap")}
            exportLabel="Heap (Bytes)"
            cursor={cursor}
            onCursor={setCursor}
          />
        </Panel>
        <Panel
          title={t("Request-Durchsatz")}
          subtitle={t("Abgeschlossene Requests pro Sekunde")}
          actions={
            <button className="text-button" onClick={() => route("connectors")}>
              {t("Connectoren") + " "}
              <ArrowRight size={14} />
            </button>
          }
        >
          <Chart
            points={history}
            value={(p) => completeTotal(p.connectors, "requestCountRate")}
            color="var(--chart-secondary)"
            label={t("Requests/s")}
            cursor={cursor}
            onCursor={setCursor}
          />
        </Panel>
      </div>
      <div className="two-columns dashboard-bottom">
        <Panel
          title={t("Anwendungen")}
          subtitle={t("Status der bereitgestellten Contexts")}
          actions={
            <button
              className="text-button"
              onClick={() => route("applications")}
            >
              {t("Alle anzeigen") + " "}
              <ArrowRight size={14} />
            </button>
          }
        >
          <ErrorBox error={apps.error} />
          {apps.data?.slice(0, 5).map((app) => {
            const summary = (
              <>
                <span className="app-icon">
                  <Layers size={18} />
                </span>
                <div>
                  <strong>
                    {app.path || "ROOT"}
                    {app.version && <small> #{app.version}</small>}
                  </strong>
                  <span>{app.host}</span>
                </div>
                <Badge tone={app.running ? "green" : "red"}>
                  {app.running ? t("Aktiv") : t("Gestoppt")}
                </Badge>
                <span className="muted">
                  {app.sessions ?? "—"} {t("Sessions")}
                </span>
              </>
            );
            return user.permissions.operator ? (
              <a
                className="app-summary app-summary-link"
                key={app.id}
                href={`#applications?app=${encodeURIComponent(app.id)}`}
                aria-label={tr(
                  "Anwendung {0} auf {1} öffnen",
                  `${app.path || "ROOT"}${app.version ? " #" + app.version : ""}`,
                  app.host,
                )}
              >
                {summary}
              </a>
            ) : (
              <div className="app-summary" key={app.id}>
                {summary}
              </div>
            );
          })}
        </Panel>
        <Panel
          title={t("Direkt zum Werkzeug")}
          subtitle={t("Die häufigsten Aufgaben, einen Klick entfernt")}
        >
          <div className="tool-grid">
            {[
              [
                Database,
                "SQL-Arbeitsplatz",
                "Abfragen, Transaktionen und Export",
                "sql",
              ],
              [Terminal, "Log-Explorer", "Live und archivierte Logs", "logs"],
              [
                Layers,
                "Requestprozessoren",
                "Laufende Requests untersuchen",
                "processors",
              ],
              [
                Shield,
                "Zertifikate",
                "Gültigkeit und Truststores prüfen",
                "certificates",
              ],
            ].map(([Icon, title, desc, page]) => {
              const I = Icon as any;
              return (
                <button
                  className="tool-link"
                  key={String(page)}
                  onClick={() => route(String(page))}
                >
                  <span>
                    <I size={19} />
                  </span>
                  <div>
                    <strong>{String(title)}</strong>
                    <small>{String(desc)}</small>
                  </div>
                  <ArrowRight size={16} />
                </button>
              );
            })}
          </div>
        </Panel>
      </div>
      <div className="footnote">
        <CircleDot size={12} />{" "}
        {t(
          "Messwerte werden lokal erfasst. Fehlende Werte sind mit „—“ gekennzeichnet.",
        ) + " "}
      </div>
    </>
  );
}
export function MemoryView({ history }: { history: Row[] }) {
  const data = useSnapshot(),
    user = useUser(),
    notify = useNotify();
  const [confirm, setConfirm] = useState(false),
    [cursor, setCursor] = useState<number | null>(null);
  if (!data) return <Loading />;
  const gcTime = completeTotal(data.gc, "time");
  return (
    <>
      <PageTitle
        eyebrow={t("MONITORING / JVM")}
        title={t("Speicher & Garbage Collection")}
        description={t(
          "Heap, Speicherpools und native Buffer im zeitlichen Verlauf.",
        )}
        actions={
          user.permissions.admin && (
            <button className="button" onClick={() => setConfirm(true)}>
              {t("GC anfordern") + " "}
            </button>
          )
        }
      />
      <div className="stats-grid">
        <Stat
          label={t("Heap verwendet")}
          value={formatBytes(data.heap?.used)}
          detail={"Zugesichert: " + formatBytes(data.heap?.committed)}
          icon={MemoryStick}
        />
        <Stat
          label={t("Non-Heap")}
          value={formatBytes(data.nonHeap?.used)}
          detail={"Zugesichert: " + formatBytes(data.nonHeap?.committed)}
          icon={Layers}
        />
        <Stat
          label={t("GC-Laufzeit gesamt")}
          value={gcTime == null ? "—" : duration(gcTime)}
          detail={
            formatNumber(completeTotal(data.gc, "count")) +
            " Collections seit JVM-Start"
          }
          icon={RefreshCw}
        />
        <Stat
          label={t("Direkte Buffer")}
          value={formatBytes(
            data.buffers?.find((b: Row) => b.name === "direct")?.used,
          )}
          detail={t("Native Speicherbelegung")}
          icon={HardDrive}
        />
      </div>
      <div className="two-columns">
        <Panel
          title={t("Heap-Verlauf")}
          description={t(
            "Zeigt den verwendeten Speicher für Java-Objekte im gewählten Zeitraum. Ein Rückgang entsteht häufig durch Garbage Collection.",
          )}
        >
          <Chart
            points={history}
            value={(p) => p.heap?.used}
            format={formatBytes}
            label={t("Heap")}
            exportLabel="Heap (Bytes)"
            cursor={cursor}
            onCursor={setCursor}
          />
        </Panel>
        <Panel
          title={t("Non-Heap-Verlauf")}
          description={t(
            "Zeigt den Speicher außerhalb des Java-Heaps, etwa für Klassenmetadaten und kompilierten Code.",
          )}
        >
          <Chart
            points={history}
            value={(p) => p.nonHeap?.used}
            format={formatBytes}
            label={t("Non-Heap")}
            exportLabel="Non-Heap (Bytes)"
            color="var(--chart-tertiary)"
            cursor={cursor}
            onCursor={setCursor}
          />
        </Panel>
      </div>
      <Panel
        title={t("Speicherpools")}
        description={t(
          "Vergleicht Belegung, zugesicherten Speicher und Höchstwerte der JVM-Speicherbereiche. Ein fehlendes Maximum wird mit „—“ angezeigt.",
        )}
      >
        <DataTable
          id="memory-pools"
          rows={data.pools || []}
          columns={[
            { key: "name", label: t("Pool") },
            { key: "type", label: t("Typ") },
            {
              key: "usage",
              label: t("Verwendet"),
              render: (v) => formatBytes(v?.used),
              sort: (r) => r.usage?.used || 0,
            },
            {
              key: "committed",
              label: t("Zugesichert"),
              render: (_, r) => formatBytes(r.usage?.committed),
            },
            {
              key: "max",
              label: t("Maximum"),
              render: (_, r) => formatBytes(r.usage?.max),
            },
            {
              key: "peak",
              label: t("Spitze"),
              render: (v) => formatBytes(v?.used),
            },
          ]}
        />
      </Panel>
      <div className="two-columns">
        <Panel
          title={t("Garbage Collectors")}
          description={t(
            "Anzahl und Gesamtzeit der Speicherbereinigungen seit JVM-Start. „GC anfordern“ bittet die JVM um eine zusätzliche Bereinigung und kann kurzzeitig Pausen verursachen.",
          )}
        >
          <DataTable
            id="gc"
            rows={data.gc || []}
            searchable={false}
            columns={[
              { key: "name", label: t("Collector") },
              {
                key: "count",
                label: t("Collections"),
                render: (v) => formatNumber(v),
              },
              { key: "time", label: t("Gesamtzeit"), render: duration },
            ]}
          />
        </Panel>
        <Panel
          title={t("Buffer-Pools")}
          description={t(
            "Zeigt Anzahl, Belegung und Kapazität direkter und dateibasierter Buffer. Dieser Speicher liegt außerhalb des Java-Heaps.",
          )}
        >
          <DataTable
            id="buffers"
            rows={data.buffers || []}
            searchable={false}
            columns={[
              { key: "name", label: t("Pool") },
              {
                key: "count",
                label: t("Anzahl"),
                render: (v) => formatNumber(v),
              },
              { key: "used", label: t("Verwendet"), render: formatBytes },
              { key: "capacity", label: t("Kapazität"), render: formatBytes },
            ]}
          />
        </Panel>
      </div>
      {confirm && (
        <Confirm
          title={t("Garbage Collection anfordern?")}
          detail={t(
            "Die JVM entscheidet selbst, ob sie die Anforderung ausführt. Eine GC kann die Anwendung kurz anhalten.",
          )}
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            await api("/gc", {});
            notify(t("GC wurde angefordert."));
          }}
        />
      )}
    </>
  );
}
export function ConnectorsView({ history }: { history: Row[] }) {
  const data = useSnapshot(),
    config = useLoad<Row[]>("/connectors");
  const [selected, setSelected] = useState<string>("");
  if (!data) return <Loading />;
  const connectors = data.connectors || [],
    chosen =
      connectors.find((c: Row) => c.objectName === selected) || connectors[0];
  const traffic = chosen ? connectorTraffic(history, chosen.objectName) : null;
  return (
    <>
      <PageTitle
        eyebrow={t("MONITORING / NETZWERK")}
        title={t("Connectoren")}
        description={t(
          "Requests, Upload, Download und Transfervolumen je Connector; Thread-Auslastung mit getrennten Executor-Pools.",
        )}
        actions={<Refresh onClick={config.refresh} />}
      />
      <ErrorBox error={config.error} />
      <div className="stats-grid">
        <Stat
          label={t("Requests / s")}
          value={formatNumber(completeTotal(connectors, "requestCountRate"), 1)}
          detail={t("Aktuelles Messintervall")}
          icon={Activity}
        />
        <Stat
          label={t("Fehler / s")}
          value={formatNumber(completeTotal(connectors, "errorCountRate"), 2)}
          detail={t("Tomcat-Fehlerzähler")}
          icon={Zap}
          tone="orange"
        />
        <Stat
          label={t("Download / s")}
          value={formatBytes(completeTotal(connectors, "bytesSentRate"))}
          detail={t("Ausgehende Bytes")}
          icon={Wifi}
        />
        <Stat
          label={t("Upload / s")}
          value={formatBytes(completeTotal(connectors, "bytesReceivedRate"))}
          detail={t("Eingehende Bytes")}
          icon={Server}
        />
      </div>
      <Panel
        title={t("Request-Statistiken")}
        description={t(
          "Vergleicht abgeschlossene Requests, Fehler und Datenraten pro Connector. Eine Zeile auswählen, um dessen Durchsatzverlauf darunter anzuzeigen.",
        )}
      >
        <DataTable
          id="connectors"
          rows={connectors}
          onRow={(row) => setSelected(row.objectName)}
          columns={[
            { key: "name", label: t("Connector") },
            {
              key: "requestCountRate",
              label: t("Requests/s"),
              render: (v) => formatNumber(v, 1),
            },
            {
              key: "errorCountRate",
              label: t("Fehler/s"),
              render: (v) => formatNumber(v, 2),
            },
            {
              key: "averageMs",
              label: t("Ø Laufzeit"),
              render: (v) => (v == null ? "—" : formatNumber(v, 1) + " ms"),
            },
            {
              key: "maxTime",
              label: t("Max. seit Start"),
              render: (v) => (v == null ? "—" : duration(v)),
            },
            {
              key: "bytesSentRate",
              label: t("Download/s"),
              render: formatBytes,
            },
            {
              key: "bytesReceivedRate",
              label: t("Upload/s"),
              render: formatBytes,
            },
            {
              key: "bytesSent",
              label: t("Download gesamt"),
              render: formatBytes,
            },
            {
              key: "bytesReceived",
              label: t("Upload gesamt"),
              render: formatBytes,
            },
            {
              key: "requestCount",
              label: t("Requests gesamt"),
              render: (v) => formatNumber(v),
            },
          ]}
        />
      </Panel>
      {chosen && (
        <Panel
          title={"Durchsatz · " + chosen.name}
          description={t(
            "Abgeschlossene Requests pro Sekunde für den ausgewählten Connector im gewählten Zeitraum.",
          )}
        >
          <Chart
            points={history}
            value={(point) =>
              point.connectors?.find(
                (c: Row) => c.objectName === chosen.objectName,
              )?.requestCountRate
            }
            label={t("Requests/s")}
            exportLabel={`${chosen.name} Requests/s`}
          />
        </Panel>
      )}
      {chosen && traffic && (
        <>
          <Panel
            title={tr("Transfervolumen · {0}", chosen.name)}
            subtitle={t(
              "Upload = Client → Tomcat · Download = Tomcat → Client",
            )}
            description={t(
              "Zählerstände zeigen das Volumen seit Connector-Start bzw. letztem Zählerreset. Die Zeitraumwerte entstehen aus Differenzen der verfügbaren kumulativen Byte-Zähler; die Kurven darunter zeigen die gemessenen Intervallraten.",
            )}
          >
            <KeyValues
              data={{
                "Download · Zählerstand": formatBytes(chosen.bytesSent),
                "Upload · Zählerstand": formatBytes(chosen.bytesReceived),
                "Download · erfasster Zeitraum": formatBytes(traffic.download),
                "Upload · erfasster Zeitraum": formatBytes(traffic.upload),
                "Download · Ø / Spitze": `${formatBytes(traffic.downloadAverage)}/s / ${formatBytes(traffic.downloadPeak)}/s`,
                "Upload · Ø / Spitze": `${formatBytes(traffic.uploadAverage)}/s / ${formatBytes(traffic.uploadPeak)}/s`,
                "Verfügbare Messpunkte": traffic.samples,
                "Erfasster Verlauf":
                  traffic.from && traffic.to
                    ? tr(
                        "{0} bis {1}",
                        formatDate(traffic.from),
                        formatDate(traffic.to),
                      )
                    : t("Noch keine Messpunkte"),
              }}
            />
            <p className="panel-description">
              {t(
                "Der gewählte Zeitraum kann größer sein als der verfügbare Verlauf. Sprünge über Neustarts oder Zähler-Resets werden ausgelassen (",
              )}
              {traffic.resets}
              {t("); fehlende Messpunkte:") + " "}
              {traffic.missing}
              {t(
                ". Mindestens zwei passende Messpunkte sind für ein Volumen erforderlich. Spitzen beziehen sich auf die verfügbaren Messintervalle; kurze Spitzen zwischen den Messungen können fehlen. Die Zähler bilden den von Tomcat gemeldeten HTTP-Datenverkehr ab, nicht Ethernet-, TCP- oder TLS-Overhead.",
              )}
            </p>
          </Panel>
          <div className="two-columns">
            <Panel
              title={`Download · ${chosen.name}`}
              description={t(
                "Von Tomcat an Clients gesendete Bytes pro Sekunde im gewählten Zeitraum.",
              )}
            >
              <Chart
                points={traffic.rates}
                value={(p) => p.downloadRate}
                format={(v) => formatBytes(v) + "/s"}
                label={t("Download")}
                exportLabel={`${chosen.name} Download (Bytes/s)`}
              />
            </Panel>
            <Panel
              title={`Upload · ${chosen.name}`}
              description={t(
                "Von Clients an Tomcat empfangene Bytes pro Sekunde im gewählten Zeitraum.",
              )}
            >
              <Chart
                points={traffic.rates}
                value={(p) => p.uploadRate}
                format={(v) => formatBytes(v) + "/s"}
                label={t("Upload")}
                exportLabel={`${chosen.name} Upload (Bytes/s)`}
                color="var(--chart-secondary)"
              />
            </Panel>
          </div>
        </>
      )}
      <Panel
        title={t("Connector-Threadpools")}
        description={t(
          "Zeigt belegte Threads und offene Verbindungen je Connector. Verwendet ein Connector einen gemeinsamen Executor, steht dessen tatsächliche Thread-Auslastung im nächsten Abschnitt.",
        )}
        subtitle={t(
          "Bei gemeinsamem Executor gelten dessen Werte; -1 bedeutet nicht verwendet.",
        )}
      >
        <DataTable
          id="threadpools"
          rows={data.threadPools || []}
          columns={[
            { key: "name", label: t("Pool") },
            {
              key: "currentThreadsBusy",
              label: t("Beschäftigt"),
              render: (v, row) =>
                row.maxThreads < 0 ? t("Executor") : formatNumber(v),
            },
            { key: "currentThreadCount", label: t("Threads") },
            {
              key: "maxThreads",
              label: t("Max. Threads"),
              render: (v) => (v == null || v < 0 ? t("Executor") : v),
            },
            { key: "connectionCount", label: t("Verbindungen") },
            { key: "maxConnections", label: t("Max. Verbindungen") },
            { key: "keepAliveCount", label: t("Keep-Alive") },
          ]}
        />
      </Panel>
      <Panel
        title={t("Gemeinsame Executor-Pools")}
        description={t(
          "Gemeinsam von Connectoren genutzte Worker mit aktiven Threads, Kapazität und wartenden Aufgaben. Die Werte eines gemeinsamen Pools werden nicht je Connector addiert.",
        )}
      >
        <DataTable
          id="executors"
          rows={data.executors || []}
          columns={[
            { key: "name", label: t("Executor") },
            { key: "activeCount", label: t("Aktiv") },
            { key: "poolSize", label: t("Threads") },
            { key: "maxThreads", label: t("Maximum") },
            { key: "queueSize", label: t("Warteschlange") },
            { key: "completedTaskCount", label: t("Abgeschlossen") },
          ]}
        />
      </Panel>
      <Panel
        title={t("Konfiguration")}
        description={t(
          "Liest Port, Protokoll, TLS-Nutzung und Betriebszustand der konfigurierten Tomcat-Connectoren.",
        )}
      >
        <DataTable
          id="connector-config"
          rows={config.data || []}
          columns={[
            { key: "port", label: t("Port") },
            { key: "protocol", label: t("Protokoll") },
            { key: "scheme", label: t("Schema") },
            {
              key: "secure",
              label: t("TLS"),
              render: (v) => (v ? t("Ja") : t("Nein")),
            },
            { key: "state", label: t("Status") },
          ]}
        />
      </Panel>
    </>
  );
}
const stages = [
  "Bereit",
  "Parse",
  "Vorbereitung",
  "Service",
  "Eingabe abschließen",
  "Ausgabe abschließen",
  "Keep-Alive",
  "Beendet",
];
export function ProcessorsView() {
  const data = useLoad<Row[]>("/processors", [], 5000),
    snapshot = useSnapshot();
  const [active, setActive] = useState(true);
  return (
    <>
      <PageTitle
        eyebrow={t("MONITORING / REQUESTS")}
        title={t("Requestprozessoren")}
        description={t(
          "Momentaufnahme der Tomcat-Worker. Kurze Requests können zwischen zwei Messungen liegen.",
        )}
        actions={<Refresh onClick={data.refresh} />}
      />
      <ErrorBox error={data.error} />
      <Panel
        title={t("Aktuelle Prozessoren")}
        description={t(
          "Zeigt die gerade sichtbaren Worker mit Request, Phase und Laufzeit. „Nur aktive Requests“ beschränkt die Liste auf die Service-Phase; kurze Requests können zwischen den Aktualisierungen liegen.",
        )}
        actions={
          <label className="check">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            {t("Nur aktive Requests") + " "}
          </label>
        }
      >
        <DataTable
          id="processors"
          rows={(data.data || []).filter((r) => !active || r.stage === 3)}
          columns={[
            { key: "name", label: t("Worker") },
            {
              key: "stage",
              label: t("Phase"),
              render: (v) => (
                <Badge tone={v === 3 ? "green" : "neutral"}>
                  {stages[v] || v}
                </Badge>
              ),
            },
            { key: "method", label: t("Methode") },
            { key: "currentUri", label: t("URI") },
            {
              key: "requestProcessingTime",
              label: t("Laufzeit"),
              render: (v) => (v == null ? "—" : duration(v)),
            },
            { key: "remoteAddr", label: t("Client") },
            { key: "workerThreadName", label: t("Thread") },
            {
              key: "requestBytesSent",
              label: t("Gesendet"),
              render: formatBytes,
            },
          ]}
        />
      </Panel>
      <Panel
        title={t("Gemessene Request-Abschlüsse")}
        description={t(
          "Zählt tatsächlich abgeschlossene Requests je Anwendung, einschließlich asynchroner Aufrufe. Laufzeiten und Fehler ergänzen die Momentaufnahme der aktiven Prozessoren.",
        )}
        subtitle={t(
          "Kumulative Messung seit Aktivierung von Jerry. p95/p99 sind obere Grenzen logarithmischer Histogramm-Buckets.",
        )}
      >
        <DataTable
          id="request-histograms"
          rows={snapshot?.applicationMetrics || []}
          columns={[
            { key: "application", label: t("Host / Anwendung") },
            {
              key: "requests",
              label: t("Abgeschlossen"),
              render: (v) => formatNumber(v),
            },
            {
              key: "errors",
              label: t("HTTP ≥ 400"),
              render: (v) => formatNumber(v),
            },
            {
              key: "averageMs",
              label: t("Ø ms"),
              render: (v) => formatNumber(v, 2),
            },
            {
              key: "p95UpperMs",
              label: t("p95 ≤ ms"),
              render: (v) => formatNumber(v),
            },
            {
              key: "p99UpperMs",
              label: t("p99 ≤ ms"),
              render: (v) => formatNumber(v),
            },
            {
              key: "maxMs",
              label: t("Max. ms"),
              render: (v) => formatNumber(v, 2),
            },
            { key: "since", label: t("Seit"), render: formatDate },
          ]}
        />
      </Panel>
    </>
  );
}
export function ThreadsView() {
  const data = useLoad<Row[]>("/threads", [], 5000),
    user = useUser(),
    notify = useNotify();
  const [selected, setSelected] = useState<Row | null>(null),
    [action, setAction] = useState<{ row: Row; force: boolean } | null>(null);
  return (
    <>
      <PageTitle
        eyebrow={t("MONITORING / JVM")}
        title={t("Threads")}
        description={t("Threadzustände, Stacktraces und erkannte Deadlocks.")}
        actions={<Refresh onClick={data.refresh} />}
      />
      <ErrorBox error={data.error} />
      {data.data?.some((t) => t.deadlocked) && (
        <ErrorBox error="Es wurden Deadlocks erkannt. Betroffene Threads sind markiert." />
      )}
      <Panel
        title={t("JVM-Threads")}
        description={t(
          "Zeigt Threadzustände, Blockierungen und verfügbare CPU-Zähler. Eine Zeile öffnet den aktuellen Stacktrace; dort stehen Administratoren auch Thread-Aktionen zur Verfügung.",
        )}
      >
        <DataTable
          id="threads"
          rows={data.data || []}
          onRow={async (row) => {
            try {
              const values = await api<Row[]>("/threads?stacks=true");
              setSelected(values.find((t) => t.id === row.id) || row);
            } catch (error) {
              notify((error as Error).message, "error");
            }
          }}
          columns={[
            {
              key: "name",
              label: t("Thread"),
              render: (v, r) => (
                <span className={r.deadlocked ? "danger-text" : ""}>
                  {v}
                  {r.deadlocked ? t(" · DEADLOCK") : ""}
                </span>
              ),
            },
            {
              key: "state",
              label: t("Zustand"),
              render: (v) => (
                <Badge tone={v === "RUNNABLE" ? "green" : "neutral"}>{v}</Badge>
              ),
            },
            {
              key: "cpuNanos",
              label: t("CPU gesamt"),
              render: (v) => (v == null ? "—" : duration(v / 1000000)),
            },
            { key: "blockedCount", label: t("Blockierungen") },
            { key: "waitedCount", label: t("Wartevorgänge") },
            { key: "lockOwner", label: t("Lock-Inhaber") },
            { key: "id", label: t("ID") },
          ]}
        />
      </Panel>
      {selected && (
        <Modal title={selected.name} onClose={() => setSelected(null)} wide>
          <p className="modal-description">
            {t(
              "Momentaufnahme dieses Threads mit Lock-Informationen und Stacktrace. Ein Interrupt fordert eine Unterbrechung an; die Anwendung entscheidet, wie sie darauf reagiert.",
            )}
          </p>
          <KeyValues
            data={{
              ID: selected.id,
              Zustand: selected.state,
              Lock: selected.lock,
              "Lock-Inhaber": selected.lockOwner,
            }}
          />
          <Code value={(selected.stack || []).join("\n")} />
          {user.permissions.admin && (
            <div className="modal-actions">
              <button
                className="button"
                onClick={() => setAction({ row: selected, force: false })}
              >
                {t("Interrupt senden") + " "}
              </button>
              {user.settings.forceThreadStop && (
                <button
                  className="button danger"
                  onClick={() => setAction({ row: selected, force: true })}
                >
                  {t("Erzwungen beenden") + " "}
                </button>
              )}
            </div>
          )}
        </Modal>
      )}
      {action && (
        <Confirm
          title={
            action.force
              ? t("Thread erzwungen beenden?")
              : t("Thread unterbrechen?")
          }
          detail={
            action.force
              ? "Das erzwungene Beenden kann gemeinsam genutzten Zustand beschädigen. Thread: " +
                action.row.name
              : "Interrupt-Anforderung an " +
                action.row.name +
                ". Der Thread kann darauf reagieren oder weiterlaufen."
          }
          danger={action.force}
          onClose={() => setAction(null)}
          onConfirm={async () => {
            await api("/threads/" + action.row.id, {
              action: action.force ? "stop" : "interrupt",
            });
            notify(t("Anforderung gesendet."));
            await data.refresh();
          }}
        />
      )}
    </>
  );
}
export function SystemView() {
  const system = useLoad<Row>("/system"),
    diag = useLoad<Row>(useUser().permissions.admin ? "/diagnostics" : null),
    wrapper = useLoad<Row>("/wrapper"),
    snapshot = useSnapshot(),
    user = useUser(),
    notify = useNotify();
  const [check, setCheck] = useState<Row | null>(null),
    [busy, setBusy] = useState(false),
    [restart, setRestart] = useState(false);
  return (
    <>
      <PageTitle
        eyebrow={t("ADMINISTRATION / INSTANZ")}
        title={t("System & Diagnose")}
        description={t("Laufzeit, Betriebssystem und Jerry-Ressourcen.")}
        actions={
          user.permissions.admin && (
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setCheck(await api("/quickcheck", {}));
                } catch (e) {
                  notify((e as Error).message, "error");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <CheckCircle2 size={16} />
              {t("Quick Check") + " "}
            </button>
          )
        }
      />
      <ErrorBox error={system.error} />
      <AlertSettings />
      <div className="two-columns">
        <Panel
          title={t("Java-Laufzeit")}
          description={t(
            "Version, Hersteller und Startzeit der JVM, in der Tomcat und die Anwendungen laufen.",
          )}
        >
          <KeyValues
            data={{
              Java: system.data?.javaVersion,
              Hersteller: system.data?.javaVendor,
              JVM: system.data?.vmName,
              Gestartet: formatDate(system.data?.started),
              Laufzeit: duration(snapshot?.uptime || 0),
            }}
          />
        </Panel>
        <Panel
          title={t("Betriebssystem")}
          description={t(
            "Zeigt die vom Betriebssystem bereitgestellten Prozessor- und Speicherwerte. Nicht unterstützte Messwerte erscheinen als „—“.",
          )}
        >
          <KeyValues
            data={{
              System: snapshot?.os?.name,
              Version: snapshot?.os?.version,
              Architektur: snapshot?.os?.arch,
              Prozessoren: snapshot?.os?.processors,
              "Physischer Speicher": formatBytes(snapshot?.os?.physicalTotal),
              "Davon frei": formatBytes(snapshot?.os?.physicalFree),
              "Swap gesamt": formatBytes(snapshot?.os?.swapTotal),
              "Swap frei": formatBytes(snapshot?.os?.swapFree),
            }}
          />
        </Panel>
      </div>
      {diag.data && (
        <Panel
          title={t("Jerry-Ressourcen")}
          description={t(
            "Zeigt Jerrys Datenablage, offene SQL-Verbindungen, Ergebnisdateien und Worker. „Quick Check“ prüft Plattform, Ablage und verfügbare Betriebsfunktionen.",
          )}
        >
          <KeyValues
            data={{
              Datenverzeichnis: diag.data.dataDirectory,
              Konfiguration: diag.data.configFile,
              "Offene SQL-Verbindungen": diag.data.sql?.sessions,
              "SQL-Ergebnisdateien": formatBytes(diag.data.sql?.spoolBytes),
              "SQL-Limit": formatBytes(diag.data.sql?.spoolLimit),
              "SQL-Worker aktiv": diag.data.sql?.activeWorkers,
              "SQL-Warteschlange": diag.data.sql?.queued,
              "Live-Verbindungen": diag.data.liveClients,
              Historienfehler: diag.data.collectionError,
            }}
          />
        </Panel>
      )}
      <Panel
        title={t("Java Service Wrapper")}
        description={t(
          "Zeigt einen erkannten Service Wrapper und dessen Steuerungsstatus. Ein JVM-Neustart ist nur bei vorhandener Unterstützung und freigeschalteter Aktion verfügbar.",
        )}
      >
        <KeyValues
          data={{
            Verfügbar: wrapper.data?.available ? "Ja" : "Nein",
            Steuerung: short(wrapper.data?.controlled),
            Version: wrapper.data?.version,
          }}
        />
        {user.permissions.admin &&
          wrapper.data?.available &&
          user.settings.wrapperRestart && (
            <div className="panel-padding">
              <button
                className="button danger"
                onClick={() => setRestart(true)}
              >
                {t("JVM neu starten") + " "}
              </button>
            </div>
          )}
      </Panel>
      {user.permissions.admin && (
        <Panel
          title={t("Systemeigenschaften")}
          description={t(
            "Liest die Java-Systemeigenschaften dieser JVM. Die Tabelle dient zur Diagnose der Laufzeitkonfiguration.",
          )}
          subtitle={t("Werte mit erkennbaren Geheimnisnamen werden maskiert.")}
        >
          <DataTable
            id="system-props"
            rows={Object.entries(system.data?.properties || {}).map(
              ([name, value]) => ({ name, value }),
            )}
            columns={[
              { key: "name", label: t("Eigenschaft") },
              { key: "value", label: t("Wert") },
            ]}
          />
        </Panel>
      )}
      {check && (
        <Modal title={t("Quick Check")} onClose={() => setCheck(null)} wide>
          <DataTable
            id="quick-check"
            rows={check.checks || []}
            columns={[
              { key: "name", label: t("Prüfung") },
              {
                key: "state",
                label: t("Ergebnis"),
                render: (v) => (
                  <Badge
                    tone={
                      v === "OK" ? "green" : v === "ERROR" ? "red" : "orange"
                    }
                  >
                    {v}
                  </Badge>
                ),
              },
              { key: "detail", label: t("Details") },
            ]}
          />
        </Modal>
      )}
      {restart && (
        <Confirm
          title={t("JVM neu starten?")}
          detail={t(
            "Alle Anwendungen dieser JVM werden neu gestartet. Der Neustart erfolgt über den vorhandenen Service Wrapper.",
          )}
          danger
          onClose={() => setRestart(false)}
          onConfirm={async () => {
            await api("/wrapper/restart", { confirmation: "RESTART" });
            notify(t("Neustart wurde angefordert."));
          }}
        />
      )}
    </>
  );
}
export function ClusterView({ history }: { history: Row[] }) {
  const data = useLoad<Row>("/cluster", [], 10000);
  return (
    <>
      <PageTitle
        eyebrow={t("MONITORING / VERBUND")}
        title={t("Cluster & Replikation")}
        description={t(
          "Cluster-Mitglieder und verfügbare Channel- und Sessionstatistiken.",
        )}
        actions={<Refresh onClick={data.refresh} />}
      />
      <ErrorBox error={data.error} />
      {data.data?.status?.hosts?.map((host: Row) => (
        <Panel
          key={host.host}
          title={host.host}
          description={t(
            "Zeigt Cluster-Konfiguration, lokales Mitglied und bekannte Gegenstellen dieses virtuellen Hosts. Ohne konfigurierten Cluster bleiben Mitglieds- und Replikationswerte leer.",
          )}
          actions={
            <Badge tone={host.enabled ? "green" : "neutral"}>
              {host.enabled ? t("Cluster aktiv") : t("Kein Cluster")}
            </Badge>
          }
        >
          <KeyValues
            data={{
              Implementierung: host.className,
              "Lokales Mitglied": host.localMember,
              Mitglieder: host.members?.join("\n"),
            }}
          />
        </Panel>
      ))}
      <Panel
        title={t("Session-Replikation")}
        description={t(
          "Zeigt verfügbare Replikationszähler und Raten je Anwendung. Die Unterstützung hängt vom verwendeten Tomcat-Cluster-Manager ab.",
        )}
      >
        <DataTable
          id="cluster-replication"
          rows={data.data?.replication || []}
          columns={[
            { key: "application", label: t("Anwendung") },
            { key: "sent", label: t("Gesendet") },
            { key: "received", label: t("Empfangen") },
            {
              key: "sentRate",
              label: t("Gesendet/s"),
              render: (v) => formatNumber(v, 2),
            },
            {
              key: "receivedRate",
              label: t("Empfangen/s"),
              render: (v) => formatNumber(v, 2),
            },
          ]}
        />
        {data.data?.replication?.length > 0 && (
          <Chart
            points={history}
            value={(p) => completeTotal(p.clusterReplication, "sentRate")}
            label={t("Replikationen/s")}
          />
        )}
      </Panel>
      <Panel
        title={t("Channel-Datenverkehr")}
        description={t(
          "Zeigt empfangene und gesendete Bytes und Nachrichten der vorhandenen Cluster-Channels.",
        )}
      >
        <DataTable
          id="cluster-channels"
          rows={data.data?.channels || []}
          columns={[
            { key: "name", label: t("Channel") },
            {
              key: "rxReceivedBytes",
              label: t("Empfangen"),
              render: formatBytes,
            },
            { key: "txSentBytes", label: t("Gesendet"), render: formatBytes },
            { key: "rxReceivedMessages", label: t("Nachrichten empfangen") },
            { key: "txSentMessages", label: t("Nachrichten gesendet") },
          ]}
        />
      </Panel>
      <Panel
        title={t("Session-Manager")}
        description={t(
          "Vergleicht aktive, erzeugte und abgelaufene Sessions der Tomcat-Manager. Die Zähler beziehen sich auf die jeweilige Manager-Laufzeit.",
        )}
      >
        <DataTable
          id="cluster-managers"
          rows={data.data?.managers || []}
          columns={[
            { key: "objectName", label: t("Manager") },
            { key: "activeSessions", label: t("Aktive Sessions") },
            { key: "sessionCounter", label: t("Erzeugt") },
            { key: "expiredSessions", label: t("Abgelaufen") },
            { key: "sessionMaxAliveTime", label: t("Max. Lebenszeit (s)") },
          ]}
        />
      </Panel>
    </>
  );
}
export function CertificatesView() {
  const user = useUser(),
    data = useLoad<Row[]>(user.permissions.admin ? "/certificates" : null);
  const [selected, setSelected] = useState<Row | null>(null);
  if (!user.permissions.admin)
    return (
      <Empty
        title={t("Administratorrechte erforderlich")}
        detail={t(
          "Zertifikat- und Truststoreinformationen stehen Administratoren zur Verfügung.",
        )}
      />
    );
  return (
    <>
      <PageTitle
        eyebrow={t("ADMINISTRATION / TLS")}
        title={t("Zertifikate")}
        description={t(
          "System-Truststore und konfigurierte Connector-Key- und Truststores.",
        )}
        actions={<Refresh onClick={data.refresh} />}
      />
      <ErrorBox error={data.error} />
      {data.loading ? (
        <Loading />
      ) : (
        <Panel
          title={t("Zertifikatsübersicht")}
          description={t(
            "Zeigt Zertifikate aus dem System-Truststore und konfigurierten Connector-Stores. Orange markiert einen Ablauf innerhalb von 30 Tagen, Rot bereits abgelaufene Zertifikate. Eine Zeile öffnet die Details.",
          )}
        >
          <DataTable
            id="certificates"
            rows={data.data || []}
            onRow={setSelected}
            columns={[
              { key: "alias", label: t("Alias") },
              { key: "store", label: t("Store / Connector") },
              { key: "subject", label: t("Inhaber") },
              {
                key: "notAfter",
                label: t("Gültig bis"),
                render: (v) =>
                  v ? (
                    <Badge
                      tone={
                        v < Date.now()
                          ? "red"
                          : v < Date.now() + 30 * 86400000
                            ? "orange"
                            : "green"
                      }
                    >
                      {new Date(v).toLocaleDateString(locale())}
                    </Badge>
                  ) : (
                    "—"
                  ),
              },
              { key: "error", label: t("Hinweis") },
            ]}
          />
        </Panel>
      )}
      {selected && (
        <Modal
          title={selected.alias || selected.store}
          onClose={() => setSelected(null)}
          wide
        >
          <KeyValues
            data={{
              ...selected,
              notBefore: formatDate(selected.notBefore),
              notAfter: formatDate(selected.notAfter),
            }}
          />
        </Modal>
      )}
    </>
  );
}
