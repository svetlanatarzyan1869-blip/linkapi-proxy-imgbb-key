// /api/generate.js – возвращает изображение напрямую, с кэшированием (без редиректа)

import Redis from 'ioredis';

const DEFAULT_IMGBB_KEY = '9b18b658da2d84f03f07d19da36eb17d';
const redis = new Redis(process.env.REDIS_URL);

function getCacheKey(userId, prompt, characters, style) {
  let charactersArray = [];
  if (characters) {
    try {
      charactersArray = JSON.parse(characters);
      charactersArray.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {}
  }
  const dataToHash = JSON.stringify({ prompt, characters: charactersArray, style });
  const hashedData = Buffer.from(dataToHash).toString('base64');
  return `img:${userId}:${hashedData}`;
}

async function fetchImageAsBase64(url) {
  const response = await fetch(url);
  if (!response.ok) return null;
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const contentType = response.headers.get('content-type') || 'image/jpeg';
  return { base64, contentType };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');

  const startTime = Date.now();

  try {
    const {
      key, prompt, characters, style,
      model = 'gemini-3.1-flash-image-preview',
      imgbb_key = DEFAULT_IMGBB_KEY,
      userId
    } = req.query;

    if (!key) return res.status(400).send('Missing key');
    if (!prompt) return res.status(400).send('Missing prompt');
    if (!userId) return res.status(400).send('Missing userId');

    const cacheKey = getCacheKey(userId, prompt, characters, style);
    console.log(`🔍 Проверка кэша: ${cacheKey}`);

    let imageUrl = null;
    try {
      imageUrl = await redis.get(cacheKey);
    } catch (e) {
      console.warn('Redis read error:', e.message);
    }

    if (imageUrl && typeof imageUrl === 'string') {
      console.log(`✅ КЭШ! Берём из кэша: ${imageUrl}`);
      const imgResponse = await fetch(imageUrl);
      if (!imgResponse.ok) throw new Error(`Failed to fetch cached image: ${imgResponse.status}`);
      const arrayBuffer = await imgResponse.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      res.setHeader('Content-Type', imgResponse.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('X-Cache-Status', 'HIT');
      res.setHeader('X-Time-Taken', `${Date.now() - startTime}ms`);
      return res.status(200).send(buffer);
    }

    console.log(`❌ КЭШ ПРОМАХ. Генерируем новое изображение...`);

    // --- Подготовка запроса к LinkAPI ---
    let charactersArray = [];
    if (characters) {
      try {
        charactersArray = JSON.parse(characters);
      } catch (e) {}
    }

    const messages = [{
      role: "user",
      content: [{ type: "text", text: prompt }]
    }];

    for (const char of charactersArray) {
      if (!char.url) continue;
      const { base64, contentType } = await fetchImageAsBase64(char.url);
      if (base64) {
        messages[0].content.push({
          type: "image_url",
          image_url: { url: `data:${contentType};base64,${base64}` }
        });
      }
    }

    const linkapiRes = await fetch('https://api.linkapi.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model, messages, style })
    });

    if (!linkapiRes.ok) {
      const errorText = await linkapiRes.text();
      throw new Error(`LinkAPI error (${linkapiRes.status}): ${errorText}`);
    }

    const linkapiData = await linkapiRes.json();
    let base64Image = linkapiData.data?.b64_json || linkapiData.b64_json || linkapiData.image;

    if (!base64Image && linkapiData.choices?.[0]?.message?.content) {
      const content = linkapiData.choices[0].message.content;
      const match = content.match(/data:image\/[^;]+;base64,([a-zA-Z0-9+/=]+)/);
      if (match) base64Image = match[1];
    }

    if (!base64Image) throw new Error('LinkAPI не вернул base64');
    base64Image = base64Image.replace(/^data:image\/\w+;base64,/, '').replace(/\s/g, '');

    // --- Загрузка на ImgBB ---
    const imgbbForm = new FormData();
    imgbbForm.append('key', imgbb_key);
    imgbbForm.append('image', base64Image);
    imgbbForm.append('name', `generated_${Date.now()}`);

    const imgbbRes = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: imgbbForm });
    const imgbbData = await imgbbRes.json();
    if (!imgbbRes.ok || !imgbbData.success) throw new Error(`ImgBB error: ${imgbbData.error?.message}`);
    imageUrl = imgbbData.data.url;

    console.log(`💾 Сохраняем URL в кэш: ${cacheKey}`);
    try {
      await redis.set(cacheKey, imageUrl, 'EX', 604800);
    } catch (e) {
      console.warn('Redis write error:', e.message);
    }

    // --- Отдаём изображение напрямую ---
    const finalImageResponse = await fetch(imageUrl);
    if (!finalImageResponse.ok) throw new Error('Failed to fetch generated image');
    const arrayBuffer = await finalImageResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    res.setHeader('Content-Type', finalImageResponse.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('X-Cache-Status', 'MISS');
    res.setHeader('X-Time-Taken', `${Date.now() - startTime}ms`);
    return res.status(200).send(buffer);

  } catch (error) {
    console.error('❌ Ошибка:', error);
    return res.status(500).send(`Proxy error: ${error.message}`);
  }
}
