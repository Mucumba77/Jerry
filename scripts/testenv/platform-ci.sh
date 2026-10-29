#!/usr/bin/env bash
# Disposable loopback-only Tomcat fixture for GitHub Actions.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
: "${TOMCAT_VERSION:?}" "${TOMCAT_FAMILY:?}" "${JAVA8_HOME:?}" "${JAVA_HOME:?}"
version=$(node "$root/scripts/version.cjs")
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/jerry-platform.XXXXXXXX")
pid=''
cleanup() {
  if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  rm -rf -- "$work"
}
trap cleanup EXIT
port=16864
family_major=${TOMCAT_VERSION%%.*}
curl --fail --silent --show-error --location --retry 3 "https://archive.apache.org/dist/tomcat/tomcat-${family_major}/v${TOMCAT_VERSION}/bin/apache-tomcat-${TOMCAT_VERSION}.tar.gz" -o "$work/tomcat.tar.gz"
tar -xzf "$work/tomcat.tar.gz" -C "$work"
tomcat="$work/apache-tomcat-$TOMCAT_VERSION"
base="$work/base"
mkdir -p "$base"/{conf,lib,logs,temp,webapps,work,data} "$work/fixture"/{WEB-INF/classes,WEB-INF/lib,META-INF} "$work/deps" "$work/testenv"
cp "$tomcat/conf/"{web.xml,context.xml,catalina.properties,logging.properties} "$base/conf/"
# Obtain the same API and H2 dependencies used by the local fixture.
JAVA_HOME="$JAVA8_HOME" mvn -B -ntp org.apache.maven.plugins:maven-dependency-plugin:3.8.1:copy -Dartifact=javax.servlet:javax.servlet-api:3.1.0 -DoutputDirectory="$work/deps"
JAVA_HOME="$JAVA8_HOME" mvn -B -ntp org.apache.maven.plugins:maven-dependency-plugin:3.8.1:copy -Dartifact=com.h2database:h2:2.2.224 -DoutputDirectory="$work/deps"
cp "$work/deps/h2-2.2.224.jar" "$base/lib/"
sdk="$root/dist/jerry-instrumentation-$version-javax.jar"
"$JAVA8_HOME/bin/javac" -encoding UTF-8 -source 8 -target 8 -cp "$work/deps/javax.servlet-api-3.1.0.jar:$sdk" -d "$work/fixture/WEB-INF/classes" "$root/scripts/testenv/PlatformFixture.java"
cp "$sdk" "$work/fixture/WEB-INF/lib/jerry-instrumentation.jar"
cat > "$work/fixture/WEB-INF/web.xml" <<'XML'
<web-app xmlns="http://xmlns.jcp.org/xml/ns/javaee" version="3.1"><servlet><servlet-name>fixture</servlet-name><servlet-class>de.mucumba.jerry.testenv.PlatformFixture</servlet-class></servlet><servlet-mapping><servlet-name>fixture</servlet-name><url-pattern>/api</url-pattern></servlet-mapping></web-app>
XML
echo '<Context><ResourceLink name="jdbc/JerryDemo" global="jdbc/JerryDemo" type="javax.sql.DataSource"/></Context>' > "$work/fixture/META-INF/context.xml"
(cd "$work/fixture" && "$JAVA8_HOME/bin/jar" cf "$work/fixture-javax.war" .)
fixture="$work/fixture-javax.war"
if [[ "$family_major" != 8 && "$family_major" != 9 ]]; then
  "$JAVA8_HOME/bin/java" -jar "$root/.tools/jakartaee-migration-shaded.jar" -profile=TOMCAT "$fixture" "$work/fixture-jakarta.war"
  fixture="$work/fixture-jakarta.war"
fi
cp "$fixture" "$base/webapps/fixture.war"
cp "$root/dist/jerry-$version-$TOMCAT_FAMILY.war" "$base/webapps/jerry.war"
password=$("$JAVA8_HOME/bin/java" -version 2>&1 | sha256sum | cut -c1-32)-$(date +%s)-$$
cat > "$base/conf/tomcat-users.xml" <<XML
<tomcat-users><role rolename="jerry-admin"/><user username="platform-admin" password="$password" roles="jerry-admin"/></tomcat-users>
XML
cat > "$base/conf/server.xml" <<XML
<Server port="-1"><Listener className="org.apache.catalina.mbeans.GlobalResourcesLifecycleListener"/><GlobalNamingResources>
<Resource name="UserDatabase" auth="Container" type="org.apache.catalina.UserDatabase" factory="org.apache.catalina.users.MemoryUserDatabaseFactory" pathname="conf/tomcat-users.xml"/>
<Resource name="jdbc/JerryDemo" auth="Container" type="javax.sql.DataSource" factory="org.apache.tomcat.jdbc.pool.DataSourceFactory" driverClassName="org.h2.Driver" url="jdbc:h2:mem:jerry;DB_CLOSE_DELAY=-1" username="sa" password="" maxActive="12" initialSize="1" jmxEnabled="true"/>
</GlobalNamingResources><Service name="Catalina"><Connector address="127.0.0.1" port="$port" protocol="HTTP/1.1"/><Engine name="Catalina" defaultHost="localhost"><Realm className="org.apache.catalina.realm.UserDatabaseRealm" resourceName="UserDatabase"/><Host name="localhost" appBase="webapps" unpackWARs="true" autoDeploy="true"/></Engine></Service></Server>
XML
echo 'monitor.interval.seconds=2' > "$base/conf/jerry.properties"
"$JAVA_HOME/bin/java" -Xms64m -Xmx384m "-Dcatalina.home=$tomcat" "-Dcatalina.base=$base" "-Djava.io.tmpdir=$base/temp" -Djava.util.logging.manager=org.apache.juli.ClassLoaderLogManager "-Djava.util.logging.config.file=$base/conf/logging.properties" -classpath "$tomcat/bin/bootstrap.jar:$tomcat/bin/tomcat-juli.jar" org.apache.catalina.startup.Bootstrap start >"$work/tomcat.log" 2>&1 &
pid=$!
ready=false
for _ in {1..60}; do
  if ! kill -0 "$pid" 2>/dev/null; then cat "$work/tomcat.log"; exit 1; fi
  if curl -fsS "http://127.0.0.1:$port/jerry/login.html" >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then cat "$work/tomcat.log"; exit 1; fi
export JERRY_TEST_PORT="$port" JERRY_TEST_VERSION="$TOMCAT_VERSION" JERRY_TEST_PASSWORD="$password" JERRY_PROJECT_VERSION="$version"
if [[ "${JERRY_TEST_BROWSER:-0}" == 1 ]]; then export JERRY_TEST_BROWSER=1; fi
if ! node "$root/scripts/testenv/verify-platform.cjs"; then cat "$work/tomcat.log"; exit 1; fi
if [[ "${JERRY_TEST_BROWSER:-0}" == 1 ]]; then
  export JERRY_TEST_ENV_ROOT="$work/testenv"
  printf '{"port":%s,"url":"http://127.0.0.1:%s/jerry/"}\n' "$port" "$port" > "$work/testenv/environment.json"
  printf '{"user":"platform-admin","password":"%s"}\n' "$password" > "$work/testenv/access.json"
  if ! node "$root/scripts/testenv/verify-sql-completion.cjs"; then cat "$work/tomcat.log"; exit 1; fi
fi
