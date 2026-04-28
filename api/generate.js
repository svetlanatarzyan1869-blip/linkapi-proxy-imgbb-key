import Redis from 'ioredis';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const DEFAULT_IMGBB_KEY = '9b18b658da2d84f03f07d19da36eb17d';

// 1/9 Загрузка стилей
let styleMap = {};
try {
  styleMap = require('./styles.json');
  console.log(`✅ [1/9] Загружено стилей: ${Object.keys(styleMap).length}`);
} catch (err) {
  console.error('❌ [1/9] Ошибка styles.json:', err.message);
  styleMap = {
    serov: "Valentin Serov Russian Impressionist portrait oil painting style. Loose, fresh, confident brushwork. Soft diffused natural window light. Psychologically present face. Warm ivory skin tones with cool-grey shadow.",
    monet: "Claude Monet French Impressionism oil painting style. No hard outlines, broken comma-dab brushstrokes of pure pigment, coloured shadows in violet and blue, luminous natural light, vibrant pure palette.",
    manga_bw: "Black and white Japanese manga style. Pure black ink on white paper, no colour. Screentone dots for shading, bold variable-weight ink lines, speed lines, focus lines. High contrast, expressive faces."
  };
}

// Redis
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

    // Читаем параметры (сначала из заголовков от middleware, потом из query как fallback)
    const key = req.headers['x-key'] || req.query.key;
    const prompt = req.headers['x-prompt'] || req.query.prompt;
    const charactersRaw = req.headers['x-characters'] || req.query.characters;
    const style = req.query.style;
    const model = req.query.model || 'gemini-3.1-flash-image-preview';
    const imgbb_key = req.headers['x-imgbb_key'] || req.query.imgbb_key;
    const userId = req.query.userId; // видимый в URL

    if (!key || !prompt || !userId) {
      console.error('❌ [3/9] Отсутствуют key, prompt или userId');
      return res.status(400).send('Missing key, prompt, or userId');
    }
    console.log(`✅ [3/9] Параметры получены (userId: ${userId})`);

    const finalImgbbKey = imgbb_key || DEFAULT_IMGBB_KEY;

    // Стиль
    let finalStyle = style;
    if (style && styleMap[style.toLowerCase()]) {
      finalStyle = styleMap[style.toLowerCase()];
      console.log(`🎨 [4/9] Стиль "${style}" заменён`);
    } else if (style) {
      console.log(`⚠️ [4/9] Стиль "${style}" не найден, используется как есть`);
    } else {
      finalStyle = styleMap.serov;
      console.log(`🎨 [4/9] Стиль по умолчанию (Serov)`);
    }

    const fullPrompt = `${finalStyle}\n\n${prompt}`;
    const messages = [{ role: "user", content: [{ type: "text", text: fullPrompt }] }];

    // Кеш
    const cacheKey = getCacheKey(userId, prompt, charactersRaw, finalStyle);
    let cachedUrl = null;
    if (redis) {
      console.log('🔄 [5/9] Проверка кеша...');
      try { cachedUrl = await redis.get(cacheKey); } catch(e) { console.warn('Redis error:', e.message); }
    } else {
      console.log('⚠️ [5/9] Redis не настроен, кеш отключён');
    }

    if (cachedUrl && typeof cachedUrl === 'string') {
      console.log(`✅ [5/9] Кеш попадание (ссылка скрыта)`);
      return res.redirect(302, cachedUrl);
    }
    console.log('❌ [5/9] Кеш промах, генерация');

    // Референсы
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
    form.append('key', finalImgbbKey);
    form.append('image', b64);
    form.append('name', `gen_${Date.now()}`);
    const imgRes = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
    const imgData = await imgRes.json();
    if (!imgRes.ok || !imgData.success) {
      throw new Error(`ImgBB error: ${imgData.error?.message || 'unknown'}`);
    }
    const imageUrl = imgData.data.url;
    console.log(`✅ [8/9] Изображение готово (ссылка скрыта)`);

    // Кешируем
    if (redis) {
      try {
        await redis.set(cacheKey, imageUrl, 'EX', 604800);
        console.log(`💾 [9/9] Сохранено в кеш`);
      } catch(e) { console.warn('Redis set error:', e.message); }
    }

    // Редирект (ссылка не выводится в консоль)
    return res.redirect(302, imageUrl);
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    return res.status(500).send(`Proxy error: ${err.message}`);
  }
}
