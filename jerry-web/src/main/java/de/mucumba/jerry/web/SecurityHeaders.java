package de.mucumba.jerry.web;

import java.io.IOException;
import javax.servlet.Filter;
import javax.servlet.FilterChain;
import javax.servlet.FilterConfig;
import javax.servlet.ServletException;
import javax.servlet.ServletRequest;
import javax.servlet.ServletResponse;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/** Applies the console content security policy and browser security headers. */
public final class SecurityHeaders implements Filter {
  @Override
  public void init(FilterConfig config) {}

  @Override
  public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
      throws IOException, ServletException {
    HttpServletRequest req = (HttpServletRequest) request;
    HttpServletResponse res = (HttpServletResponse) response;
    req.setCharacterEncoding("UTF-8");
    res.setCharacterEncoding("UTF-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
    if (req.getRequestURI().contains("/api/")
        || req.getRequestURI().endsWith("/")
        || req.getRequestURI().endsWith(".html")
        || req.getRequestURI().endsWith("/login.css")
        || req.getRequestURI().endsWith("/fonts.css")) res.setHeader("Cache-Control", "no-store");
    if (req.isSecure()) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    chain.doFilter(request, response);
  }

  @Override
  public void destroy() {}
}
