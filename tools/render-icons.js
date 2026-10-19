// Converte os SVGs da wiki em PNGs para as teclas, usando o Edge em modo headless
// (uma única execução: a página desenha cada SVG num canvas e devolve os PNGs no DOM).
// Uso: node render-icons.js <pasta-svg> <pasta-saida> <tamanho> <arquivo1.svg>=<saida1> ...
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const [, , svgDir, outDir, sizeArg, ...pairs] = process.argv;
const size = Number(sizeArg);

const EDGE = [
  path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
].find((p) => fs.existsSync(p));
if (!EDGE) throw new Error('Microsoft Edge não encontrado');

const jobs = pairs.map((p) => {
  const [svg, out] = p.split('=');
  const data = fs.readFileSync(path.join(svgDir, svg)).toString('base64');
  // Saídas com "-cd" no nome são a versão escurecida usada durante o cooldown.
  return { out, dim: out.includes('-cd'), src: `data:image/svg+xml;base64,${data}` };
});

// Fundo escuro e arredondado atrás do ícone, como os botões do jogo.
const page = `<!doctype html><html><body><pre id="out"></pre><script>
const jobs = ${JSON.stringify(jobs)};
const S = ${size};
(async () => {
  const lines = [];
  for (const j of jobs) {
    const img = new Image();
    img.src = j.src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = '#111418';
    g.beginPath(); g.roundRect(0, 0, S, S, S * 0.12); g.fill();
    const pad = S * 0.025; // borda escura mínima ao redor do ícone
    g.drawImage(img, pad, pad, S - 2 * pad, S - 2 * pad);
    if (j.dim) {
      g.fillStyle = 'rgba(0,0,0,0.68)';
      g.beginPath(); g.roundRect(0, 0, S, S, S * 0.12); g.fill();
    }
    lines.push(j.out + '|' + c.toDataURL('image/png').split(',')[1]);
  }
  document.getElementById('out').textContent = 'BEGIN\\n' + lines.join('\\n') + '\\nEND';
})();
</script></body></html>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hd2icons-'));
const htmlFile = path.join(tmp, 'render.html');
fs.writeFileSync(htmlFile, page);

const dom = execFileSync(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${path.join(tmp, 'profile')}`,
  '--virtual-time-budget=20000', '--dump-dom', `file:///${htmlFile.replace(/\\/g, '/')}`,
], { maxBuffer: 256 * 1024 * 1024 }).toString();

const body = dom.replace(/\r/g, '').match(/BEGIN\n([\s\S]*?)\nEND/);
if (!body) {
  console.error(dom.slice(0, 2000));
  throw new Error('O Edge não devolveu os ícones');
}

fs.mkdirSync(outDir, { recursive: true });
let n = 0;
for (const line of body[1].split('\n')) {
  const [out, b64] = line.split('|');
  fs.writeFileSync(path.join(outDir, out), Buffer.from(b64, 'base64'));
  n++;
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${n} ícones gerados em ${outDir}`);
