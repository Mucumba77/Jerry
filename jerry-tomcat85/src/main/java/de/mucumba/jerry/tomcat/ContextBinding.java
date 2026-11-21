package de.mucumba.jerry.tomcat;

import org.apache.catalina.Context;

/** Switches to the target application's class loader on the legacy Tomcat API. */
final class ContextBinding {
  private ContextBinding() {}

  static ClassLoader bind(Context context) {
    return context.bind(false, null);
  }

  static void unbind(Context context, ClassLoader previous) {
    context.unbind(false, previous);
  }
}
