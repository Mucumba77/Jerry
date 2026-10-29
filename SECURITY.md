# Security

Jerry is a privileged Tomcat administration application with access to deployed applications, server metadata, configured logs and database resources. Deploy it only behind authenticated, encrypted administrative access and assign the minimum Tomcat and database privileges required. Keep Tomcat, Java and JDBC drivers patched; Tomcat 8.5 and 10.0 are end-of-life platforms.

Do not publish credentials, stack traces containing secrets, application data or reproducible exploits in a public issue. Use a private GitHub security advisory for this repository when available, or contact the repository owner privately with a description, affected versions and a minimal safe reproduction. Do not include production data in reports.

The application includes role checks, CSRF protection for state changes, bounded background workers, path restrictions for log access and masking for some sensitive JMX attributes. These measures do not replace a network boundary, least privilege or review of the data exposed by your application and JDBC drivers.
