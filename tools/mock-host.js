// Teste de ponta a ponta sem o app: simula o Stream Dock (servidor WebSocket), inicia o plugin
// com o Node do fifine Control Deck, envia keyDown de uma ação e espera showOk/showAlert.
// Uso: node mock-host.js <node.exe> <pasta-do-plugin> <uuid-da-acao> [<uuid-da-acao> ...]
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const [, , nodeExe, pluginDir, ...actions] = process.argv;
const results = [];
let clicked = false;
let imgCount = 0;

function frame(text) {
  const p = Buffer.from(text);
  const head = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([head, p]);
}

function readFrames(state, onText) {
  for (;;) {
    const b = state.buf;
    if (b.length < 2) return;
    let len = b[1] & 0x7f; let off = 2;
    if (len === 126) { len = b.readUInt16BE(2); off = 4; }
    const mask = b.subarray(off, off + 4); off += 4;
    if (b.length < off + len) return;
    const data = Buffer.from(b.subarray(off, off + len));
    for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
    state.buf = b.subarray(off + len);
    if ((b[0] & 0x0f) === 1) onText(data.toString());
  }
}

const server = net.createServer((sock) => {
  const state = { buf: Buffer.alloc(0), open: false };
  sock.on('data', (chunk) => {
    if (!state.open) {
      const req = chunk.toString();
      const key = req.match(/Sec-WebSocket-Key: (.+)\r\n/)[1];
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC11B9A').digest('base64');
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      state.open = true;
      return;
    }
    state.buf = Buffer.concat([state.buf, chunk]);
    readFrames(state, (text) => {
      const msg = JSON.parse(text);
      if (msg.event === 'setImage') {
        const img = msg.payload.image;
        if (process.env.MOCK_SAVE_DIR) {
          // Salva cada imagem recebida, numerada, para inspeção.
          imgCount++;
          require('fs').writeFileSync(path.join(process.env.MOCK_SAVE_DIR, `${msg.context}-${String(imgCount).padStart(3, '0')}.png`),
            Buffer.from(img.split(',')[1], 'base64'));
        } else {
          console.log('plugin -> setImage', msg.context, `${img.slice(0, 22)}... (${img.length} chars)`);
        }
      } else {
        console.log('plugin ->', text);
      }
      if (msg.event === 'registerPlugin') {
        const settings = JSON.parse(process.env.MOCK_SETTINGS || '{}');
        sock.write(frame(JSON.stringify({ event: 'didReceiveGlobalSettings', payload: { settings } })));
        // Simula o painel de configurações pedindo as informações do primeiro botão.
        if (process.env.MOCK_PI === '1') {
          sock.write(frame(JSON.stringify({ event: 'sendToPlugin', action: actions[0], context: 'pi0',
            payload: { request: 'getSettings' } })));
        }
        // Roteiro opcional: MOCK_SCRIPT='[{"at":500,"do":"key:0"},{"at":900,"do":"down"},...]'
        // do = key:<índice da ação> | click | down | up | ctrl
        if (process.env.MOCK_SCRIPT) {
          for (const step of JSON.parse(process.env.MOCK_SCRIPT)) {
            setTimeout(() => {
              if (step.do.startsWith('key:')) {
                const i = Number(step.do.slice(4));
                console.log('host -> keyDown', actions[i]);
                sock.write(frame(JSON.stringify({ event: 'keyDown', action: actions[i], context: `ctx${i}`, payload: { settings: {} } })));
                return;
              }
              console.log('host ->', step.do);
              const flag = { click: [], down: ['-Down'], up: ['-Up'], ctrl: ['-Ctrl'] }[step.do];
              spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                path.join(__dirname, 'fake-click.ps1'), ...flag], { stdio: 'inherit' });
            }, step.at);
          }
          return;
        }
        // dá tempo para o auxiliar PowerShell iniciar e então "aperta" as teclas do deck
        actions.forEach((a, i) => setTimeout(() => {
          console.log('host -> keyDown', a);
          sock.write(frame(JSON.stringify({ event: 'keyDown', action: a, context: `ctx${i}`, payload: { settings: {} } })));
        }, 500 + i * Number(process.env.MOCK_GAP || 100)));
      }
      results.push(`${msg.context}:${msg.event}`);
      // Cenário de arremesso: quando o botão indicado mostrar "LANCE", simula o clique.
      if (msg.event === 'setTitle' && msg.payload.title === 'LANCE' && msg.context === process.env.MOCK_CLICK_CTX
          && !clicked) {
        clicked = true;
        setTimeout(() => {
          console.log('host -> clique simulado');
          spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            path.join(__dirname, 'fake-click.ps1')], { stdio: 'inherit' });
        }, 1000);
      }
    });
  });
});

// Encerra após alguns segundos (tempo para ver o timer contar).
const RUN_MS = Number(process.env.MOCK_RUN_MS || 6000);
setTimeout(() => {
  console.log('FIM');
  if (plugin) plugin.kill();
  process.exit(0);
}, RUN_MS);

let plugin;
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  plugin = spawn(nodeExe, [path.join(pluginDir, 'plugin', 'index.js'),
    '-port', String(port), '-pluginUUID', 'TESTUUID', '-registerEvent', 'registerPlugin', '-info', '{}'],
  { stdio: 'inherit' });
});
