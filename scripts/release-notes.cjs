// Render release notes from the checked reactor version and changelog.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const version = execFileSync(process.execPath, [path.join(root, 'scripts/version.cjs')], { encoding: 'utf8' }).trim();
const lines = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
const start = lines.indexOf(`## ${version}`);
if (start < 0) throw new Error(`Missing changelog section for ${version}`);
let end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
if (end < 0) end = lines.length;
const changes = lines.slice(start + 1, end).join('\n').trim();
if (!changes) throw new Error(`Empty changelog section for ${version}`);
process.stdout.write(`## Changes\n\n${changes}\n\n`);
process.stdout.write('## Downloads\n\nChoose the WAR matching your Tomcat family; verify it against the accompanying SHA-256 file. The instrumentation JARs are optional.\n\n');
process.stdout.write('| Tomcat | Minimum Java | WAR suffix |\n| --- | --- | --- |\n| 8.5 | 8 | tomcat85 |\n| 9.0 | 8 | tomcat9 |\n| 10.0 | 8 | tomcat100 |\n| 10.1 | 11 | tomcat101 |\n| 11.0 | 17 | tomcat11 |\n\n');
process.stdout.write('Tomcat 8.5 and 10.0 are end-of-life; prefer a supported Tomcat release when possible. For installation, upgrade and security guidance see the [English Wiki](https://github.com/Mucumba77/Jerry/wiki/EN-Home) or [German Wiki](https://github.com/Mucumba77/Jerry/wiki).\n');
