import { t } from "./i18n";
import { useState } from "react";
import { Row } from "./api";
import {
  Code,
  DataTable,
  Empty,
  ErrorBox,
  Loading,
  Panel,
  Refresh,
  useLoad,
  useUser,
} from "./components";

export function ApplicationJmx({ id }: { id: string }) {
  const user = useUser();
  return user.permissions.admin ? (
    <JmxBrowser id={id} />
  ) : (
    <Empty
      title={t("Administratorrechte erforderlich")}
      detail={t("JMX-Attribute können Betriebsdaten der Anwendung enthalten.")}
    />
  );
}
function JmxBrowser({ id }: { id: string }) {
  const [bean, setBean] = useState("");
  const data = useLoad<Row>(
    `/applications/${id}/jmx${bean ? `?bean=${encodeURIComponent(bean)}` : ""}`,
  );
  return (
    <>
      <Panel
        title={bean ? t("JMX-Attribute") : t("JMX-Beans dieser Anwendung")}
        description={t(
          "Liest lokal registrierte MBeans auf ausdrücklichen Abruf. Die Liste liest Metadaten; erst die Auswahl einer Bean liest einfache Attribute. Es gibt keine Schreib- oder Aufruffunktion und kein automatisches Polling.",
        )}
        actions={<Refresh onClick={data.refresh} />}
      >
        {bean && (
          <button className="back-link jmx-back" onClick={() => setBean("")}>
            {t("Alle JMX-Beans")}
          </button>
        )}
        <ErrorBox error={data.error} />
        {data.loading ? (
          <Loading />
        ) : bean ? (
          <>
            <p className="panel-description">{data.data?.selected}</p>
            <DataTable
              id="app-jmx-attributes"
              rows={data.data?.attributes || []}
              columns={[
                { key: "name", label: t("Attribut") },
                { key: "type", label: t("Typ") },
                {
                  key: "value",
                  label: t("Wert"),
                  render: (v) => (v == null ? "—" : String(v)),
                },
                { key: "state", label: t("Lesestatus") },
              ]}
            />
          </>
        ) : (
          <DataTable
            id="app-jmx-beans"
            rows={data.data?.beans || []}
            onRow={(row) => setBean(row.id)}
            columns={[
              { key: "name", label: t("ObjectName") },
              { key: "association", label: t("Zuordnung") },
              { key: "attributes", label: t("Attribute") },
              { key: "operations", label: t("Operationen (nur Anzahl)") },
            ]}
          />
        )}
        {data.data?.truncated && (
          <p className="panel-description">
            {t(
              "Ausgabe begrenzt: maximal 200 Beans bzw. 64 Attribute und eine Sekunde Lesebudget.",
            )}
          </p>
        )}
        {data.data?.warnings?.map((warning: string, i: number) => (
          <p className="panel-description" key={i}>
            {warning}
          </p>
        ))}
      </Panel>
      <Panel
        title={t("MBeans zuordnen")}
        description={t(
          "JMX kennt keine allgemeine Zuordnung zu Web-Anwendungen. Jerry erkennt den Anwendungs-Classloader oder passende Host-/Context-Eigenschaften. Bei Spring ModelMBeans mit gemeinsamem Classloader ist häufig eine explizite Regel erforderlich.",
        )}
      >
        <p className="panel-description">
          {t(
            "Die Anwendung muss ihre Beans bereits beim lokalen Platform-MBeanServer registrieren, zum Beispiel über Spring MBeanExporter. Eine leere Liste bedeutet nicht, dass die Anwendung keine Spring-Beans besitzt. Spring-Beans und JMX-MBeans sind unterschiedliche Registrierungen.",
          )}
        </p>
        <p className="panel-description">
          {t(
            "Alternative 1: Context-Parameter im web.xml der überwachten Anwendung (die Domain durch eure eigene ersetzen). Mehrere ObjectName-Muster mit | trennen.",
          )}
        </p>
        <Code
          value={
            "<context-param>\n  <param-name>jerry.jmx.patterns</param-name>\n  <param-value>eure.domain:application=eure-app,*</param-value>\n</context-param>"
          }
        />
        <p className="panel-description">
          {t(
            "Alternative 2: In conf/jerry.properties eintragen; anschließend Jerry neu starten. Regeln nur so weit fassen, dass sie zur ausgewählten Anwendung passen.",
          )}
        </p>
        <Code
          value={`${data.data?.configKey || `monitor.jmx.${id}.patterns`}=eure.domain:application=eure-app,*`}
        />
        <p className="panel-description">
          {t(
            "Passwort-, Token-, Secret-, Credential-, PrivateKey-, ApiKey-, AccessKey-, ConnectionString- und URL-Attribute werden ohne Getter-Aufruf ausgeblendet; Trennzeichen werden bei der Prüfung ignoriert. Komplexe Werte werden ausgelassen. Auch lesende Getter führen Anwendungscode aus; zwei begrenzte Lesearbeiter und ein Zeitlimit begrenzen parallele Abrufe.",
          )}
        </p>
      </Panel>
    </>
  );
}
