#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"
VERSION=$(node "$ROOT/scripts/version.cjs")
mkdir -p "$ROOT/.tools" "$ROOT/dist"
: "${JAVA17_HOME:?Please set JAVA17_HOME to a JDK 17 installation}"
if command -v rtk >/dev/null 2>&1; then
  JAVA_HOME="$JAVA17_HOME" rtk mvn -B -ntp -Ptomcat11 -pl :jerry-tomcat11 -am clean verify
else
  JAVA_HOME="$JAVA17_HOME" mvn -B -ntp -Ptomcat11 -pl :jerry-tomcat11 -am clean verify
fi
NATIVE_TARGET="$ROOT/jerry-tomcat11/target"
mvn -N -B -ntp org.apache.maven.plugins:maven-dependency-plugin:3.8.1:copy -Dartifact=org.apache.tomcat:jakartaee-migration:1.0.13:jar:shaded "-DoutputDirectory=$ROOT/.tools" -Dmdep.stripVersion=true
TOOL="$ROOT/.tools/jakartaee-migration-shaded.jar"
"$JAVA_HOME/bin/java" -jar "$TOOL" -profile=TOMCAT "$ROOT/jerry-web/target/jerry.war" "$ROOT/.tools/jerry-jakarta.war"
SDK="$ROOT/jerry-instrumentation/target/jerry-instrumentation-${VERSION}.jar"
cp "$NATIVE_TARGET/instrumentation/jerry-instrumentation-${VERSION}.jar" "$ROOT/dist/jerry-instrumentation-${VERSION}-jakarta.jar"
cp "$NATIVE_TARGET/instrumentation/jerry-instrumentation-${VERSION}-legacy-jms.jar" "$ROOT/dist/jerry-instrumentation-${VERSION}-jakarta-servlet-javax-jms.jar"
"$JAVA_HOME/bin/jar" uf "$ROOT/.tools/jerry-jakarta.war" -C "$NATIVE_TARGET" instrumentation
cp "$SDK" "$ROOT/dist/jerry-instrumentation-${VERSION}-javax.jar"
write_checksum() (
  cd "$ROOT/dist"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" > "$1.sha256"; else shasum -a 256 "$1" > "$1.sha256"; fi
)
for target in '8.5 tomcat85 javax' '9.0 tomcat9 javax' '10.0 tomcat100 jakarta' '10.1 tomcat101 jakarta'; do
  set -- $target
  if [ "$3" = javax ]; then source="$ROOT/jerry-web/target/jerry.war"; else source="$ROOT/.tools/jerry-jakarta.war"; fi
  name="jerry-${VERSION}-$2.war"
  cp "$source" "$ROOT/dist/$name"
  printf 'Jerry-Target-Tomcat: %s\r\n\r\n' "$1" > "$ROOT/.tools/jerry-target-manifest.mf"
  "$JAVA_HOME/bin/jar" umf "$ROOT/.tools/jerry-target-manifest.mf" "$ROOT/dist/$name"
  write_checksum "$name"
done
name="jerry-${VERSION}-tomcat11.war"
cp "$NATIVE_TARGET/jerry.war" "$ROOT/dist/$name"
write_checksum "$name"
