// Busca o tempo de chegada (call-in) de cada estratégia na página dela na wiki
// (campos call_time / call_time_upgraded da infobox) e grava em data/stratagems.json.
// Uso: node tools/fetch-calltimes.js
const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', 'data', 'stratagems.json');
const API = 'https://helldivers.wiki.gg/api.php';

function field(text, name) {
  const m = text.match(new RegExp(`^\\s*\\|\\s*${name}\\s*=\\s*([0-9.]+)`, 'm'));
  return m ? Number(m[1]) : null;
}

(async () => {
  const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const byTitle = new Map();
  for (let i = 0; i < list.length; i += 50) {
    const titles = list.slice(i, i + 50).map((s) => s.name).join('|');
    const url = `${API}?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&redirects=1&titles=${encodeURIComponent(titles)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 StratagemPluginBuilder' } });
    const json = await res.json();
    // Mapeia títulos pedidos -> títulos finais (normalização e redirecionamentos).
    const alias = new Map();
    for (const n of json.query.normalized || []) alias.set(n.from, n.to);
    for (const r of json.query.redirects || []) alias.set(r.from, r.to);
    const resolve = (t) => { let x = t; for (let k = 0; k < 3 && alias.has(x); k++) x = alias.get(x); return x; };
    const pages = new Map(json.query.pages.map((p) => [p.title, p]));
    for (const s of list.slice(i, i + 50)) {
      const p = pages.get(resolve(s.name));
      byTitle.set(s.name, p && p.revisions ? p.revisions[0].slots.main.content : null);
    }
  }

  const missing = [];
  for (const s of list) {
    const text = byTitle.get(s.name);
    s.callTime = text ? field(text, 'call_time') : null;
    s.callTimeUpgraded = text ? field(text, 'call_time_upgraded') : null;
    delete s.callTimeEstimated;
    // Algumas páginas (ex.: Exosuits) trazem o call-in numa tabela: '''Call-in Time''' ... '''10.50 seconds'''
    if (s.callTime === null && text) {
      const m = text.match(/'''Call-in Time'''[\s\S]{0,80}?'''([0-9.]+) seconds'''/);
      if (m) s.callTime = Number(m[1]);
    }
    if (s.callTime === null) missing.push(s);
  }
  // Sem dado na wiki: usa o valor mais comum da mesma categoria (estimativa), se ela tiver cooldown.
  for (const s of missing) {
    if (!s.cooldown) continue;
    const peers = list.filter((x) => x.category === s.category && x.callTime !== null && !x.callTimeEstimated);
    const count = new Map();
    for (const p of peers) {
      const k = `${p.callTime}/${p.callTimeUpgraded}`;
      count.set(k, (count.get(k) || 0) + 1);
    }
    const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!best) continue;
    const [ct, up] = best[0].split('/');
    s.callTime = Number(ct);
    s.callTimeUpgraded = up === 'null' ? null : Number(up);
    s.callTimeEstimated = true;
    console.log(`estimado pela categoria: ${s.name} = ${best[0]}`);
  }
  missing.splice(0, missing.length, ...missing.filter((s) => s.callTime === null).map((s) => s.name));
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
  console.log(`${list.length - missing.length}/${list.length} com call-in`);
  if (missing.length) console.log('sem call-in:', missing.join(', '));
})();
