import { t, tr } from "./i18n";
import { useEffect, useState } from "react";
import { api, formatDate, formatNumber, Row } from "./api";
import { ErrorBox, Panel, useLoad, useNotify, useUser } from "./components";

const fields: [string, string, number, number][] = [
  ["heapPercent", "Heap-Auslastung (%)", 1, 100],
  ["poolPercent", "Pool-Auslastung (%)", 1, 100],
  ["errorPercent", "HTTP-Fehlerrate (%)", 1, 100],
  ["minRequests", "Mindestens Requests je Messintervall", 1, 100000],
  ["delaySeconds", "Auslöseverzögerung (Sekunden)", 0, 3600],
  ["recoverySeconds", "Rückstellung nach (Sekunden)", 0, 3600],
  ["hysteresisPercent", "Abstand zur Rückstellung (Prozentpunkte)", 0, 100],
];
export function AlertList({ alerts }: { alerts?: Row | null }) {
  const active: Row[] = alerts?.active || [];
  if (!alerts) return <p className="muted">{t("Warnungen werden geladen.")}</p>;
  if (!alerts.settings?.enabled)
    return (
      <p className="muted">{t("Schwellenwertwarnungen sind deaktiviert.")}</p>
    );
  if (!active.length)
    return (
      <p className="muted">
        {t("Keine aktiven Warnungen")}
        {alerts.pending
          ? tr(
              " · {0} Schwellenwerte werden beobachtet",
              formatNumber(alerts.pending),
            )
          : ""}
        .
      </p>
    );
  return (
    <ul className="alert-list">
      {active.map((item, i) => (
        <li key={i}>
          <strong>{t(item.kind)}</strong>
          {item.source && (
            <>
              {" "}
              {t("· Datenquelle") + " "}
              {item.source}
            </>
          )}{" "}
          · {formatNumber(item.value, 1)} {t("% · seit") + " "}
          {formatDate(item.since)}
          {!item.known && t(" · Messwert derzeit nicht verfügbar")}
        </li>
      ))}
    </ul>
  );
}
export function AlertSettings() {
  const data = useLoad<Row>("/alerts"),
    user = useUser(),
    notify = useNotify();
  const [form, setForm] = useState<Row | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data.data?.settings) setForm(data.data.settings);
  }, [data.data]);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const updated = await api<Row>("/alerts", form);
      data.setData(updated);
      notify(t("Warnregeln gespeichert."));
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel
      title={t("Schwellenwertwarnungen")}
      description={t(
        "Überwacht JVM-Heap, bereits beobachtete Connection Pools und die HTTP-Fehlerrate. Werte müssen die Schwelle während der Verzögerung durchgehend erreichen; die Rückstellung nutzt einen Abstand zur Schwelle. Warnungen bleiben lokal in Jerry und versenden keine Nachrichten.",
      )}
    >
      <div className="panel-padding">
        <ErrorBox error={data.error} />
        <AlertList alerts={data.data} />
        <p className="muted">
          {t(
            "Die Fehlerrate wird nur bei ausreichenden Requests im Messintervall bewertet. Fehlende Messwerte löschen keine aktive Warnung. Änderungen beginnen die Bewertung erneut.",
          )}
        </p>
        {form && (
          <form onSubmit={save} className="alert-form">
            <div className="alert-toggles">
              {[
                ["enabled", "Warnungen aktiv"],
                ["heapEnabled", "Heap"],
                ["poolEnabled", "Connection Pools"],
                ["errorEnabled", "HTTP-Fehler"],
              ].map(([key, label]) => (
                <label className="check" key={key}>
                  <input
                    type="checkbox"
                    disabled={!user.permissions.admin}
                    checked={!!form[key]}
                    onChange={(e) =>
                      setForm({ ...form, [key]: e.target.checked })
                    }
                  />
                  {t(label)}
                </label>
              ))}
            </div>
            <div className="alert-fields">
              {fields.map(([key, label, min, max]) => (
                <label key={key}>
                  {t(label)}
                  <input
                    type="number"
                    min={min}
                    max={max}
                    step="1"
                    required
                    disabled={!user.permissions.admin}
                    value={form[key]}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        [key]:
                          e.target.value === "" ? "" : Number(e.target.value),
                      })
                    }
                  />
                </label>
              ))}
            </div>
            {user.permissions.admin && (
              <button className="button primary" type="submit" disabled={busy}>
                {t("Warnregeln speichern")}
              </button>
            )}
          </form>
        )}
      </div>
    </Panel>
  );
}
