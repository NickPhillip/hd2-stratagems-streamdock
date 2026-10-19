// Monta o plugin a partir de data/stratagems.json (gerado por parse-wiki.js) e dos SVGs em data/svg:
// gera manifest.json, plugin/stratagems.json e os PNGs dos ícones.
// Uso: node tools/build.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN_ID = 'com.helldivers2.stratagems';
const OUT = path.join(ROOT, `${PLUGIN_ID}.sdPlugin`);
const SVG = path.join(ROOT, 'data', 'svg');

const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stratagems.json'), 'utf8'));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const ARROW = { U: '↑', D: '↓', L: '←', R: '→' };

const entries = list.map((s) => ({ ...s, slug: slug(s.name), uuid: `${PLUGIN_ID}.${slug(s.name)}` }));
const dup = entries.find((e, i) => entries.findIndex((x) => x.slug === e.slug) !== i);
if (dup) throw new Error(`slug repetido: ${dup.slug}`);

// Ícones: um PNG por arquivo SVG (alguns são compartilhados), 144 px (@2x) e 72 px.
const icons = new Map();
for (const e of entries) icons.set(e.iconFile, slug(e.iconFile.replace(/_Stratagem_Icon_Background\.svg$/, '')));
const renderPairs = [];
for (const [svg, base] of icons) {
  renderPairs.push(`${svg}=${base}@2x.png`, `${svg}=${base}.png`);
  renderPairs.push(`${svg}=${base}-cd@2x.png`); // escurecido, enviado pelo plugin durante o cooldown
}
// Ícone do plugin / categoria.
renderPairs.push('_Stratagem_Icon.svg=plugin@2x.png', '_Stratagem_Icon.svg=plugin.png');

const imgDir = path.join(OUT, 'images');
fs.rmSync(imgDir, { recursive: true, force: true });
const render = (size, pairs) => execFileSync(process.execPath, [
  path.join(__dirname, 'render-icons.js'), SVG, imgDir, String(size), ...pairs,
], { stdio: 'inherit' });
render(144, renderPairs.filter((p) => p.endsWith('@2x.png')));
render(72, renderPairs.filter((p) => !p.endsWith('@2x.png')));

const manifest = {
  SDKVersion: 1,
  Author: 'Helldiver',
  Name: 'Helldivers 2 Stratagems',
  Description: 'Calls Helldivers 2 stratagems (opens the stratagem menu and enters the arrow code), with cooldown timers.',
  Category: 'Helldivers 2',
  CategoryIcon: 'images/plugin',
  Icon: 'images/plugin',
  Version: '1.0.0',
  URL: 'https://helldivers.wiki.gg/wiki/Stratagems',
  CodePathWin: 'plugin/index.js',
  OS: [{ Platform: 'windows', MinimumVersion: '10' }],
  Software: { MinimumVersion: '3.10.188.226' },
  Nodejs: { Version: '20' },
  Actions: entries.map((e) => {
    const img = `images/${icons.get(e.iconFile)}`;
    return {
      Name: e.name,
      UUID: e.uuid,
      Icon: img,
      Tooltip: `${e.category}: ${[...e.code].map((c) => ARROW[c]).join(' ')}`,
      // O título do botão é usado pelo plugin para mostrar o timer de cooldown.
      States: [{ Image: img, TitleAlignment: 'middle', FontSize: '16' }],
      Controllers: ['Keypad'],
      UserTitleEnabled: false,
      SupportedInMultiActions: true,
      PropertyInspectorPath: 'propertyInspector/index.html',
    };
  }),
};

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(OUT, 'plugin', 'stratagems.json'), JSON.stringify(
  entries.map(({ name, category, code, cooldown, callTime, callTimeUpgraded, uuid, iconFile }) => ({
    name, category, code, cooldown, uuid,
    callTime: callTime ?? 0,                   // s entre a bola cair e a estratégia chegar (wiki)
    callTimeUpgraded: callTimeUpgraded ?? null, // idem, com a melhoria da nave correspondente
    image: `images/${icons.get(iconFile)}@2x.png`,
    imageCooldown: `images/${icons.get(iconFile)}-cd@2x.png`,
  })), null, 2));
console.log(`manifest com ${manifest.Actions.length} ações, ${icons.size} ícones`);
