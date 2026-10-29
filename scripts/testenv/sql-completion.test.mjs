import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '../../frontend/node_modules/@codemirror/state/dist/index.js';
import { sql, StandardSQL } from '../../frontend/node_modules/@codemirror/lang-sql/dist/index.js';
import { CompletionContext } from '../../frontend/node_modules/@codemirror/autocomplete/dist/index.js';
import { sqlCompletionSource } from '../../frontend/src/sqlCompletion.ts';

const tables = [{name:'TEST_CUSTOMERS',schema:'PUBLIC'},{name:'TEST_TRANSACTIONS',schema:'PUBLIC'},
  {name:'Mixed Table',schema:'PUBLIC'},{name:'INTERNAL_ONLY',schema:'OTHER'}];
function setup(overrides = {}) {
  const calls=[];
  const catalog={identity:'session-1/PUBLIC',schema:'PUBLIC',quote:'"',storesUpperCase:true,storesLowerCase:false,
    dialect:'standard',tables,loadColumns:async table=>{calls.push(table);return ['ID','NAME','Mixed Column'];},...overrides};
  const source=sqlCompletionSource(()=>catalog);
  const complete=async (doc,pos=doc.length,explicit=false)=>{
    const state=EditorState.create({doc,extensions:[sql({dialect:StandardSQL})]});
    return source(new CompletionContext(state,pos,explicit));
  };
  return {catalog,calls,complete};
}

test('table names and SQL functions are available without fetching columns',async()=>{
  const {complete,calls}=setup();
  const result=await complete('SELECT * FROM TEST_');
  assert.ok(result.options.some(item=>item.label==='TEST_CUSTOMERS'));
  assert.ok(!result.options.some(item=>item.label==='INTERNAL_ONLY'));
  const functions=await complete('SELECT COA');
  assert.ok(functions.options.some(item=>item.label==='COALESCE' && item.type==='function'));
  assert.equal(calls.length,0);
});
test('columns resolve direct names, schema-qualified names, and aliases after the cursor',async()=>{
  for(const text of ['SELECT TEST_CUSTOMERS.','SELECT PUBLIC.TEST_CUSTOMERS.', 'SELECT c. FROM TEST_CUSTOMERS AS c', 'SELECT c. FROM PUBLIC.TEST_CUSTOMERS c', 'SELECT c. FROM test_customers c', 'SELECT c. FROM TEST_TRANSACTIONS a JOIN TEST_CUSTOMERS c ON a.ID = c.ID']) {
    const {complete,calls}=setup();
    const pos=text.indexOf(' FROM ')>=0?text.indexOf(' FROM '):text.length;
    const result=await complete(text,pos);
    assert.ok(result?.options.some(item=>item.label==='NAME'),text);
    assert.deepEqual(calls.map(item=>item.name),['TEST_CUSTOMERS']);
  }
});
test('schema completion and quoted table and column identifiers',async()=>{
  const {complete}=setup();
  const schema=await complete('SELECT PUBLIC.');
  assert.ok(schema.options.some(item=>item.label==='TEST_CUSTOMERS'));
  const names=await complete('SELECT * FROM Mixed');
  assert.equal(names.options.find(item=>item.label==='Mixed Table').apply,'"Mixed Table"');
  const quoted=await complete('SELECT "Mixed Table"."Mi');
  assert.ok(quoted.options.some(item=>item.label==='"Mixed Column"' && item.apply==='"Mixed Column"'));
  assert.equal(quoted.from,'SELECT "Mixed Table".'.length);
});
test('dialect-specific function suggestions do not mix unrelated engines',async()=>{
  const {complete}=setup({dialect:'oracle'});
  const options=(await complete('SELECT N')).options.map(item=>item.label);
  assert.ok(options.includes('NVL'));
  assert.ok(!options.includes('GETDATE'));
});
test('identifier folding and quoted names select the correct case-sensitive table',async()=>{
  const {complete,calls}=setup({schema:'public',dialect:'postgresql',storesUpperCase:false,storesLowerCase:true,
    tables:[{name:'items',schema:'public'},{name:'ITEMS',schema:'public'}]});
  await complete('SELECT ITEMS.');assert.equal(calls.at(-1).name,'items');
  await complete('SELECT "ITEMS".');assert.equal(calls.at(-1).name,'ITEMS');
  const alias='SELECT x. FROM "ITEMS" x';await complete(alias,alias.indexOf(' FROM '));
  assert.equal(calls.at(-1).name,'ITEMS');
});
test('comments, strings, unresolved names and other schemas never trigger metadata reads',async()=>{
  const {complete,calls}=setup();
  for(const text of ['-- TEST_CUSTOMERS.','SELECT \'TEST_CUSTOMERS.\'','SELECT /* TEST_CUSTOMERS.','SELECT MISSING.','SELECT OTHER.TEST_CUSTOMERS.']) {
    assert.equal(await complete(text),null,text);
  }
  assert.equal(calls.length,0);
});
test('obsolete async completions and metadata failures are safely ignored',async()=>{
  let finish;const {catalog,complete}=setup({loadColumns:()=>new Promise(resolve=>{finish=resolve;})});
  const pending=complete('SELECT TEST_CUSTOMERS.');
  catalog.identity='another-session';finish(['ID']);
  assert.equal(await pending,null);
  const failed=setup({loadColumns:async()=>{throw Error('connection busy');}});
  assert.equal(await failed.complete('SELECT TEST_CUSTOMERS.'),null);
});
