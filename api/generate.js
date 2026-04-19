// /api/generate.js – финальная версия с поддержкой стилей из data/styles.json, Redis и кэшем

import Redis from 'ioredis';
import fs from 'fs';
import path from 'path';

const DEFAULT_IMGBB_KEY = '9b18b658da2d84f03f07d19da36eb17d';

// --- Загрузка словаря стилей из JSON файла ---
let styleMap = {};
try {
  const stylesPath = path.join(process.cwd(), 'data', 'styles.json');
  if (fs.existsSync(stylesPath)) {
    const stylesContent = fs.readFileSync(stylesPath, 'utf-8');
    styleMap = JSON.parse(stylesContent);
    console.log(`✅ Загружено ${Object.keys(styleMap).length} стилей`);
  } else {
    console.warn('⚠️ data/styles.json не найден, стили не будут заменяться');
  }
} catch (err) {
  console.warn('❌ Ошибка загрузки стилей:', err.message);
}

// --- Подключение к Redis ---
const redisUrl = process.env.REDIS_URL || process.env.KV_URL;
let redis = null;
if (redisUrl) {
  redis = new Redis(redisUrl);
  redis.on('error', (err) => console.warn('Redis connection error:', err.message));
  console.log('✅ Redis подключён');
} else {
  console.warn('⚠️ Redis URL не задан, кэширование отключено');
}

// --- Вспомогательная функция для ключа кэша ---
function getCacheKey(userId, prompt, characters, style) {
  let charactersArray = [];
  if (characters) {
    try {
      charactersArray = JSON.parse(characters);
      charactersArray.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {}
  }
  const dataToHash = JSON.stringify({ userId, prompt, characters: charactersArray, style });
  const hashedData = Buffer.from(dataToHash).toString('base64');
  return `img:${hashedData}`;
}

// --- Основной обработчик ---
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');

  const startTime = Date.now();

  try {
    let { key, prompt, characters, style, model = 'gemini-3.1-flash-image-preview', imgbb_key, userId } = req.query;
    if (!key) return res.status(400).send('Missing required parameter: key');
    if (!prompt) return res.status(400).send('Missing required parameter: prompt');
    if (!userId) return res.status(400).send('Missing required parameter: userId'); // можно сделать необязательным, если не нужен

    const finalImgbbKey = imgbb_key || DEFAULT_IMGBB_KEY;

    // --- Замена короткого названия стиля на полный промт ---
    if (style && styleMap[style.toLowerCase()]) {
      const original = style;
      style = styleMap[style.toLowerCase()];
      console.log(`🎨 Замена стиля: "${original}" → полный промт (${style.length} символов)`);
    } else if (style) {
      console.log(`🎨 Стиль "${style}" не найден в словаре, отправляем как есть`);
    }

    // --- Кэш: проверяем, есть ли уже URL ---
    const cacheKey = getCacheKey(userId, prompt, characters, style);
    let cachedUrl = null;
    if (redis) {
      try {
        cachedUrl = await redis.get(cacheKey);
      } catch (e) {
        console.warn('Redis read error:', e.message);
      }
    }

    if (cachedUrl && typeof cachedUrl === 'string') {
      console.log(`✅ КЭШ! Редирект на ${cachedUrl}`);
      res.setHeader('X-Cache-Status', 'HIT');
      res.setHeader('X-Time-Taken', `${Date.now() - startTime}ms`);
      return res.redirect(302, cachedUrl);
    }

    console.log(`❌ КЭШ ПРОМАХ. Генерация...`);

    // --- Парсим персонажей ---
    let charactersArray = [];
    if (characters) {
      try {
        charactersArray = JSON.parse(characters);
        console.log(`👥 Персонажи: ${charactersArray.map(c => c.name).join(', ')}`);
      } catch (e) {
        console.warn('Failed to parse characters:', e.message);
      }
    }

    // --- Формируем запрос к LinkAPI ---
    const messages = [{
      role: "user",
      content: [{ type: "text", text: prompt }]
    }];

    // Скачиваем референсы и конвертируем в base64
    for (const char of charactersArray) {
      if (!char.url) continue;
      try {
        console.log(`📥 Скачиваю референс: ${char.name}`);
        const imgRes = await fetch(char.url);
        if (!imgRes.ok) continue;
        const buffer = await imgRes.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        messages[0].content.push({
          type: "image_url",
          image_url: { url: `data:${contentType};base64,${base64}` }
        });
        console.log(`✅ Референс ${char.name} добавлен`);
      } catch (err) {
        console.warn(`❌ Ошибка при обработке ${char.name}:`, err.message);
      }
    }

    // --- Запрос к LinkAPI ---
    const linkapiRes = await fetch('https://api.linkapi.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        style: style
      })
    });

    if (!linkapiRes.ok) {
      const errorText = await linkapiRes.text();
      throw new Error(`LinkAPI error (${linkapiRes.status}): ${errorText}`);
    }

    const linkapiData = await linkapiRes.json();

    // Извлекаем base64
    let base64Image = linkapiData.data?.b64_json ||
                      linkapiData.b64_json ||
                      linkapiData.image;

    if (!base64Image && linkapiData.choices?.[0]?.message?.content) {
      const content = linkapiData.choices[0].message.content;
      const match = content.match(/data:image\/[^;]+;base64,([a-zA-Z0-9+/=]+)/);
      if (match) base64Image = match[1];
    }

    if (!base64Image) throw new Error('LinkAPI не вернул base64');

    base64Image = base64Image.replace(/^data:image\/\w+;base64,/, '').replace(/\s/g, '');

    // --- Загрузка на ImgBB ---
    const imgbbForm = new FormData();
    imgbbForm.append('key', finalImgbbKey);
    imgbbForm.append('image', base64Image);
    imgbbForm.append('name', `generated_${Date.now()}`);

    const imgbbRes = await fetch('https://api.imgbb.com/1/upload', {
      method: 'POST',
      body: imgbbForm
    });

    const imgbbData = await imgbbRes.json();
    if (!imgbbRes.ok || !imgbbData.success) {
      throw new Error(`ImgBB error: ${imgbbData.error?.message}`);
    }

    const imageUrl = imgbbData.data.url;
    console.log(`💾 Сохраняем в кэш: ${cacheKey} -> ${imageUrl}`);

    // --- Сохраняем URL в Redis на 7 дней ---
    if (redis) {
      try {
        await redis.set(cacheKey, imageUrl, 'EX', 604800);
      } catch (e) {
        console.warn('Redis write error:', e.message);
      }
    }

    res.setHeader('X-Cache-Status', 'MISS');
    res.setHeader('X-Time-Taken', `${Date.now() - startTime}ms`);
    console.log(`✅ Редирект на ${imageUrl}`);
    return res.redirect(302, imageUrl);

  } catch (error) {
    console.error('❌ Ошибка:', error);
    return res.status(500).send(`Proxy error: ${error.message}`);
  } }
