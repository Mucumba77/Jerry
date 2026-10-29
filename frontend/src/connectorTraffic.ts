type Row = Record<string, any>;

/** Volumes use cumulative counters, never an integration of downsampled rates. */
export function connectorTraffic(points: Row[], objectName: string) {
  let upload = 0,
    download = 0,
    seconds = 0,
    intervals = 0,
    resets = 0,
    missing = 0;
  let uploadPeak: number | null = null,
    downloadPeak: number | null = null;
  let previous: { point: Row; connector: Row } | undefined;
  let from: number | null = null,
    to: number | null = null,
    samples = 0;
  const rates: {
    time: number;
    uploadRate: number | null;
    downloadRate: number | null;
  }[] = [];
  const valid = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  for (const point of [...points].sort((a, b) => a.time - b.time)) {
    const connector = point.connectors?.find(
      (row: Row) => row.objectName === objectName,
    );
    const rate = {
      time: point.time,
      uploadRate: null as number | null,
      downloadRate: null as number | null,
    };
    rates.push(rate);
    if (
      !connector ||
      !valid(connector.bytesReceived) ||
      !valid(connector.bytesSent)
    ) {
      previous = undefined;
      missing++;
      continue;
    }
    samples++;
    from ??= point.time;
    to = point.time;
    if (previous && point.time > previous.point.time) {
      const old = previous.connector;
      const restarted =
        connector.counterEpoch || old.counterEpoch
          ? connector.counterEpoch !== old.counterEpoch
          : (point.processStarted != null &&
              previous.point.processStarted != null &&
              point.processStarted !== previous.point.processStarted) ||
            point.uptime < previous.point.uptime;
      if (
        restarted ||
        connector.bytesReceived < old.bytesReceived ||
        connector.bytesSent < old.bytesSent
      )
        resets++;
      else {
        const elapsed = (point.time - previous.point.time) / 1000;
        const received = connector.bytesReceived - old.bytesReceived,
          sent = connector.bytesSent - old.bytesSent;
        upload += received;
        download += sent;
        seconds += elapsed;
        rate.uploadRate = received / elapsed;
        rate.downloadRate = sent / elapsed;
        uploadPeak = Math.max(uploadPeak ?? 0, rate.uploadRate);
        downloadPeak = Math.max(downloadPeak ?? 0, rate.downloadRate);
        intervals++;
      }
    }
    previous = { point, connector };
  }
  return {
    upload: intervals ? upload : null,
    download: intervals ? download : null,
    uploadAverage: seconds ? upload / seconds : null,
    downloadAverage: seconds ? download / seconds : null,
    uploadPeak,
    downloadPeak,
    seconds,
    intervals,
    samples,
    resets,
    missing,
    from,
    to,
    rates,
  };
}
