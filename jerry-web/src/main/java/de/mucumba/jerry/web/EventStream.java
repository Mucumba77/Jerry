package de.mucumba.jerry.web;

import de.mucumba.jerry.core.Json;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import javax.servlet.AsyncContext;
import javax.servlet.AsyncEvent;
import javax.servlet.AsyncListener;
import javax.servlet.ServletOutputStream;
import javax.servlet.WriteListener;

/** Streams monitoring snapshots to one authenticated asynchronous HTTP session. */
final class EventStream implements WriteListener, AsyncListener {
  final String owner;
  private final JerryRuntime runtime;
  private final AsyncContext context;
  private final ServletOutputStream output;
  private byte[] pending;
  private boolean closed;

  EventStream(String owner, JerryRuntime runtime, AsyncContext context) throws IOException {
    this.owner = owner;
    this.runtime = runtime;
    this.context = context;
    context.setTimeout(120000);
    context.addListener(this);
    output = context.getResponse().getOutputStream();
    output.setWriteListener(this);
  }

  synchronized void offer(Map<String, Object> snapshot) {
    if (closed) return;
    try {
      pending =
          ("id: "
                  + snapshot.get("time")
                  + "\nevent: snapshot\ndata: "
                  + Json.MAPPER.writeValueAsString(snapshot)
                  + "\n\n")
              .getBytes(StandardCharsets.UTF_8);
      drain();
    } catch (IOException | IllegalStateException exception) {
      close();
    }
  }

  private void drain() throws IOException {
    if (!closed && pending != null && output.isReady()) {
      byte[] data = pending;
      pending = null;
      output.write(data);
      output.flush();
    }
  }

  @Override
  public synchronized void onWritePossible() throws IOException {
    drain();
  }

  synchronized void close() {
    if (closed) return;
    closed = true;
    pending = null;
    runtime.streams.remove(this);
    try {
      context.complete();
    } catch (IllegalStateException ignored) {
    }
  }

  @Override
  public void onError(Throwable error) {
    close();
  }

  @Override
  public void onComplete(AsyncEvent event) {
    close();
  }

  @Override
  public void onTimeout(AsyncEvent event) {
    close();
  }

  @Override
  public void onError(AsyncEvent event) {
    close();
  }

  @Override
  public void onStartAsync(AsyncEvent event) {}
}
