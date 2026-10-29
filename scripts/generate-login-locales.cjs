// Generate the unauthenticated login catalog from the same local UI catalogs used by React.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'frontend/public');
const languages = {de:'Deutsch',en:'English',fr:'Français',es:'Español',it:'Italiano',ru:'Русский',pt:'Português',nl:'Nederlands',pl:'Polski',tr:'Türkçe',zh:'中文',ja:'日本語',ar:'العربية'};
const pages = ['login.html','login-error.html'].map(name => fs.readFileSync(path.join(publicDir,name),'utf8')).join('\n');
const keys = [...new Set([...pages.matchAll(/data-i18n="([^"]+)"/g)].map(match => match[1]))];
const catalogs = {};
for (const code of Object.keys(languages).filter(code => code !== 'de')) {
  const file=path.join(root,'frontend/src/locales',`${code}.json`);
  if (!fs.existsSync(file)) throw new Error(`Missing locale catalog: ${file}`);
  const source=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  catalogs[code]=Object.fromEntries(keys.map(key => [key,source[key] ?? key]));
}
const content=`// Generated from frontend/src/locales; user data stays in the browser.\n`+
  `const languages=${JSON.stringify(languages)};\nconst catalogs=${JSON.stringify(catalogs)};\n`+
  `const picker=document.getElementById('login-language');\n`+
  `for(const [code,name] of Object.entries(languages)){const option=document.createElement('option');option.value=code;option.textContent=name;picker.appendChild(option);}\n`+
  `function apply(code){if(!languages[code])code='de';picker.value=code;document.documentElement.lang=code;document.documentElement.dir=code==='ar'?'rtl':'ltr';for(const node of document.querySelectorAll('[data-i18n]')){const key=node.getAttribute('data-i18n');node.textContent=(catalogs[code]||{})[key]||key;}picker.setAttribute('aria-label',(catalogs[code]||{})['Sprache']||'Sprache');}\n`+
  `let preferred;try{preferred=localStorage.getItem('jerry.language')}catch{}apply((preferred||navigator.language||'de').toLowerCase().split('-')[0]);\n`+
  `picker.addEventListener('change',()=>{try{localStorage.setItem('jerry.language',picker.value)}catch{}apply(picker.value)});\n`;
fs.writeFileSync(path.join(publicDir,'login-i18n.js'),content);
console.log(`Generated login translations for ${Object.keys(languages).length} languages.`);
