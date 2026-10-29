import { t, tr } from "./i18n";
import { useEffect, useState } from "react";
import { ApplicationMonitoring, modeLabel } from "./ApplicationMonitoring";
import { ApplicationJmx } from "./ApplicationJmx";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Code2,
  Database,
  Download,
  FileCode2,
  FolderOpen,
  Layers,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Search,
  Square,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import {
  api,
  formatBytes,
  formatDate,
  formatNumber,
  route,
  Row,
  short,
  upload,
  url,
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
  useUser,
} from "./components";

export function ApplicationsView({ appId }: { appId?: string }) {
  const list = useLoad<Row[]>("/applications", [], 10000),
    user = useUser(),
    notify = useNotify();
  const [deploy, setDeploy] = useState(false),
    [action, setAction] = useState<{ app: Row; kind: string } | null>(null);
  if (appId)
    return (
      <ApplicationDetail
        id={appId}
        app={list.data?.find((a) => a.id === appId)}
        refreshList={list.refresh}
      />
    );
  return (
    <>
      <PageTitle
        eyebrow={t("VERWALTUNG / CONTEXTS")}
        title={t("Anwendungen")}
        description={t(
          "Alle virtuellen Hosts, Contexts und parallelen Deployment-Versionen.",
        )}
        actions={
          <>
            <Refresh onClick={list.refresh} />
            {user.permissions.admin && (
              <button
                className="button primary"
                onClick={() => setDeploy(true)}
              >
                <Plus size={16} />
                {t("WAR bereitstellen") + " "}
              </button>
            )}
          </>
        }
      />
      <ErrorBox error={list.error} />
      <Panel
        title={t("Bereitgestellte Anwendungen")}
        description={t(
          "Eine Anwendung öffnen, um Context, Monitoring, Sessions und JSPs zu untersuchen. Start, Stop und Reload stehen je nach Rolle direkt in der Zeile bereit; Administratoren können WAR-Dateien bereitstellen oder Anwendungen entfernen.",
        )}
        subtitle={tr("{0} Contexts in dieser Instanz", list.data?.length ?? 0)}
      >
        <DataTable
          id="applications"
          rows={list.data || []}
          onRow={
            user.permissions.operator
              ? (row) => route("applications", { app: row.id })
              : undefined
          }
          columns={[
            {
              key: "path",
              label: t("Anwendung"),
              render: (v, r) => (
                <span className="app-cell">
                  <span className="app-icon small">
                    <Layers size={15} />
                  </span>
                  <strong>{v || "ROOT"}</strong>
                  {r.self && <span className="tag">{t("Jerry")}</span>}
                </span>
              ),
            },
            { key: "host", label: t("Host") },
            { key: "version", label: t("Version") },
            {
              key: "monitoring",
              label: t("Monitoring"),
              render: (v) => (
                <Badge
                  tone={
                    v?.mode === "DIAGNOSTIC"
                      ? "orange"
                      : v?.mode === "EXTENDED"
                        ? "blue"
                        : "neutral"
                  }
                >
                  {modeLabel(v?.mode)}
                </Badge>
              ),
            },
            {
              key: "state",
              label: t("Status"),
              render: (_, r) => (
                <Badge tone={r.running ? "green" : "red"}>{r.state}</Badge>
              ),
            },
            {
              key: "sessions",
              label: t("Sessions"),
              render: (v) => formatNumber(v),
            },
            {
              key: "requests",
              label: t("Requests"),
              render: (v) => formatNumber(v),
            },
            {
              key: "errors",
              label: t("Fehler"),
              render: (v) => formatNumber(v),
            },
            {
              key: "actions",
              label: t("Aktionen"),
              render: (_, row) =>
                user.permissions.operator && !row.self ? (
                  <div
                    className="row-actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      className="icon-button"
                      title={row.running ? t("Stoppen") : t("Starten")}
                      onClick={() =>
                        setAction({
                          app: row,
                          kind: row.running ? "stop" : "start",
                        })
                      }
                    >
                      {row.running ? <Square size={15} /> : <Play size={15} />}
                    </button>
                    <button
                      className="icon-button"
                      title={t("Neu laden")}
                      onClick={() => setAction({ app: row, kind: "reload" })}
                    >
                      <RefreshCw size={15} />
                    </button>
                    {user.permissions.admin && (
                      <button
                        className="icon-button danger-text"
                        title={t("Undeployen")}
                        onClick={() =>
                          setAction({ app: row, kind: "undeploy" })
                        }
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                ) : null,
            },
          ]}
        />
      </Panel>
      {deploy && (
        <DeployModal onClose={() => setDeploy(false)} onDone={list.refresh} />
      )}{" "}
      {action && (
        <Confirm
          title={
            {
              start: "Anwendung starten?",
              stop: "Anwendung stoppen?",
              reload: "Anwendung neu laden?",
              undeploy: "Anwendung undeployen?",
            }[action.kind] || action.kind
          }
          detail={`${action.app.host} · ${action.app.path || "ROOT"}${action.kind === "undeploy" ? t(" – WAR, entpackte Anwendung und Context-Deskriptor werden entfernt.") : ""}`}
          danger={action.kind === "undeploy" || action.kind === "stop"}
          onClose={() => setAction(null)}
          onConfirm={async () => {
            await api("/applications/" + action.app.id, {
              action: action.kind,
              confirmation: action.app.id,
            });
            notify(t("Aktion abgeschlossen."));
            await list.refresh();
          }}
        />
      )}
    </>
  );
}
function ApplicationDetail({
  id,
  app,
  refreshList,
}: {
  id: string;
  app?: Row;
  refreshList: () => Promise<void>;
}) {
  const [tab, setTab] = useState("overview"),
    [remove, setRemove] = useState<string | null>(null);
  const user = useUser(),
    notify = useNotify(),
    data = useLoad<Row>("/applications/" + id);
  if (!user.permissions.operator)
    return <Empty title={t("Operatorrechte erforderlich")} />;
  return (
    <>
      <button className="back-link" onClick={() => route("applications")}>
        <ArrowLeft size={15} />
        {t("Alle Anwendungen") + " "}
      </button>
      <PageTitle
        eyebrow={app?.host || "ANWENDUNG"}
        title={app?.path || app?.name || "ROOT"}
        description={app?.displayName || "Context-Details und Verwaltung"}
        actions={
          <Refresh
            onClick={async () => {
              await data.refresh();
              await refreshList();
            }}
          />
        }
      />
      <ErrorBox error={data.error} />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          "overview",
          "monitoring",
          "jmx",
          "servlets",
          "filters",
          "attributes",
          "sessions",
          "jsps",
          "configuration",
        ].map((v, i) => [
          v,
          [
            "Übersicht",
            "Monitoring",
            "JMX",
            "Servlets",
            "Filter",
            "Attribute",
            "Sessions",
            "JSPs",
            "Konfiguration",
          ][i],
        ])}
      />
      {data.loading ? (
        <Loading />
      ) : tab === "overview" ? (
        <div className="two-columns">
          <Panel
            title={t("Context")}
            description={t(
              "Zeigt Deployment-Pfad, Status und die aktuellen Request- und Sessionzähler dieser Anwendung.",
            )}
          >
            <KeyValues
              data={{
                Host: app?.host,
                Pfad: app?.path || "/",
                Version: app?.version,
                Status: app?.state,
                DocBase: app?.docBase,
                Sessions: app?.sessions,
                Requests: app?.requests,
                Fehler: app?.errors,
              }}
            />
          </Panel>
          <Panel
            title={t("Initialisierungsparameter")}
            description={t(
              "Liest die im ServletContext bereitgestellten Startparameter der Anwendung.",
            )}
          >
            <DataTable
              id="init-params"
              rows={data.data?.parameters || []}
              columns={[
                { key: "name", label: t("Name") },
                { key: "value", label: t("Wert") },
              ]}
            />
          </Panel>
        </div>
      ) : tab === "monitoring" ? (
        <ApplicationMonitoring id={id} onChange={refreshList} />
      ) : tab === "jmx" ? (
        <ApplicationJmx id={id} />
      ) : tab === "servlets" ? (
        <Panel
          title={t("Servlets & Mappings")}
          description={t(
            "Zeigt die registrierten Servlets, ihre URL-Zuordnungen und Tomcat-Zähler für Aufrufe, Fehler und Verarbeitungszeit.",
          )}
        >
          <DataTable
            id="servlets"
            rows={data.data?.servlets || []}
            columns={[
              { key: "name", label: t("Servlet") },
              { key: "className", label: t("Klasse") },
              {
                key: "mappings",
                label: t("Mappings"),
                render: (v) => v?.join(", "),
              },
              { key: "requests", label: t("Requests") },
              { key: "errors", label: t("Fehler") },
              { key: "processingTime", label: t("Verarbeitung (ms)") },
              { key: "initParameters", label: t("Parameter"), hidden: true },
            ]}
          />
        </Panel>
      ) : tab === "filters" ? (
        <Panel
          title={t("Filter & Mappings")}
          description={t(
            "Zeigt registrierte Servlet-Filter und die URLs, Servlets und Dispatcher-Typen, für die sie gelten.",
          )}
        >
          <DataTable
            id="filters"
            rows={data.data?.filters || []}
            columns={[
              { key: "name", label: t("Filter") },
              { key: "className", label: t("Klasse") },
              {
                key: "mappings",
                label: t("Mappings"),
                render: (v) =>
                  v
                    ?.map(
                      (m: Row) =>
                        [...(m.urls || []), ...(m.servlets || [])].join(", ") +
                        " [" +
                        (m.dispatchers || []).join(", ") +
                        "]",
                    )
                    .join(" · "),
              },
            ]}
          />
        </Panel>
      ) : tab === "attributes" ? (
        <Panel
          title={t("Context-Attribute")}
          description={t(
            "Liest Attribute des ServletContext mit Typ und darstellbarem Wert. Administratoren können freigegebene Anwendungsattribute über das Papierkorbsymbol entfernen.",
          )}
        >
          <DataTable
            id="context-attributes"
            rows={data.data?.attributes || []}
            columns={[
              { key: "name", label: t("Name") },
              { key: "type", label: t("Typ") },
              { key: "value", label: t("Wert") },
              {
                key: "actions",
                label: "",
                render: (_, r) =>
                  user.permissions.admin &&
                  !r.name.startsWith("org.apache.") &&
                  !r.name.startsWith("javax.") ? (
                    <button
                      className="icon-button danger-text"
                      aria-label={t("Attribut entfernen")}
                      onClick={() => setRemove(r.name)}
                    >
                      <Trash2 size={15} />
                    </button>
                  ) : null,
              },
            ]}
          />
        </Panel>
      ) : tab === "sessions" ? (
        <Sessions app={id} />
      ) : tab === "jsps" ? (
        <Jsps app={id} />
      ) : (
        <div className="two-columns">
          <Panel
            title={t("web.xml")}
            description={t(
              "Zeigt den Deployment-Deskriptor der Anwendung, sofern eine explizite web.xml vorhanden ist. Die Anzeige erfordert Administratorrechte.",
            )}
          >
            {user.permissions.admin ? (
              <Code
                value={
                  data.data?.webXml || "Kein expliziter Deployment-Deskriptor."
                }
              />
            ) : (
              <Empty title={t("Administratorrechte erforderlich")} />
            )}
          </Panel>
          <Panel
            title={t("context.xml")}
            description={t(
              "Zeigt den verfügbaren externen Tomcat-Context-Deskriptor. Die Anzeige erfordert Administratorrechte.",
            )}
          >
            {user.permissions.admin ? (
              <Code
                value={
                  data.data?.contextXml || "Kein externer Context-Deskriptor."
                }
              />
            ) : (
              <Empty title={t("Administratorrechte erforderlich")} />
            )}
          </Panel>
        </div>
      )}
      {remove && (
        <Confirm
          title={t("Context-Attribut entfernen?")}
          detail={remove}
          danger
          onClose={() => setRemove(null)}
          onConfirm={async () => {
            await api("/applications/" + id + "/attributes", {
              name: remove,
              action: "remove",
            });
            notify(t("Attribut entfernt."));
            await data.refresh();
          }}
        />
      )}
    </>
  );
}
function Sessions({ app }: { app: string }) {
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [estimate, setEstimate] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [detail, setDetail] = useState<Row | null>(null),
    [confirm, setConfirm] = useState<{
      ids: string[];
      attribute?: string;
    } | null>(null);
  const user = useUser(),
    notify = useNotify(),
    data = useLoad<Row[]>(
      "/applications/" +
        app +
        "/sessions?" +
        new URLSearchParams({ q: search, estimate: String(estimate) }),
    );
  return (
    <>
      <ErrorBox error={data.error} />
      <Panel
        title={t("HTTP-Sessions")}
        description={t(
          "Sessions nach ID oder Attributen durchsuchen und für Details öffnen. Ausgewählte Sessions lassen sich beenden; Größenwerte werden nur auf ausdrücklichen Wunsch geschätzt.",
        )}
        subtitle={t(
          "Größenwerte sind Schätzungen einfacher Werte; komplexe Objekte werden nicht serialisiert.",
        )}
        actions={
          <>
            <Refresh onClick={data.refresh} />
            <button
              className="button danger"
              disabled={!selected.length}
              onClick={() => setConfirm({ ids: selected })}
            >
              <Trash2 size={14} />
              {selected.length || ""} {t("Sessions beenden") + " "}
            </button>
          </>
        }
      >
        <div className="panel-padding toolbar">
          <label className="search-input">
            <Search size={16} />
            <input
              placeholder={t("ID, Attribut oder Wert durchsuchen")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setSearch(query);
              }}
            />
          </label>
          <button className="button" onClick={() => setSearch(query)}>
            {t("Suchen") + " "}
          </button>
          {user.permissions.admin && (
            <label className="check">
              <input
                type="checkbox"
                checked={estimate}
                onChange={(e) => setEstimate(e.target.checked)}
              />
              {t("Größe schätzen") + " "}
            </label>
          )}
        </div>
        <DataTable
          id="sessions"
          rows={data.data || []}
          onRow={async (row) => {
            try {
              const result = await api<Row[]>(
                "/applications/" +
                  app +
                  "/sessions?session=" +
                  encodeURIComponent(row.id) +
                  "&estimate=" +
                  estimate,
              );
              setDetail(result[0] || row);
            } catch (e) {
              notify((e as Error).message, "error");
            }
          }}
          columns={[
            {
              key: "select",
              label: t("Auswahl"),
              render: (_, r) => (
                <input
                  type="checkbox"
                  checked={selected.includes(r.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...selected, r.id]
                        : selected.filter((id) => id !== r.id),
                    )
                  }
                  aria-label={"Session " + r.id + " auswählen"}
                />
              ),
            },
            { key: "id", label: t("Session-ID") },
            { key: "created", label: t("Erstellt"), render: formatDate },
            {
              key: "lastAccessed",
              label: t("Letzter Zugriff"),
              render: formatDate,
            },
            { key: "lastIp", label: t("Letzte IP") },
            { key: "maxInactiveSeconds", label: t("Timeout (s)") },
            {
              key: "estimatedBytes",
              label: t("Geschätzte Größe"),
              render: formatBytes,
            },
          ]}
        />
      </Panel>
      {detail && (
        <Modal
          title={t("Session-Attribute")}
          onClose={() => setDetail(null)}
          wide
        >
          <p className="modal-description">
            {t(
              "Zeigt Lebenszyklus und Attribute dieser HTTP-Session. Das Entfernen eines Attributs ändert unmittelbar den Zustand der Anwendungssitzung.",
            )}
          </p>
          <KeyValues
            data={{
              ID: detail.id,
              Erstellt: formatDate(detail.created),
              "Letzter Zugriff": formatDate(detail.lastAccessed),
            }}
          />
          {detail.attributesTruncated && (
            <ErrorBox error="Attributdarstellung wurde am Größenlimit begrenzt." />
          )}
          <DataTable
            id="session-attributes"
            rows={detail.attributes || []}
            columns={[
              { key: "name", label: t("Attribut") },
              { key: "type", label: t("Typ") },
              { key: "value", label: t("Wert") },
              {
                key: "estimatedBytes",
                label: t("Schätzung"),
                render: formatBytes,
              },
              {
                key: "remove",
                label: "",
                render: (_, r) => (
                  <button
                    className="icon-button danger-text"
                    onClick={() =>
                      setConfirm({ ids: [detail.id], attribute: r.name })
                    }
                    aria-label={t("Attribut entfernen")}
                  >
                    <Trash2 size={15} />
                  </button>
                ),
              },
            ]}
          />
          <div className="modal-actions">
            <button
              className="button danger"
              onClick={() => setConfirm({ ids: [detail.id] })}
            >
              {t("Session beenden") + " "}
            </button>
          </div>
        </Modal>
      )}
      {confirm && (
        <Confirm
          title={
            confirm.attribute
              ? t("Session-Attribut entfernen?")
              : t("Sessions beenden?")
          }
          detail={
            confirm.attribute ||
            tr(
              "{0} Sessions werden ungültig. Betroffene Benutzer müssen sich gegebenenfalls neu anmelden.",
              confirm.ids.length,
            )
          }
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await api("/applications/" + app + "/sessions", {
              action: confirm.attribute ? "remove-attribute" : "expire",
              ids: confirm.ids,
              attribute: confirm.attribute,
            });
            setSelected([]);
            setDetail(null);
            notify(t("Aktion abgeschlossen."));
            await data.refresh();
          }}
        />
      )}
    </>
  );
}
function Jsps({ app }: { app: string }) {
  const data = useLoad<string[]>("/applications/" + app + "/jsps"),
    notify = useNotify(),
    user = useUser();
  const [selected, setSelected] = useState<string[]>([]),
    [source, setSource] = useState<Row | null>(null),
    [compiled, setCompiled] = useState<Row[] | null>(null),
    [busy, setBusy] = useState(false),
    [discard, setDiscard] = useState(false);
  async function compile(all: boolean) {
    setBusy(true);
    try {
      setCompiled(
        await api("/applications/" + app + "/jsps", {
          action: "compile",
          paths: all ? [] : selected,
        }),
      );
      notify(t("JSP-Kompilierung abgeschlossen."));
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ErrorBox error={data.error} />
      <Panel
        title={t("JSP-Dateien")}
        description={t(
          "Eine JSP öffnen, um Quelle und generierten Servlet-Code zu lesen. Ausgewählte oder alle JSPs lassen sich vorkompilieren; das Verwerfen von Kompilaten startet die Anwendung neu.",
        )}
        actions={
          <>
            <button
              className="button"
              disabled={busy || !selected.length}
              onClick={() => compile(false)}
            >
              <Code2 size={14} />
              {t("Auswahl kompilieren") + " "}
            </button>
            <button
              className="button primary"
              disabled={busy || !data.data?.length}
              onClick={() => compile(true)}
            >
              {busy ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Play size={14} />
              )}
              {t("Alle kompilieren") + " "}
            </button>
            {user.permissions.admin && (
              <button
                className="button"
                disabled={busy}
                onClick={() => setDiscard(true)}
              >
                {t("Kompilate verwerfen") + " "}
              </button>
            )}
          </>
        }
      >
        <DataTable
          id="jsps"
          rows={(data.data || []).map((path) => ({ path }))}
          onRow={async (row) => {
            try {
              setSource(
                await api(
                  "/applications/" +
                    app +
                    "/jsps?path=" +
                    encodeURIComponent(row.path),
                ),
              );
            } catch (e) {
              notify((e as Error).message, "error");
            }
          }}
          columns={[
            {
              key: "selection",
              label: t("Auswahl"),
              render: (_, r) => (
                <input
                  type="checkbox"
                  checked={selected.includes(r.path)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...selected, r.path]
                        : selected.filter((p) => p !== r.path),
                    )
                  }
                  aria-label={r.path + " auswählen"}
                />
              ),
            },
            { key: "path", label: t("Pfad") },
          ]}
        />
      </Panel>
      {source && (
        <Modal title={source.path} onClose={() => setSource(null)} wide>
          <div className="panel-padding">
            <h3>{t("JSP-Quelle")}</h3>
            <p className="inline-description">
              {t("Originaler JSP-Quelltext dieser Anwendung.")}
            </p>
          </div>
          <Code value={source.source} />
          <div className="panel-padding">
            <h3>{t("Generierter Servlet-Code")}</h3>
            <p className="inline-description">
              {t(
                "Vom JSP-Compiler erzeugter Java-Code, sofern bereits vorhanden.",
              )}
            </p>
          </div>
          <Code
            value={
              source.generated || "Noch kein generierter Quelltext vorhanden."
            }
          />
        </Modal>
      )}
      {compiled && (
        <Modal
          title={t("Kompilierungsergebnis")}
          onClose={() => setCompiled(null)}
          wide
        >
          <DataTable
            id="jsp-compiled"
            rows={compiled}
            columns={[
              { key: "path", label: t("JSP") },
              {
                key: "state",
                label: t("Ergebnis"),
                render: (v) => (
                  <Badge tone={v === "COMPILED" ? "green" : "red"}>{v}</Badge>
                ),
              },
              { key: "durationMs", label: t("Dauer (ms)") },
              { key: "error", label: t("Fehler") },
            ]}
          />
        </Modal>
      )}
      {discard && (
        <Confirm
          title={t("JSP-Kompilate verwerfen?")}
          detail={t(
            "Die Anwendung wird gestoppt, ihr Tomcat-Work-Verzeichnis bereinigt und anschließend wieder gestartet.",
          )}
          danger
          onClose={() => setDiscard(false)}
          onConfirm={async () => {
            await api("/applications/" + app + "/jsps", { action: "discard" });
            notify(t("Kompilate verworfen und Anwendung gestartet."));
          }}
        />
      )}
    </>
  );
}
export function DeployModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const hosts = useLoad<Row[]>("/hosts");
  const [file, setFile] = useState<File | null>(null),
    [path, setPath] = useState(""),
    [version, setVersion] = useState(""),
    [host, setHost] = useState(""),
    [precompile, setPrecompile] = useState(false),
    [mode, setMode] = useState("war"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const notify = useNotify();
  return (
    <Modal title={t("Anwendung bereitstellen")} onClose={onClose}>
      <p className="modal-description">
        {t(
          "Eine WAR hochladen oder einen vorhandenen Context-Deskriptor bereitstellen. Host, Context-Pfad und optionale Version bestimmen, unter welcher Adresse die Anwendung läuft.",
        )}
      </p>
      <div className="panel-padding">
        <Tabs
          value={mode}
          onChange={setMode}
          items={[
            ["war", "WAR hochladen"],
            ["descriptor", "Vorhandener Deskriptor"],
          ]}
        />
      </div>
      {mode === "descriptor" ? (
        <DescriptorDeploy onClose={onClose} onDone={onDone} />
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!file) return;
            setBusy(true);
            setError("");
            try {
              await upload(
                "/deploy?" +
                  new URLSearchParams({
                    host: host || hosts.data?.[0]?.name || "localhost",
                    path,
                    version,
                    compileJsps: String(precompile),
                  }),
                file,
              );
              notify(t("WAR wurde bereitgestellt."));
              await onDone();
              onClose();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-grid">
            <label>
              {t("Virtueller Host") + " "}
              <select
                value={host || hosts.data?.[0]?.name || ""}
                onChange={(e) => setHost(e.target.value)}
              >
                {hosts.data?.map((h) => (
                  <option key={h.name}>{h.name}</option>
                ))}
              </select>
            </label>
            <label>
              {t("Context-Pfad") + " "}
              <input
                placeholder="/meine-anwendung (leer für ROOT)"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                pattern="(/[A-Za-z0-9_-]+)*"
              />
            </label>
            <label>
              {t("Deployment-Version") + " "}
              <input
                placeholder={t("Optional, z. B. 001")}
                value={version}
                onChange={(e) => setVersion(e.target.value)}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={precompile}
                onChange={(e) => setPrecompile(e.target.checked)}
              />
              {t("JSPs nach dem Deployment vorkompilieren") + " "}
            </label>
            <label className="file-picker">
              <Upload size={26} />
              <strong>{file?.name || "WAR-Datei auswählen"}</strong>
              <span>
                {file
                  ? formatBytes(file.size)
                  : t("Die Anwendung wird nach dem Upload bereitgestellt.")}
              </span>
              <input
                type="file"
                accept=".war"
                required
                onChange={(e) => {
                  const next = e.target.files?.[0] || null;
                  setFile(next);
                  if (next && !path)
                    setPath(
                      "/" +
                        next.name
                          .replace(/\.war$/i, "")
                          .replace(/[^A-Za-z0-9_-]/g, "-"),
                    );
                }}
              />
            </label>
          </div>
          <ErrorBox error={error} />
          <div className="modal-actions">
            <button type="button" className="button" onClick={onClose}>
              {t("Abbrechen") + " "}
            </button>
            <button className="button primary" disabled={busy || !file}>
              {busy ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Upload size={15} />
              )}
              {t("Bereitstellen") + " "}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
export function DataSourcesView({ history }: { history: Row[] }) {
  const data = useLoad<Row[]>("/datasources?metrics=true", [], 5000),
    user = useUser(),
    notify = useNotify();
  const [selected, setSelected] = useState<Row | null>(null),
    [busy, setBusy] = useState(""),
    [reset, setReset] = useState<Row | null>(null),
    [group, setGroup] = useState(false);
  async function action(row: Row, kind: string) {
    setBusy(row.id);
    try {
      await api("/datasources/" + encodeURIComponent(row.id), { action: kind });
      notify(
        kind === "test"
          ? "Verbindung erfolgreich geprüft."
          : "Pool zurückgesetzt.",
      );
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy("");
      void data.refresh();
    }
  }
  const rows = data.data || [];
  const selectedRow = rows.find((row) => row.id === selected?.id) || selected;
  const pool = selectedRow?.pool;
  return (
    <>
      <PageTitle
        eyebrow={t("DATENBANKEN / RESSOURCEN")}
        title={t("Datenquellen")}
        description={t(
          "Anwendungsbezogene und globale JNDI-Ressourcen sowie konfigurierte JDBC-Verbindungen.",
        )}
        actions={<Refresh onClick={data.refresh} />}
      />
      <ErrorBox error={data.error} />
      <Panel
        title={t("Verfügbare Datenquellen")}
        description={t(
          "Zeigt Belegt, Frei und Maximal je unterstütztem Connection Pool. Eine Zeile öffnet die Details; „Testen“ prüft die Verbindung, „SQL öffnen“ startet den SQL-Arbeitsplatz. Mehrere ResourceLinks können denselben Pool abbilden.",
        )}
        subtitle={t(
          "Poolwerte werden alle 5 Sekunden aktualisiert. Frei sind bereits geöffnete, unbenutzte Connections.",
        )}
        actions={
          <label className="check">
            <input
              type="checkbox"
              checked={group}
              onChange={(e) => setGroup(e.target.checked)}
            />
            {t("Nach JDBC-URL gruppieren") + " "}
          </label>
        }
      >
        <DataTable
          id="datasources"
          rows={
            group
              ? [...rows].sort((a, b) =>
                  String(a.url).localeCompare(String(b.url)),
                )
              : rows
          }
          onRow={(row) => setSelected(row)}
          columns={[
            {
              key: "name",
              label: t("Datenquelle"),
              render: (v) => (
                <span className="app-cell">
                  <Database size={17} />
                  <strong>{v}</strong>
                </span>
              ),
            },
            { key: "application", label: t("Anwendung") },
            {
              key: "pool",
              label: t("Connection Pool"),
              render: (_, row) => (
                <PoolUsage pool={row.pool} error={row.poolError} />
              ),
            },
            {
              key: "url",
              label: t("JDBC-URL"),
              render: (value) => (
                <span className="jdbc-url" title={value || undefined}>
                  {value || "—"}
                </span>
              ),
            },
            { key: "type", label: t("Typ"), hidden: true },
            {
              key: "readOnlyEnforced",
              label: t("DB-Leserechte"),
              render: (v) =>
                v ? <Badge tone="green">{t("Erzwungen")}</Badge> : "—",
            },
            {
              key: "actions",
              label: t("Aktionen"),
              render: (_, row) => (
                <div
                  className="row-actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  {user.permissions.sql && (
                    <>
                      <button
                        className="button small"
                        disabled={busy === row.id}
                        onClick={() => action(row, "test")}
                      >
                        {t("Testen") + " "}
                      </button>
                      <button
                        className="button small primary"
                        onClick={() => route("sql", { source: row.id })}
                      >
                        {t("SQL öffnen") + " "}
                        <ArrowRight size={13} />
                      </button>
                    </>
                  )}
                </div>
              ),
            },
          ]}
        />
      </Panel>
      {selected && (
        <Modal wide title={selected.name} onClose={() => setSelected(null)}>
          <p className="modal-description">
            {t(
              "Die Poolanzeige zeigt ausgeliehene und sofort nutzbare freie Verbindungen. „Wartend“ zählt auf eine Verbindung wartende Anfragen; ein Pool-Reset kann laufende Anwendungen betreffen.",
            )}
          </p>
          <div className="pool-detail">
            <PoolUsage pool={pool} error={selectedRow?.poolError} detail />
          </div>
          <KeyValues
            data={{
              Anwendung: selected.application,
              URL: selected.url,
              Implementierung: pool?.className,
              Wartend: pool?.waiting,
            }}
          />
          <div className="pool-history">
            <h3>{t("Verlauf des Connection Pools")}</h3>
            <p className="muted">
              {t(
                "Belegte und freie Verbindungen sowie die konfigurierte Obergrenze. Die Aufzeichnung beginnt, sobald Jerry den Pool gesehen hat; fehlende Werte erscheinen als Lücken. Der Collector liest vorhandene Poolwerte und öffnet keine Verbindungen.",
              )}
            </p>
            <div className="two-columns">
              {[
                ["active", "Belegt"],
                ["idle", "Frei"],
                ["max", "Maximum"],
              ].map(([key, label]) => (
                <div key={key}>
                  <h4>{label}</h4>
                  <Chart
                    points={history}
                    label={`${selected.name} · ${label}`}
                    height={170}
                    value={(p) =>
                      p.poolMetrics?.find(
                        (item: Row) => item.id === selected.id,
                      )?.[key]
                    }
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="modal-actions">
            {user.permissions.admin && (
              <button
                className="button danger"
                onClick={() => setReset(selected)}
              >
                {t("Pool zurücksetzen") + " "}
              </button>
            )}
            {user.permissions.sql && (
              <button
                className="button primary"
                onClick={() => {
                  route("sql", { source: selected.id });
                  setSelected(null);
                }}
              >
                {t("SQL-Arbeitsplatz öffnen") + " "}
              </button>
            )}
          </div>
        </Modal>
      )}
      {reset && (
        <Confirm
          title={t("Datenbankpool zurücksetzen?")}
          detail={t(
            "Aktive Verbindungen und Anwendungen können betroffen sein. Die genaue Funktion hängt vom Poolanbieter ab.",
          )}
          danger
          onClose={() => setReset(null)}
          onConfirm={async () => {
            await action(reset, "reset");
          }}
        />
      )}
    </>
  );
}

function PoolUsage({
  pool,
  error,
  detail = false,
}: {
  pool?: Row;
  error?: string;
  detail?: boolean;
}) {
  const value = (key: string) => {
    const raw = pool?.[key];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  };
  const active = value("active"),
    idle = value("idle"),
    max = value("max");
  const knownActive = active !== null && active >= 0;
  const knownIdle = idle !== null && idle >= 0;
  const bounded = max !== null && max > 0;
  const available = knownActive || knownIdle || max !== null;
  const usage =
    bounded && knownActive ? Math.min(100, (active! / max!) * 100) : null;
  const idleWidth =
    bounded && knownIdle
      ? Math.min(100 - (usage || 0), (idle! / max!) * 100)
      : 0;
  const maximum =
    max !== null && max < 0 ? "Unbegrenzt" : bounded ? formatNumber(max) : "—";
  const tone =
    usage !== null && usage >= 90
      ? "critical"
      : usage !== null && usage >= 75
        ? "warning"
        : "normal";
  const summary = `${knownActive ? formatNumber(active) : "Nicht verfügbar"} belegte, ${knownIdle ? formatNumber(idle) : "Nicht verfügbar"} freie Connections. Maximum: ${maximum}.`;
  return (
    <div className={`pool-usage ${detail ? "pool-usage-detail" : ""}`}>
      {available ? (
        <>
          <div className="pool-usage-heading">
            <span>{t("Pool-Auslastung")}</span>
            <strong>{usage === null ? "—" : `${Math.round(usage)} %`}</strong>
          </div>
          <div
            className={`pool-capacity ${tone}`}
            role="img"
            aria-label={summary}
            title={
              bounded
                ? t(
                    "Belegt + frei; der übrige Platz ist noch nicht geöffnete Pool-Kapazität.",
                  )
                : t("Der Anbieter stellt keine feste Kapazitätsgrenze bereit.")
            }
          >
            {usage !== null && (
              <span className="pool-occupied" style={{ width: `${usage}%` }} />
            )}
            {bounded && knownActive && knownIdle && (
              <span className="pool-idle" style={{ width: `${idleWidth}%` }} />
            )}
          </div>
          <dl className="pool-counts">
            <div>
              <dt>
                <i className={`pool-dot pool-occupied ${tone}`} />
                {t("Belegt")}
              </dt>
              <dd>{knownActive ? formatNumber(active) : "—"}</dd>
            </div>
            <div>
              <dt>
                <i className="pool-dot pool-idle" />
                {t("Frei")}
              </dt>
              <dd>{knownIdle ? formatNumber(idle) : "—"}</dd>
            </div>
            <div>
              <dt>{t("Maximal")}</dt>
              <dd>{maximum}</dd>
            </div>
          </dl>
          {detail && (
            <p className="muted">
              {t(
                "Aktualisierung alle 5 Sekunden. Freie Connections sind bereits geöffnet und sofort nutzbar. Nicht gefüllte Kapazität ist noch nicht geöffnet.",
              )}
            </p>
          )}
        </>
      ) : (
        <span className="pool-unavailable">
          {error || "Keine Poolmetriken verfügbar"}
          {detail && (
            <small>
              {t(
                "Direkte JDBC-Verbindungen und nicht unterstützte Anbieter liefern keine Poolzähler.",
              )}
            </small>
          )}
        </span>
      )}
    </div>
  );
}

function DescriptorDeploy({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const data = useLoad<Row[]>("/deployments"),
    notify = useNotify();
  return (
    <>
      <ErrorBox error={data.error} />
      <DataTable
        id="deployment-descriptors"
        rows={data.data || []}
        columns={[
          { key: "host", label: t("Host") },
          { key: "filename", label: t("Deskriptor") },
          {
            key: "deployed",
            label: t("Status"),
            render: (v) => (v ? t("Bereitgestellt") : t("Verfügbar")),
          },
          {
            key: "actions",
            label: "",
            render: (_, row) => (
              <button
                className="button small primary"
                disabled={row.deployed}
                onClick={async () => {
                  try {
                    await api("/deployments", {
                      host: row.host,
                      filename: row.filename,
                    });
                    notify(t("Context bereitgestellt."));
                    await onDone();
                    onClose();
                  } catch (e) {
                    notify((e as Error).message, "error");
                  }
                }}
              >
                {t("Bereitstellen") + " "}
              </button>
            ),
          },
        ]}
      />
      <p className="modal-description">
        {t(
          "Vorhandene Context-XML-Dateien im Tomcat-Konfigurationsverzeichnis des jeweiligen Hosts.",
        ) + " "}
      </p>
    </>
  );
}
