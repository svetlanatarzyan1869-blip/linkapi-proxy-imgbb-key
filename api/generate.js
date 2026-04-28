// api/generate.js
import Redis from 'ioredis';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

// ---------- Расшифровка ----------
function decryptData(encryptedBase64, secretKeyBase64) {
  try {
    const [ivBase64, encryptedBase64Data] = encryptedBase64.split(':');
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

// ---------- Загрузка стилей из styles.json ----------
let styleMap = {};
try {
  styleMap = require('./styles.json');
  console.log(`✅ [1/9] Загружено стилей: ${Object.keys(styleMap).length}`);
} catch (err) {
  console.error('❌ [1/9] Ошибка загрузки styles.json:', err.message);
  throw new Error('styles.json not found or invalid');
}

// ---------- Redis (опционально) ----------
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
    let key, prompt, charactersRaw, imgbb_key;

    // ---- Получение параметров: либо из data (зашифрованные), либо из query (устаревший режим) ----
    if (req.query.data && encryptionKey) {
      const decrypted = decryptData(req.query.data, encryptionKey);
      if (decrypted && typeof decrypted === 'object') {
        key = decrypted.key;
        prompt = decrypted.prompt;
        charactersRaw = decrypted.characters;
        imgbb_key = decrypted.imgbb_key;
        console.log('✅ [3/9] Данные расшифрованы');
      } else {
        console.error('❌ [3/9] Ошибка расшифровки');
        return res.status(400).send('Invalid encrypted data');
      }
    } else {
      // fallback для старых версий (без шифрования) – не рекомендуется
      key = req.query.key;
      prompt = req.query.prompt;
      charactersRaw = req.query.characters;
      imgbb_key = req.query.imgbb_key;
      console.log('⚠️ [3/9] Используется незашифрованный запрос (устаревший)');
    }

    const userId = req.query.userId;
    const style = req.query.style;
    const model = req.query.model || 'gemini-3.1-flash-image-preview';

    // Проверка обязательных параметров
    if (!key || !prompt || !userId) {
      console.error('❌ [3/9] Отсутствуют key, prompt или userId');
      return res.status(400).send('Missing key, prompt, or userId');
    }
    if (!imgbb_key) {
      console.error('❌ [3/9] Отсутствует imgbb_key');
      return res.status(400).send('Missing imgbb_key');
    }

    console.log(`✅ [3/9] Параметры получены (userId: ${userId})`);

    // ---- Обработка стиля: если нет или не найден → kodak_portra_400 ----
    let finalStyle = style;
    if (style && styleMap[style.toLowerCase()]) {
      finalStyle = styleMap[style.toLowerCase()];
      console.log(`🎨 [4/9] Стиль "${style}" заменён`);
    } else {
      const defaultStyleName = 'kodak_portra_400';
      if (styleMap[defaultStyleName]) {
        finalStyle = styleMap[defaultStyleName];
        console.log(`🎨 [4/9] Стиль не указан или не найден, использован ${defaultStyleName}`);
      } else {
        console.error(`❌ [4/9] Стиль по умолчанию ${defaultStyleName} не найден в styles.json`);
        return res.status(500).send('Default style missing');
      }
    }

    const fullPrompt = `${finalStyle}\n\n${prompt}`;
    const messages = [{ role: "user", content: [{ type: "text", text: fullPrompt }] }];

    // ---- Кэш ----
    const cacheKey = getCacheKey(userId, prompt, charactersRaw, finalStyle);
    let cachedUrl = null;
    if (redis) {
      console.log('🔄 [5/9] Проверка кэша...');
      try { cachedUrl = await redis.get(cacheKey); } catch(e) { console.warn('Redis error:', e.message); }
    } else {
      console.log('⚠️ [5/9] Redis не настроен, кэш отключён');
    }

    if (cachedUrl && typeof cachedUrl === 'string') {
      console.log(`✅ [5/9] Кэш попадание (ссылка скрыта)`);
      return res.redirect(302, cachedUrl);
    }
    console.log('❌ [5/9] Кэш промах, генерация');

    // ---- Референсы персонажей ----
    let chars = [];
    try { chars = JSON.parse(charactersRaw || '[]'); } catch(e) { console.warn('Ошибка парсинга characters'); }
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
        console.log(`   ✅ Референс "${c.name}" загружен`);
      } catch(e) {
        console.warn(`   ⚠️ "${c.name}": ${e.message}`);
      }
    }

    // ---- LinkAPI ----
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

    // ---- ImgBB (обязательный ключ) ----
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
    console.log(`✅ [8/9] Изображение готово (ссылка скрыта)`);

    // ---- Сохранение в кэш ----
    if (redis) {
      try {
        await redis.set(cacheKey, imageUrl, 'EX', 604800);
        console.log(`💾 [9/9] Сохранено в кэш`);
      } catch(e) { console.warn('Redis set error:', e.message); }
    }

    // Редирект на изображение
    return res.redirect(302, imageUrl);
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    return res.status(500).send(`Proxy error: ${err.message}`);
  }
}
