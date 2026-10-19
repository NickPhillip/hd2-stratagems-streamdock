// Plugin "Helldivers 2 Stratagems" para Stream Dock / fifine Control Deck.
// Cada ação é uma estratégia; ao apertar a tecla do deck, o auxiliar hd2keys.ps1
// segura a tecla do menu (Ctrl) e digita a sequência de setas da estratégia.
// Sem dependências: usa apenas o Node 20 que vem com o app.
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const LOG = path.join(__dirname, 'plugin.log');
function log(...a) {
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${a.join(' ')}\n`); } catch { /* sem log */ }
}
try { if (fs.statSync(LOG).size > 512 * 1024) fs.unlinkSync(LOG); } catch { /* não existe */ }
process.on('uncaughtException', (e) => log('uncaughtException', e.stack || e));

// ---- argumentos: -port N -pluginUUID X -registerEvent Y -info {...}
const args = {};
for (let i = 2; i < process.argv.length - 1; i++) {
  if (process.argv[i].startsWith('-')) args[process.argv[i].slice(1)] = process.argv[i + 1];
}

// ---- tabela de estratégias: UUID da ação -> sequência
const STRATAGEMS = JSON.parse(fs.readFileSync(path.join(__dirname, 'stratagems.json'), 'utf8'));
const byUuid = new Map(STRATAGEMS.map((s) => [s.uuid, s]));

const DEFAULTS = {
  keys: 'arrows',
  menuKey: 'ctrl',
  menuMode: 'toggle',     // toggle: um toque abre o menu | hold: segura durante a sequência
  menuDelay: 300,         // ms entre abrir o menu e a primeira seta
  keyHold: 40,
  keyGap: 40,
  throwDetect: 'on',      // on: o cooldown começa no clique de arremesso | off: ao apertar o botão
  throwTimeout: 15,       // s esperando o arremesso antes de desistir
  gameProcess: 'helldivers2',
  sweepFps: 4,            // atualizações por segundo da varredura do cooldown (0 = sem varredura)
  upgrades: [],           // melhorias da nave desbloqueadas (ids de SHIP_UPGRADES / CALLIN_UPGRADES)
};
const SWEEP_FPS_OPTIONS = [0, 1, 2, 4];

// Melhorias da Super Destroyer que reduzem cooldown (helldivers.wiki.gg/wiki/Ship_Modules).
// As categorias são as seções da tabela de estratégias da wiki.
const SHIP_UPGRADES = [
  { id: 'streamlined-request', pct: 10, applies: (s) => s.category === 'Support Weapons' },
  { id: 'hand-carts', pct: 10, applies: (s) => s.category === 'Backpacks' },
  { id: 'zero-g-breech', pct: 10, applies: (s) => s.category === 'Orbital Strikes' },
  { id: 'liquid-ventilated-cockpit', pct: 50, applies: (s) => s.category === 'Eagle Strikes' },
  { id: 'morale-augmentation', pct: 5, applies: () => true },
  { id: 'synthetic-supplementation', pct: 10,
    applies: (s) => s.category === 'Sentries' || s.category === 'Emplacements' || s.name === 'Resupply' },
];

// Melhorias que encurtam a chegada (call-in). O valor reduzido vem da página de cada
// estratégia na wiki (call_time_upgraded).
const CALLIN_UPGRADES = [
  { id: 'targeting-software', applies: (s) => s.category === 'Orbital Strikes' },
  { id: 'streamlined-launch', applies: (s) => s.category === 'Support Weapons' },
  { id: 'dynamic-tracking', applies: (s) => s.category === 'Sentries' },
  { id: 'rapid-launch', applies: (s) => s.category === 'Emplacements' },
];
const UPGRADE_IDS = [...SHIP_UPGRADES, ...CALLIN_UPGRADES].map((u) => u.id);

// Tempo (s) entre a bola parar no chão e a estratégia chegar; o cooldown só começa depois.
function callTimeFor(strat) {
  const chosen = effectiveSettings().upgrades;
  const upgraded = strat.callTimeUpgraded !== null && strat.callTimeUpgraded !== undefined
    && CALLIN_UPGRADES.some((u) => chosen.includes(u.id) && u.applies(strat));
  return upgraded ? strat.callTimeUpgraded : (strat.callTime || 0);
}

// Cooldown com as melhorias selecionadas. Reduções de melhorias diferentes são aplicadas em
// sequência (multiplicam): ex. Orbital 180 s com Zero-G (−10%) e Morale (−5%) = 180 × 0,9 × 0,95 ≈ 154 s.
function cooldownFor(strat) {
  const chosen = effectiveSettings().upgrades;
  let cd = strat.cooldown;
  for (const u of SHIP_UPGRADES) if (chosen.includes(u.id) && u.applies(strat)) cd *= 1 - u.pct / 100;
  return Math.round(cd);
}
let globalSettings = { ...DEFAULTS };

// Cópia local das configurações, fora da pasta do plugin: o app pode não persistir as
// configurações globais (ex.: quando o PC trava) e uma reinstalação substitui a pasta do plugin.
const SETTINGS_FILE = path.join(process.env.LOCALAPPDATA || __dirname, 'Hd2StratagemsPlugin', 'settings.json');
function loadSettingsFile() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return null; }
}
function saveSettingsFile(s) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  } catch (e) { log('não foi possível salvar', SETTINGS_FILE, e.message); }
}
{
  const saved = loadSettingsFile();
  if (saved) globalSettings = { ...DEFAULTS, ...saved };
}

// Configurações salvas por versões antigas (sem menuMode) tinham tempos curtos demais: descarta os tempos.
function migrate(saved) {
  if (!saved || saved.menuMode) return saved || {};
  const { menuDelay, keyHold, keyGap, ...rest } = saved;
  return rest;
}

function clampNum(v, d, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : d;
}
function effectiveSettings() {
  const s = globalSettings;
  const proc = String(s.gameProcess || '').trim().replace(/\.exe$/i, '');
  return {
    keys: s.keys === 'wasd' ? 'wasd' : 'arrows',
    menuKey: ['ctrl', 'alt', 'shift', 'none'].includes(s.menuKey) ? s.menuKey : 'ctrl',
    menuMode: s.menuMode === 'hold' ? 'hold' : 'toggle',
    menuDelay: clampNum(s.menuDelay, DEFAULTS.menuDelay, 2000),
    keyHold: clampNum(s.keyHold, DEFAULTS.keyHold, 1000),
    keyGap: clampNum(s.keyGap, DEFAULTS.keyGap, 1000),
    throwDetect: s.throwDetect === 'off' ? 'off' : 'on',
    throwTimeout: Math.max(1, clampNum(s.throwTimeout, DEFAULTS.throwTimeout, 120)),
    gameProcess: /^(\*|[A-Za-z0-9_.-]{1,64})$/.test(proc) ? proc : DEFAULTS.gameProcess,
    sweepFps: SWEEP_FPS_OPTIONS.includes(Number(s.sweepFps)) ? Number(s.sweepFps) : DEFAULTS.sweepFps,
    upgrades: Array.isArray(s.upgrades) ? UPGRADE_IDS.filter((id) => s.upgrades.includes(id)) : [],
  };
}

// ---- auxiliar de teclado (processo PowerShell persistente)
let helper = null;
let helperReady = false;
const pending = []; // { line, context } aguardando resposta, na ordem

function startHelper() {
  helperReady = false;
  helper = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'hd2keys.ps1'),
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  let buf = '';
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      if (line === 'READY') {
        helperReady = true;
        log('auxiliar pronto');
        for (const p of pending) helper.stdin.write(p.line + '\n');
        continue;
      }
      if (line === 'CLICK') { onThrow(); continue; }
      if (line === 'CANCEL') { log('arremesso cancelado pela tecla do menu'); cancelThrow(); continue; }
      if (line.startsWith('DBG ')) { log('auxiliar:', line.slice(4)); continue; }
      const job = pending.shift();
      if (line.startsWith('OK')) {
        if (job) afterSequence(job.context, job.strat);
      } else {
        log('auxiliar:', line);
        if (job) send({ event: 'showAlert', context: job.context });
      }
    }
  });
  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (d) => log('auxiliar stderr:', d.trim()));
  helper.on('exit', (code) => {
    log('auxiliar saiu, código', code);
    helper = null;
    helperReady = false;
    for (const p of pending.splice(0)) send({ event: 'showAlert', context: p.context });
    setTimeout(startHelper, 1000);
  });
}

function helperWrite(line) {
  if (helper && helperReady) helper.stdin.write(line + '\n');
}

function runStratagem(strat, context) {
  const s = effectiveSettings();
  const line = [strat.code, s.keys, s.menuKey, s.menuMode, s.menuDelay, s.keyHold, s.keyGap].join(' ');
  log('executando', strat.name, line);
  // Ignora repetições enquanto a fila já tem sequências demais (tecla segurada, cliques em excesso).
  if (pending.length >= 3) return;
  cancelThrow(); // uma nova estratégia substitui a que esperava o arremesso
  pending.push({ line, context, strat });
  helperWrite(line);
}

// ---- espera do arremesso
// Depois do código, a bola fica na mão e o arremesso acontece ao soltar o botão esquerdo.
// O botão mostra "LANCE" até lá; só então o cooldown começa. Apertar a tecla do menu antes
// disso (o jogador cancelou) desfaz a espera.
let armed = null; // { context, strat, timeout }
const THROW_TITLE = 'THROW'; // título do botão enquanto espera o arremesso

function armHelper() {
  const s = effectiveSettings();
  const injected = process.env.HD2_TEST_INJECTED === '1' ? '1' : '0';
  helperWrite(`ARM ${s.gameProcess} ${injected} ${s.menuKey}`);
}

function afterSequence(context, strat) {
  if (!strat.cooldown) return;
  const s = effectiveSettings();
  if (s.throwDetect === 'off') { startCooldown(context, strat); return; }
  cancelThrow();
  armed = { context, strat,
    timeout: setTimeout(() => { log('arremesso não detectado'); cancelThrow(); }, s.throwTimeout * 1000) };
  setTitle(context, THROW_TITLE);
  armHelper();
}

function onThrow() {
  if (!armed) return;
  const { context, strat, timeout } = armed;
  clearTimeout(timeout);
  armed = null;
  log('arremesso detectado:', strat.name);
  startCooldown(context, strat);
}

function cancelThrow() {
  if (!armed) return;
  clearTimeout(armed.timeout);
  helperWrite('DISARM');
  // Se o botão estava em cooldown (uso repetido), a contagem continua; senão limpa o "LANCE".
  const context = armed.context;
  armed = null;
  if (timers.has(context)) redraw(context);
  else setTitle(context, '');
}

// ---- timer de cooldown no botão
// Depois do arremesso, o botão fica escurecido com a contagem regressiva do cooldown base
// (da wiki) e o ícone volta à cor normal numa varredura em sentido horário, a partir do topo,
// completando a volta quando o tempo acaba. Apertar de novo durante a contagem envia a
// sequência outra vez e reinicia o timer.
const png = require('./png');

const timers = new Map(); // context -> { strat, start (chegada), end, interval, lastTitle, lastStep }
const imageCache = new Map();
const pixelCache = new Map();
const angleCache = new Map();
const SWEEP_STEPS = 120; // resolução da varredura: 3° por passo

function pixels(file) {
  if (!pixelCache.has(file)) pixelCache.set(file, png.decode(fs.readFileSync(path.join(__dirname, '..', file))));
  return pixelCache.get(file);
}

// Para cada pixel, o passo da varredura (0..SWEEP_STEPS) em que ele volta à cor normal:
// ângulo medido a partir das 12 horas, em sentido horário.
function angleSteps(w, h) {
  const key = `${w}x${h}`;
  if (!angleCache.has(key)) {
    const steps = new Uint8Array(w * h);
    const cx = (w - 1) / 2; const cy = (h - 1) / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let a = Math.atan2(x - cx, cy - y); // 0 no topo, cresce no sentido horário
        if (a < 0) a += 2 * Math.PI;
        steps[y * w + x] = Math.floor((a / (2 * Math.PI)) * SWEEP_STEPS);
      }
    }
    angleCache.set(key, steps);
  }
  return angleCache.get(key);
}

// Ícone escurecido com a fatia [0, step) já na cor normal.
function sweepImage(strat, step) {
  const lit = pixels(strat.image);
  const dim = pixels(strat.imageCooldown);
  const steps = angleSteps(lit.width, lit.height);
  const out = Buffer.from(dim.data);
  for (let i = 0; i < steps.length; i++) {
    if (steps[i] < step) lit.data.copy(out, i * 4, i * 4, i * 4 + 4);
  }
  const buf = png.encode({ width: lit.width, height: lit.height, data: out });
  return `data:image/png;base64,${buf.toString('base64')}`;
}

function imageData(file) {
  if (!imageCache.has(file)) {
    const b64 = fs.readFileSync(path.join(__dirname, '..', file)).toString('base64');
    imageCache.set(file, `data:image/png;base64,${b64}`);
  }
  return imageCache.get(file);
}

function fmt(sec) {
  return sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : `${sec}s`;
}

function setTitle(context, title) {
  send({ event: 'setTitle', context, payload: { title, target: 0 } });
}
function setImage(context, file) {
  send({ event: 'setImage', context, payload: { image: imageData(file), target: 0 } });
}

// Atualiza o botão; só envia título/imagem quando mudam (segundos / passo da varredura).
function tick(context) {
  const t = timers.get(context);
  if (!t) return;
  const now = Date.now();
  const left = Math.ceil((t.end - now) / 1000);
  if (left <= 0) { stopCooldown(context); return; }
  // Fase de chegada (bola no ar + call-in): "↓7s" com o ícone escuro parado.
  // Depois, o cooldown: contagem e varredura.
  const arriving = now < t.start;
  const title = arriving ? `↓${Math.ceil((t.start - now) / 1000)}s` : fmt(left);
  const isArmed = armed && armed.context === context; // "LANCE" tem prioridade no título
  if (!isArmed && title !== t.lastTitle) { setTitle(context, title); t.lastTitle = title; }
  // Sem varredura (ou chegando): fica no passo 0 (ícone todo escurecido), enviado uma única vez.
  const step = t.sweep && !arriving ? Math.floor(((now - t.start) / (t.end - t.start)) * SWEEP_STEPS) : 0;
  if (step !== t.lastStep) {
    t.lastStep = step;
    try {
      send({ event: 'setImage', context, payload: { image: sweepImage(t.strat, step), target: 0 } });
    } catch (e) {
      log('falha ao desenhar o progresso:', e.message);
      setImage(context, t.strat.imageCooldown);
    }
  }
}

// Força reenviar título e imagem (ex.: o botão reapareceu numa troca de página).
function redraw(context) {
  const t = timers.get(context);
  if (!t) return;
  t.lastTitle = null;
  t.lastStep = null;
  tick(context);
}

function startCooldown(context, strat) {
  if (!strat.cooldown) return;
  stopCooldown(context, false);
  const s = effectiveSettings();
  const fps = s.sweepFps;
  // O cooldown só começa quando a estratégia chega (call-in, contado a partir do arremesso;
  // o voo da bola varia demais para ser estimado).
  const start = Date.now() + callTimeFor(strat) * 1000;
  const t = { strat, start, end: start + cooldownFor(strat) * 1000, interval: null, lastTitle: null, lastStep: null,
    sweep: fps > 0 };
  timers.set(context, t);
  tick(context);
  // 4/s deixa a varredura suave mesmo em cooldowns curtos (Eagles, 15 s); menos = mais leve.
  // Sem varredura, só o título muda (1/s).
  t.interval = setInterval(() => tick(context), fps > 0 ? 1000 / fps : 1000);
}

function stopCooldown(context, restore = true) {
  const t = timers.get(context);
  if (!t) return;
  clearInterval(t.interval);
  timers.delete(context);
  if (restore) {
    setTitle(context, '');
    setImage(context, t.strat.image);
  }
}

// ---- cliente WebSocket mínimo (RFC 6455, só texto, frames mascarados)
let sock = null;
let rx = Buffer.alloc(0);
let open = false;

function frame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x81, 0x80 | len])
    : len < 65536 ? Buffer.from([0x81, 0x80 | 126, len >> 8, len & 255])
      : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
  const mask = crypto.randomBytes(4);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

function send(obj) {
  if (open) sock.write(frame(JSON.stringify(obj)));
}

function control(op, data) {
  const mask = crypto.randomBytes(4);
  const body = Buffer.from(data.map((b, i) => b ^ mask[i & 3]));
  sock.write(Buffer.concat([Buffer.from([0x80 | op, 0x80 | data.length]), mask, body]));
}

let fragments = [];
function parseFrames() {
  for (;;) {
    if (rx.length < 2) return;
    const fin = (rx[0] & 0x80) !== 0;
    const op = rx[0] & 0x0f;
    let len = rx[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (rx.length < 4) return; len = rx.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (rx.length < 10) return; len = Number(rx.readBigUInt64BE(2)); off = 10; }
    const masked = (rx[1] & 0x80) !== 0;
    const maskKey = masked ? rx.subarray(off, off + 4) : null;
    if (masked) off += 4;
    if (rx.length < off + len) return;
    let data = Buffer.from(rx.subarray(off, off + len));
    rx = rx.subarray(off + len);
    if (masked) for (let i = 0; i < data.length; i++) data[i] ^= maskKey[i & 3];

    if (op === 0x8) { log('servidor fechou a conexão'); process.exit(0); }
    if (op === 0x9) { control(0xA, [...data]); continue; } // ping -> pong
    if (op === 0x1 || op === 0x2 || op === 0x0) {
      fragments.push(data);
      if (fin) {
        const text = Buffer.concat(fragments).toString('utf8');
        fragments = [];
        try { onMessage(JSON.parse(text)); } catch (e) { log('mensagem inválida', e.message); }
      }
    }
  }
}

function connect() {
  const port = Number(args.port);
  const key = crypto.randomBytes(16).toString('base64');
  sock = net.connect(port, '127.0.0.1', () => {
    sock.write([
      'GET / HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '', '',
    ].join('\r\n'));
  });
  let handshake = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    if (!open) {
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = handshake.subarray(0, end).toString();
      const expected = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC11B9A').digest('base64');
      if (!/^HTTP\/1\.1 101/.test(head)) {
        log('handshake recusado:', head.split('\r\n')[0]);
        process.exit(1);
      }
      if (!head.includes(expected)) log('aviso: Sec-WebSocket-Accept inesperado:', JSON.stringify(head));
      open = true;
      rx = handshake.subarray(end + 4);
      send({ event: args.registerEvent, uuid: args.pluginUUID });
      send({ event: 'getGlobalSettings', context: args.pluginUUID });
      log('registrado no app, porta', port);
      parseFrames();
      return;
    }
    rx = Buffer.concat([rx, chunk]);
    parseFrames();
  });
  sock.on('close', () => { log('conexão encerrada'); process.exit(0); });
  sock.on('error', (e) => { log('erro de conexão', e.message); process.exit(1); });
}

// ---- eventos do app
function onMessage(msg) {
  switch (msg.event) {
    case 'keyDown': {
      const strat = byUuid.get(msg.action);
      if (strat) runStratagem(strat, msg.context);
      else log('ação desconhecida', msg.action);
      break;
    }
    case 'willAppear':
      // Botão apareceu (app aberto, troca de página): retoma a contagem ou limpa o título.
      if (armed && armed.context === msg.context) {
        setTitle(msg.context, THROW_TITLE);
        redraw(msg.context);
      } else if (timers.has(msg.context)) {
        redraw(msg.context);
      } else if (byUuid.has(msg.action)) {
        setTitle(msg.context, '');
        // Reaplica o ícone atual do plugin: o app pode guardar uma versão antiga da imagem do botão.
        setImage(msg.context, byUuid.get(msg.action).image);
      }
      break;
    case 'didReceiveGlobalSettings':
      // O arquivo local tem prioridade; as configurações do app só valem na primeira vez.
      if (!loadSettingsFile()) globalSettings = { ...DEFAULTS, ...migrate(msg.payload && msg.payload.settings) };
      log('configurações', JSON.stringify(effectiveSettings()));
      break;
    case 'sendToPlugin':
      // O painel de configurações envia as opções novas; guardamos como configuração global.
      if (msg.payload && msg.payload.settings) {
        globalSettings = { ...globalSettings, ...msg.payload.settings };
        globalSettings = effectiveSettings();
        send({ event: 'setGlobalSettings', context: args.pluginUUID, payload: globalSettings });
        saveSettingsFile(globalSettings);
        log('configurações salvas', JSON.stringify(effectiveSettings()));
      }
      // Responde ao painel com as configurações e o cooldown deste botão (base e com melhorias).
      if (msg.payload && (msg.payload.request === 'getSettings' || msg.payload.settings)) {
        const strat = byUuid.get(msg.action) || {};
        send({ event: 'sendToPropertyInspector', action: msg.action, context: msg.context,
          payload: { settings: effectiveSettings(), code: strat.code, name: strat.name,
            cooldownBase: strat.cooldown || 0, cooldown: strat.cooldown ? cooldownFor(strat) : 0,
            callTime: strat.cooldown ? callTimeFor(strat) : 0 } });
      }
      if (msg.payload && msg.payload.request === 'test') {
        const strat = byUuid.get(msg.action);
        if (strat) setTimeout(() => runStratagem(strat, msg.context), 3000);
      }
      break;
    default:
      break;
  }
}

log('iniciando, argumentos:', JSON.stringify({ port: args.port, uuid: args.pluginUUID, event: args.registerEvent }));
startHelper();
connect();
