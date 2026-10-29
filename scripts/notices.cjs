const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
fs.mkdirSync(output, { recursive: true });
const lock = JSON.parse(fs.readFileSync(path.join(root, 'frontend/package-lock.json'), 'utf8'));
const frontend = [], texts = [];
for (const [relative, information] of Object.entries(lock.packages || {})) {
  if (!relative || information.dev || information.optional) continue;
  const directory = path.join(root, 'frontend', relative);
  if (!fs.existsSync(path.join(directory, 'package.json'))) continue;
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  frontend.push({ name: pkg.name, version: pkg.version, license: pkg.license || 'See package license' });
  for (const file of fs.readdirSync(directory)) if (/^(licen[cs]e|copying|notice)(\.|$)/i.test(file) && fs.statSync(path.join(directory, file)).isFile()) {
    texts.push(`\n===== ${pkg.name} ${pkg.version}: ${file} =====\n${fs.readFileSync(path.join(directory, file), 'utf8')}`);
  }
}
const libraries = path.join(root, 'jerry-web/target/jerry/WEB-INF/lib');
const backend = fs.existsSync(libraries) ? fs.readdirSync(libraries).filter(name => name.endsWith('.jar')).map(name => {
  const bytes = fs.readFileSync(path.join(libraries, name));
  return { file: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}) : [];
const fontPath = path.join(root, 'frontend/public/fonts/Onest-Variable.ttf');
const fonts = [{name:'Onest', file:'fonts/Onest-Variable.ttf', license:'SIL Open Font License 1.1', source:'https://github.com/google/fonts/tree/main/ofl/onest', sha256:crypto.createHash('sha256').update(fs.readFileSync(fontPath)).digest('hex')}];
texts.push('\n===== Onest: SIL Open Font License 1.1 =====\n'+fs.readFileSync(path.join(root,'frontend/public/fonts/OFL.txt'),'utf8'));
fs.writeFileSync(path.join(output, 'dependencies.json'), JSON.stringify({ application: 'Jerry', version: require('../frontend/package.json').version, frontend, fonts, backend }, null, 2) + '\n');
fs.writeFileSync(path.join(output, 'THIRD-PARTY-LICENSES.txt'), 'Jerry – packaged frontend dependency licenses\n' + texts.join('\n') + '\nBackend: see bundled JAR META-INF notices (also extracted by package.ps1).\n');
console.log(`Dependency inventory: ${frontend.length} frontend packages, ${backend.length} runtime JARs.`);
