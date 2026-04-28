// api/generate.js – шифруются только key и imgbb_key
import Redis from 'ioredis';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

function decryptData(encryptedBase64, secretKeyBase64) {
  try {
    let normalized = encryptedBase64.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
    const parts = normalized.split(':');
    if (parts.length !== 2) return null;
    const [ivBase64, encryptedBase64Data] = parts;
    const iv = Buffer.from(ivBase64, 'base64');
    const encrypted = Buffer.from(encryptedBase64Data, 'base64');
    const key = Buffer.from(secretKeyBase64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (err) {
    console.error('Decryption failed:', err.message);
    return null;
  }
}

// Загрузка стилей
let styleMap = {};
try {
  styleMap = require('./styles.json');
  console.log(`✅ [1/9] Загружено стилей: ${Object.keys(styleMap).length}`);
} catch (err) {
  console.error('❌ styles.json error:', err.message);
  throw new Error('styles.json missing');
}

// Redis (опционально)
const redisUrl = process.env.REDIS_URL || process.env.KV_URL;
let redis = null;
if (redisUrl) {
  redis = new Redis(redisUrl);
  redis.on('error', (err) => console.warn('Redis warning:', err.message));
}

function getCacheKey(userId, prompt, characters, style) {
  let chars = [];
  try { chars = JSON.parse(characters || '[]'); chars.sort((a,b)=>a.name.localeCompare(b.name)); } catch(e) {}
  const hash = Buffer.from(JSON.stringify({ userId, prompt, characters: chars, style })).toString('base64');
  return `img:${hash}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).end();

  try {
    console.log('🚀 [2/9] Начало запроса');
    const encryptionKey = process.env.ENCRYPTION_KEY;
    let key, imgbb_key;

    // Расшифровка только key и imgbb_key
    if (req.query.data && encryptionKey) {
      const decrypted = decryptData(req.query.data, encryptionKey);
      if (decrypted && typeof decrypted === 'object') {
        key = decrypted.key;
        imgbb_key = decrypted.imgbb_key;
        console.log('✅ [3/9] Данные расшифрованы');
      } else {
        console.error('❌ [3/9] Ошибка расшифровки');
        return res.status(400).send('Invalid encrypted data');
      }
    } else {
      // fallback старый
      key = req.query.key;
      imgbb_key = req.query.imgbb_key;
      console.log('⚠️ [3/9] Незашифрованный запрос');
    }

    // Открытые параметры
    const userId = req.query.userId;
    const prompt = req.query.prompt;
    const charactersRaw = req.query.characters;   // остаётся открытым
    const style = req.query.style;
    const model = req.query.model || 'gemini-3.1-flash-image-preview';

    if (!key || !prompt || !userId) {
      console.error('❌ [3/9] Отсутствуют key, prompt или userId');
      return res.status(400).send('Missing key, prompt, or userId');
    }
    if (!imgbb_key) {
      console.error('❌ [3/9] Отсутствует imgbb_key');
      return res.status(400).send('Missing imgbb_key');
    }
    console.log(`✅ [3/9] userId: ${userId}`);

    // Стиль
    let finalStyle = style;
    if (style && styleMap[style.toLowerCase()]) {
      finalStyle = styleMap[style.toLowerCase()];
      console.log(`🎨 [4/9] Стиль "${style}" заменён`);
    } else {
      const defaultStyle = 'kodak_portra_400';
      if (styleMap[defaultStyle]) {
        finalStyle = styleMap[defaultStyle];
        console.log(`🎨 [4/9] Стиль по умолчанию ${defaultStyle}`);
      } else {
        return res.status(500).send('Default style missing');
      }
    }

    const fullPrompt = `${finalStyle}\n\n${prompt}`;
    const messages = [{ role: "user", content: [{ type: "text", text: fullPrompt }] }];

    // Кэш
    const cacheKey = getCacheKey(userId, prompt, charactersRaw, finalStyle);
    let cachedUrl = null;
    if (redis) {
      console.log('🔄 [5/9] Проверка кэша...');
      try { cachedUrl = await redis.get(cacheKey); } catch(e) {}
    }
    if (cachedUrl) {
      console.log(`✅ [5/9] Кэш попадание`);
      return res.redirect(302, cachedUrl);
    }
    console.log('❌ [5/9] Кэш промах');

    // Референсы
    let chars = [];
    try { chars = JSON.parse(charactersRaw || '[]'); } catch(e) { console.warn('Ошибка characters'); }
    console.log(`📸 [6/9] Референсов: ${chars.length}`);
    for (const c of chars) {
      if (!c.url) continue;
      try {
        const imgRes = await fetch(c.url);
        if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
        const buf = await imgRes.arrayBuffer();
        const base64 = Buffer.from(buf).toString('base64');
        const ct = imgRes.headers.get('content-type') || 'image/jpeg';
        messages[0].content.push({ type: "image_url", image_url: { url: `data:${ct};base64,${base64}` } });
        console.log(`   ✅ ${c.name}`);
      } catch(e) {
        console.warn(`   ⚠️ ${c.name}: ${e.message}`);
      }
    }

    // LinkAPI
    console.log('🤖 [7/9] Запрос в LinkAPI...');
    const linkRes = await fetch('https://api.linkapi.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model, messages })
    });
    if (!linkRes.ok) {
      const errorText = await linkRes.text();
      throw new Error(`LinkAPI error ${linkRes.status}: ${errorText.slice(0, 100)}`);
    }
    console.log('✅ [7/9] LinkAPI ответил');

    const linkData = await linkRes.json();
    let b64 = linkData.data?.b64_json || linkData.b64_json || linkData.image;
    if (!b64 && linkData.choices?.[0]?.message?.content) {
      const match = linkData.choices[0].message.content.match(/data:image\/[^;]+;base64,([a-zA-Z0-9+/=]+)/);
      if (match) b64 = match[1];
    }
    if (!b64) throw new Error('Нет изображения от LinkAPI');
    b64 = b64.replace(/^data:image\/\w+;base64,/, '').replace(/\s/g, '');

    // ImgBB
    console.log('☁️ [8/9] Загрузка на ImgBB...');
    const form = new FormData();
    form.append('key', imgbb_key);
    form.append('image', b64);
    form.append('name', `gen_${Date.now()}`);
    const imgRes = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
    const imgData = await imgRes.json();
    if (!imgRes.ok || !imgData.success) {
      throw new Error(`ImgBB error: ${imgData.error?.message || 'unknown'}`);
    }
    const imageUrl = imgData.data.url;
    console.log(`✅ [8/9] Изображение готово`);

    if (redis) {
      try {
        await redis.set(cacheKey, imageUrl, 'EX', 604800);
        console.log(`💾 [9/9] Кэш сохранён`);
      } catch(e) {}
    }

    return res.redirect(302, imageUrl);
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    return res.status(500).send(`Proxy error: ${err.message}`);
  }
}
