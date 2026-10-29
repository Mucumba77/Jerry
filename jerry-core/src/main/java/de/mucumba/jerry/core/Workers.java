package de.mucumba.jerry.core;

import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;

/** Creates named daemon workers for bounded background operations. */
public final class Workers implements ThreadFactory {
  private final String prefix;
  private final AtomicInteger sequence = new AtomicInteger();

  public Workers(String prefix) {
    this.prefix = prefix;
  }

  @Override
  public Thread newThread(Runnable task) {
    Thread thread = new Thread(task, "Jerry-" + prefix + "-" + sequence.incrementAndGet());
    thread.setDaemon(true);
    thread.setContextClassLoader(ClassLoader.getSystemClassLoader());
    return thread;
  }
}
