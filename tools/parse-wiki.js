// Extrai as estratégias da página renderizada da wiki (helldivers.wiki.gg/wiki/Stratagems).
// Uso: node parse-wiki.js <stratagems.html> <saida.json>
const fs = require('fs');

const [, , inFile, outFile] = process.argv;
const html = fs.readFileSync(inFile, 'utf8');

const decode = (s) => s
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

// Marcadores de seção (<summary>Orbital Strikes</summary>, <big><b>Ship</b></big>) e linhas de tabela,
// percorridos na ordem em que aparecem.
const token = /<summary>([^<]+)<\/summary>|<big><b>([^<]+)<\/b><\/big>|<tr>([\s\S]*?)<\/tr>/g;
const ARROWS = { Up: 'U', Down: 'D', Left: 'L', Right: 'R' };

let group = null;
let sub = null;
const out = [];
const seen = new Set();

for (const m of html.matchAll(token)) {
  if (m[1]) { group = decode(m[1]); sub = null; continue; }
  if (m[2]) { sub = decode(m[2]); continue; }

  const row = m[3];
  const icon = row.match(/<img alt="([^"]+?Stratagem Icon[^"]*?)" src="\/images\/([^"?]+)/);
  const name = row.match(/<td><a href="[^"]*" title="[^"]*">([^<]+)<\/a><\/td>/);
  const code = [...row.matchAll(/Stratagem Arrow (Up|Down|Left|Right)\.svg/g)].map((a) => ARROWS[a[1]]);
  if (!icon || !name || code.length === 0) continue;

  const title = decode(name[1]);
  if (seen.has(title)) continue;
  seen.add(title);

  // Colunas: ícone, nome, código, cooldown base ("180s", "27.5", "N/A"), ...
  const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, ' ').trim());
  const cd = parseFloat(cells[3]);

  out.push({
    name: title,
    category: sub ? `${group} - ${sub}` : group,
    code: code.join(''),
    cooldown: Number.isFinite(cd) && cd > 0 ? Math.round(cd) : 0,
    iconFile: decodeURIComponent(icon[2]),
  });
}

fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(`${out.length} estratégias`);
const byCat = {};
for (const s of out) byCat[s.category] = (byCat[s.category] || 0) + 1;
console.log(byCat);
