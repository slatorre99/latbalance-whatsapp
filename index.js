import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import express from 'express';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import pino from 'pino';
import { existsSync, mkdirSync } from 'fs';

const logger = pino({ level: 'silent' });
const app = express();
app.use(express.json());

const AUTH_DIR = './auth_info';
if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR);

const API_KEY = process.env.API_KEY ?? 'latbalance-secret';
const PORT = process.env.PORT ?? 3001;

let sock = null;
let connectionStatus = 'disconnected'; // 'connecting' | 'open' | 'disconnected'
let lastQR = null;

// ─── Baileys connection ───────────────────────────────────────────────────────

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    browser: ['LatBalance', 'Chrome', '1.0.0'],
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      lastQR = qr;
      console.log('\n📱 Escanea este QR en: ' + (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'http://localhost:' + PORT) + '/qr\n');
      qrcode.generate(qr, { small: true });
      connectionStatus = 'connecting';
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected';
      const shouldReconnect =
        lastDisconnect?.error instanceof Boom &&
        lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut;

      console.log('Conexión cerrada:', lastDisconnect?.error?.message ?? 'desconocido');

      if (shouldReconnect) {
        console.log('Reconectando...');
        setTimeout(connectToWhatsApp, 3000);
      } else {
        console.log('Sesión cerrada (logged out). Reinicia el servidor y escanea el QR de nuevo.');
      }
    }

    if (connection === 'open') {
      connectionStatus = 'open';
      console.log('✅ WhatsApp conectado');
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizePhone(phone) {
  // Quita espacios, guiones, paréntesis
  let n = phone.replace(/[\s\-().+]/g, '');
  // Si empieza con 0, remover
  if (n.startsWith('0')) n = n.slice(1);
  // Si no tiene código de país, asumir Colombia (+57)
  if (n.length === 10) n = '57' + n;
  return n + '@s.whatsapp.net';
}

function authMiddleware(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/status', (req, res) => {
  res.json({ status: connectionStatus });
});

app.get('/qr', async (req, res) => {
  if (connectionStatus === 'open') {
    return res.send('<html><body style="background:#111;color:#0f0;font-family:sans-serif;text-align:center;padding:60px"><h2>✅ WhatsApp ya está conectado</h2></body></html>');
  }
  if (!lastQR) {
    return res.send('<html><body style="background:#111;color:#fff;font-family:sans-serif;text-align:center;padding:60px"><h2>⏳ Esperando QR... recarga en unos segundos</h2><script>setTimeout(()=>location.reload(),3000)</script></body></html>');
  }
  const imgData = await QRCode.toDataURL(lastQR, { width: 400, margin: 2 });
  res.send(`<html><body style="background:#111;color:#fff;font-family:sans-serif;text-align:center;padding:40px">
    <h2>📱 Escanea con WhatsApp</h2>
    <p style="color:#aaa">WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
    <img src="${imgData}" style="border-radius:12px;margin:20px auto;display:block"/>
    <p style="color:#555;font-size:12px">El QR expira cada ~20 segundos. Si no funciona, recarga la página.</p>
    <script>setTimeout(()=>location.reload(),18000)</script>
  </body></html>`);
});

app.post('/send', authMiddleware, async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ error: 'phone y message son requeridos' });
  }

  if (connectionStatus !== 'open') {
    return res.status(503).json({ error: 'WhatsApp no está conectado', status: connectionStatus });
  }

  try {
    const jid = normalizePhone(String(phone));
    await sock.sendMessage(jid, { text: message });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error enviando mensaje:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 WhatsApp service corriendo en puerto ${PORT}`);
  console.log(`   API_KEY: ${API_KEY}\n`);
});

connectToWhatsApp();
