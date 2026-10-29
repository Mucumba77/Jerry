#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
: "${JAVA_HOME:?Please set JAVA_HOME to a JDK 8 installation}"
export PATH="$JAVA_HOME/bin:$PATH"
(cd frontend && npm ci --no-audit --no-fund && npm run build)
if command -v rtk >/dev/null 2>&1; then rtk mvn -B -ntp clean verify; else mvn -B -ntp clean verify; fi
mkdir -p dist
sh scripts/platform-wars.sh
cp jerry-web/target/jerry.war dist/jerry.war
if command -v sha256sum >/dev/null 2>&1; then (cd dist && sha256sum jerry.war > jerry.war.sha256); else (cd dist && shasum -a 256 jerry.war > jerry.war.sha256); fi
node scripts/notices.cjs
cp README.md NOTICE.md SECURITY.md CHANGELOG.md CONTRIBUTING.md dist/
if [ -f LICENSE ]; then cp LICENSE dist/; fi
mkdir -p dist/docs
cp -R docs/. dist/docs/
printf '%s\n' 'Jerry is ready: dist/jerry.war'
