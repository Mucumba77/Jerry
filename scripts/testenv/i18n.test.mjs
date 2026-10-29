import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from '../../frontend/node_modules/typescript/lib/typescript.js';

const sourceDir = path.resolve('frontend/src');
const languages = ['en','fr','es','it','ru','pt','nl','pl','tr','zh','ja','ar'];
const keys = new Set();
for (const name of fs.readdirSync(sourceDir).filter(file => /\.(ts|tsx)$/.test(file) && file !== 'i18n.ts')) {
  const file = path.join(sourceDir,name);
  const ast = ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['t','tr'].includes(node.expression.text) &&
        node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0])) keys.add(node.arguments[0].text);
    ts.forEachChild(node,visit);
  }
  visit(ast);
}
const login = ['login.html','login-error.html'].map(name => fs.readFileSync(path.join('frontend/public',name),'utf8')).join('\n');
for (const match of login.matchAll(/data-i18n="([^"]+)"/g)) keys.add(match[1]);

for (const code of languages) test(`${code} catalog covers static UI and login keys`, () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(sourceDir,'locales',`${code}.json`),'utf8'));
  const missing = [...keys].filter(key => typeof catalog[key] !== 'string' || !catalog[key].trim());
  assert.deepEqual(missing,[],`Missing ${code} translations: ${missing.join(', ')}`);
  for (const key of ['Jerry','Commit','Rollback','Savepoint','context.xml']) {
    if (Object.hasOwn(catalog,key)) assert.equal(catalog[key],key,`${code} must preserve ${key}`);
  }
  for (const [key,value] of Object.entries(catalog)) {
    const placeholders = text => [...text.matchAll(/\{(\d+)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(placeholders(value), placeholders(key), `${code}: invalid placeholders for ${key}`);
    if (/\/\s*s\s*$/i.test(key)) assert.match(value,/\/\s*s\s*$/i,`${code}: rate unit missing for ${key}`);
  }
});
