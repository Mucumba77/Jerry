// Read the Maven reactor version and reject unsynchronized release metadata.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pom = fs.readFileSync(path.join(root, 'pom.xml'), 'utf8');
const match = pom.match(/<artifactId>jerry<\/artifactId>\s*<version>([^<]+)<\/version>/);
if (!match || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.]+)?$/.test(match[1])) {
  throw new Error('Cannot determine a safe Jerry version from the root pom.xml');
}
const version = match[1];
for (const module of ['jerry-core', 'jerry-tomcat85', 'jerry-web', 'jerry-instrumentation']) {
  const xml = fs.readFileSync(path.join(root, module, 'pom.xml'), 'utf8');
  const parent = xml.match(/<parent>[\s\S]*?<artifactId>jerry<\/artifactId>\s*<version>([^<]+)<\/version>/);
  if (!parent || parent[1] !== version) throw new Error(`${module} parent version does not match ${version}`);
}
for (const file of ['frontend/package.json', 'frontend/package-lock.json']) {
  const json = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  if (json.version !== version || (json.packages && json.packages['']?.version !== version)) {
    throw new Error(`${file} version does not match ${version}`);
  }
}
process.stdout.write(version);
