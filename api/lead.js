// Vercel Serverless Function: приймає заявку з форми сайту й надсилає її в Telegram.
// Токен і chat id беруться ТІЛЬКИ зі змінних середовища Vercel (в код сайту вони не потрапляють).
//   TELEGRAM_BOT_TOKEN  — токен від @BotFather
//   TELEGRAM_CHAT_ID    — id чату (можна кілька через кому: 123456789,-1001234567890)

const hits = new Map(); // простий ліміт запитів з однієї адреси (в межах одного екземпляра функції)
const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 5;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10 && d[0] === '0') d = '38' + d;
  if (d.length === 12 && d.startsWith('380')) {
    return { digits: '+' + d, pretty: `+38 (${d.slice(2, 5)}) ${d.slice(5, 8)}-${d.slice(8, 10)}-${d.slice(10, 12)}` };
  }
  return null;
}

function parseBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
  return b && typeof b === 'object' ? b : null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method' });
  }

  // приймаємо запити лише з цього ж сайту
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.headers.host; } catch { ok = false; }
    if (!ok) return res.status(403).json({ ok: false, error: 'origin' });
  }

  // ліміт: не більше MAX_HITS заявок за 10 хвилин з однієї адреси
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'ip').split(',')[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_HITS) return res.status(429).json({ ok: false, error: 'rate' });
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();

  const body = parseBody(req);
  if (!body) return res.status(400).json({ ok: false, error: 'body' });

  // «медова пастка» для ботів: приховане поле має бути порожнім
  if (body.website) return res.status(200).json({ ok: true });

  const name = String(body.name || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 50);
  const phone = normPhone(body.phone);
  if (!name || !phone) return res.status(400).json({ ok: false, error: 'invalid' });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chats = String(process.env.TELEGRAM_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!token || !chats.length) {
    console.error('lead: не задано TELEGRAM_BOT_TOKEN або TELEGRAM_CHAT_ID');
    return res.status(500).json({ ok: false, error: 'not_configured' });
  }

  const when = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', dateStyle: 'short', timeStyle: 'short' });
  const lang = body.lang === 'en' ? 'EN' : 'UA';
  const text =
    '🦷 <b>Нова заявка з сайту</b>\n\n' +
    `👤 Ім'я: <b>${esc(name)}</b>\n` +
    `📞 Телефон: <a href="tel:${phone.digits}">${esc(phone.pretty)}</a>\n` +
    `🌐 Мова сайту: ${lang}\n` +
    `🕐 ${esc(when)} (Київ)`;

  const send = async (chat_id) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: ctrl.signal,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) console.error('lead: Telegram відхилив запит', r.status, j.description || '');
      return r.ok && j.ok;
    } catch (e) {
      console.error('lead: помилка мережі до Telegram', e && e.name);
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  const results = await Promise.all(chats.map(send));
  if (!results.some(Boolean)) return res.status(502).json({ ok: false, error: 'telegram' });
  return res.status(200).json({ ok: true });
};
