package de.mucumba.jerry.web;

import javax.servlet.http.HttpSessionEvent;
import javax.servlet.http.HttpSessionListener;

/** Releases per-user resources when a servlet session ends. */
public final class SessionLifecycle implements HttpSessionListener {
  @Override
  public void sessionCreated(HttpSessionEvent event) {}

  @Override
  public void sessionDestroyed(HttpSessionEvent event) {
    Object runtime = event.getSession().getServletContext().getAttribute(JerryRuntime.KEY);
    if (runtime instanceof JerryRuntime)
      ((JerryRuntime) runtime).closeOwner(event.getSession().getId());
  }
}
