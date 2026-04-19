// /api/generate.js – с кэшированием Redis (глобальный кэш, без userId)

import Redis from 'ioredis';

const DEFAULT_IMGBB_KEY = '9b18b658da2d84f03f07d19da36eb17d';
const redis = new Redis(process.env.REDIS_URL); // или KV_URL – Vercel обычно добавляет REDIS_URL

function getCacheKey(prompt, characters, style) {
  let charactersArray = [];
  if (characters) {
    try {
      charactersArray = JSON.parse(characters);
      charactersArray.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {}
  }
  const dataToHash = JSON.stringify({ prompt, characters: charactersArray, style });
  const hashedData = Buffer.from(dataToHash).toString('base64');
  return `img:${hashedData}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');

  try {
    const { key, prompt, characters, style, model = 'gemini-3.1-flash-image-preview', imgbb_key } = req.query;
    if (!key) return res.status(400).send('Missing required parameter: key');
    if (!prompt) return res.status(400).send('Missing required parameter: prompt');

    const finalImgbbKey = imgbb_key || DEFAULT_IMGBB_KEY;

    // --- КЭШ: проверяем, есть ли уже URL ---
    const cacheKey = getCacheKey(prompt, characters, style);
    let cachedUrl = null;
    try {
      cachedUrl = await redis.get(cacheKey);
    } catch (e) {
      console.warn('Redis read error:', e.message);
    }

    if (cachedUrl && typeof cachedUrl === 'string') {
      console.log(`✅ КЭШ: редирект на ${cachedUrl}`);
      return res.redirect(302, cachedUrl);
    }

    console.log(`❌ КЭШ ПРОМАХ. Генерация...`);

    // --- ДАЛЕЕ ВАШ ИСХОДНЫЙ КОД ГЕНЕРАЦИИ (без изменений) ---
    let charactersArray = [];
    if (characters) {
      try {
        charactersArray = JSON.parse(characters);
      } catch (e) {}
    }

    const messages = [{ role: "user", content: [{ type: "text", text: prompt }] }];

    for (const char of charactersArray) {
      if (!char.url) continue;
      try {
        const imgRes = await fetch(char.url);
        if (!imgRes.ok) continue;
        const buffer = await imgRes.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        messages[0].content.push({ type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } });
      } catch (err) {}
    }

    const linkapiRes = await fetch('https://api.linkapi.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model, messages, style })
    });

    if (!linkapiRes.ok) throw new Error(`LinkAPI error ${linkapiRes.status}`);
    const linkapiData = await linkapiRes.json();
    let base64Image = linkapiData.data?.b64_json || linkapiData.b64_json || linkapiData.image;
    if (!base64Image && linkapiData.choices?.[0]?.message?.content) {
      const match = linkapiData.choices[0].message.content.match(/data:image\/[^;]+;base64,([a-zA-Z0-9+/=]+)/);
      if (match) base64Image = match[1];
    }
    if (!base64Image) throw new Error('LinkAPI не вернул base64');
    base64Image = base64Image.replace(/^data:image\/\w+;base64,/, '').replace(/\s/g, '');

    const imgbbForm = new FormData();
    imgbbForm.append('key', finalImgbbKey);
    imgbbForm.append('image', base64Image);
    imgbbForm.append('name', `generated_${Date.now()}`);

    const imgbbRes = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: imgbbForm });
    const imgbbData = await imgbbRes.json();
    if (!imgbbRes.ok || !imgbbData.success) throw new Error(`ImgBB error: ${imgbbData.error?.message}`);
    const imageUrl = imgbbData.data.url;

    console.log(`💾 Сохраняем в кэш: ${cacheKey} -> ${imageUrl}`);
    try {
      await redis.set(cacheKey, imageUrl, 'EX', 604800);
    } catch (e) {
      console.warn('Redis write error:', e.message);
    }

    return res.redirect(302, imageUrl);
  } catch (error) {
    console.error('❌ Ошибка:', error);
    return res.status(500).send(`Proxy error: ${error.message}`);
  } }
