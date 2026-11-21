package de.mucumba.jerry.tomcat;

import org.apache.catalina.Context;

/** Switches to the target application's class loader using Tomcat 11's ContextBind API. */
final class ContextBinding {
  private ContextBinding() {}

  static ClassLoader bind(Context context) {
    return context.bind(null);
  }

  static void unbind(Context context, ClassLoader previous) {
    context.unbind(previous);
  }
}
