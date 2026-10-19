// Baixa da wiki os ícones SVG listados em data/stratagems.json para data/svg
// (mais o ícone genérico de estratégia, usado como ícone do plugin).
// Uso: node tools/fetch-icons.js
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'svg');
const BASE = 'https://helldivers.wiki.gg/images/';

(async () => {
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stratagems.json'), 'utf8'));
  const files = new Map([['_Stratagem_Icon.svg', 'Stratagem_Icon.svg']]);
  for (const s of list) files.set(s.iconFile, s.iconFile);

  fs.mkdirSync(OUT, { recursive: true });
  let ok = 0;
  for (const [local, remote] of files) {
    const dest = path.join(OUT, local);
    if (fs.existsSync(dest)) { ok++; continue; }
    const res = await fetch(BASE + encodeURIComponent(remote), { headers: { 'User-Agent': 'Mozilla/5.0 StratagemPluginBuilder' } });
    if (!res.ok) { console.log(`falhou (${res.status}): ${remote}`); continue; }
    const svg = await res.text();
    if (/<script|\bon\w+=/i.test(svg)) { console.log(`ignorado (contém script): ${remote}`); continue; }
    fs.writeFileSync(dest, svg);
    ok++;
  }
  console.log(`${ok}/${files.size} ícones em ${OUT}`);
})();
