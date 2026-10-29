#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
mkdir -p "$ROOT/.tools" "$ROOT/dist"
mvn -N -B -ntp org.apache.maven.plugins:maven-dependency-plugin:3.8.1:copy -Dartifact=org.apache.tomcat:jakartaee-migration:1.0.13:jar:shaded "-DoutputDirectory=$ROOT/.tools" -Dmdep.stripVersion=true
TOOL="$ROOT/.tools/jakartaee-migration-shaded.jar"
"$JAVA_HOME/bin/java" -jar "$TOOL" -profile=TOMCAT "$ROOT/jerry-web/target/jerry.war" "$ROOT/.tools/jerry-jakarta.war"
SDK="$ROOT/jerry-instrumentation/target/jerry-instrumentation-2.0.0.jar"
"$JAVA_HOME/bin/java" -jar "$TOOL" -profile=EE "$SDK" "$ROOT/dist/jerry-instrumentation-2.0.0-jakarta.jar"
"$JAVA_HOME/bin/java" -jar "$TOOL" -profile=TOMCAT "$SDK" "$ROOT/dist/jerry-instrumentation-2.0.0-jakarta-servlet-javax-jms.jar"
mkdir -p "$ROOT/.tools/jakarta-instrumentation/instrumentation"
cp "$ROOT/dist/jerry-instrumentation-2.0.0-jakarta.jar" "$ROOT/.tools/jakarta-instrumentation/instrumentation/jerry-instrumentation-2.0.0.jar"
cp "$ROOT/dist/jerry-instrumentation-2.0.0-jakarta-servlet-javax-jms.jar" "$ROOT/.tools/jakarta-instrumentation/instrumentation/jerry-instrumentation-2.0.0-legacy-jms.jar"
"$JAVA_HOME/bin/jar" uf "$ROOT/.tools/jerry-jakarta.war" -C "$ROOT/.tools/jakarta-instrumentation" instrumentation
cp "$SDK" "$ROOT/dist/jerry-instrumentation-2.0.0-javax.jar"
for target in '8.5 tomcat85 javax' '9.0 tomcat9 javax' '10.0 tomcat100 jakarta' '10.1 tomcat101 jakarta' '11.0 tomcat11 jakarta'; do
  set -- $target
  if [ "$3" = javax ]; then source="$ROOT/jerry-web/target/jerry.war"; else source="$ROOT/.tools/jerry-jakarta.war"; fi
  name="jerry-2.0.0-$2.war"
  cp "$source" "$ROOT/dist/$name"
  printf 'Jerry-Target-Tomcat: %s\r\n\r\n' "$1" > "$ROOT/.tools/jerry-target-manifest.mf"
  "$JAVA_HOME/bin/jar" umf "$ROOT/.tools/jerry-target-manifest.mf" "$ROOT/dist/$name"
  if command -v sha256sum >/dev/null 2>&1; then (cd "$ROOT/dist" && sha256sum "$name" > "$name.sha256"); else (cd "$ROOT/dist" && shasum -a 256 "$name" > "$name.sha256"); fi
done
