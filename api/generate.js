import Redis from 'ioredis';
import fs from 'fs';
import path from 'path';

const DEFAULT_IMGBB_KEY = '9b18b658da2d84f03f07d19da36eb17d';

let styleMap = {};
try {
  const stylesPath = path.join(process.cwd(), 'data', 'styles.json');
  if (fs.existsSync(stylesPath)) {
    styleMap = JSON.parse(fs.readFileSync(stylesPath, 'utf-8'));
    console.log(`✅ Loaded ${Object.keys(styleMap).length} styles`);
  } else {
    console.warn('⚠️ styles.json not found');
  }
} catch (err) {
  console.warn('❌ Style load error:', err.message);
}

const redisUrl = process.env.REDIS_URL || process.env.KV_URL;
let redis = null;
if (redisUrl) {
  redis = new Redis(redisUrl);
  redis.on('error', (err) => console.warn('Redis error:', err.message));
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

  const start = Date.now();
  try {
    let { key, prompt, characters, style, model = 'gemini-3.1-flash-image-preview', imgbb_key, userId } = req.query;
    if (!key || !prompt || !userId) return res.status(400).send('Missing key, prompt, or userId');

    const finalImgbbKey = imgbb_key || DEFAULT_IMGBB_KEY;

    // --- ЗАМЕНА СТИЛЯ ---
    if (style && styleMap[style.toLowerCase()]) {
      const original = style;
      style = styleMap[style.toLowerCase()];
      console.log(`🎨 Style replaced: "${original}" -> full prompt (${style.length} chars)`);
    } else if (style) {
      console.log(`⚠️ Style "${style}" not found in dictionary`);
    }

    const cacheKey = getCacheKey(userId, prompt, characters, style);
    let cachedUrl = null;
    if (redis) {
      try { cachedUrl = await redis.get(cacheKey); } catch(e) { console.warn(e); }
    }
    if (cachedUrl && typeof cachedUrl === 'string') {
      console.log(`✅ Cache HIT -> ${cachedUrl}`);
      return res.redirect(302, cachedUrl);
    }

    console.log(`❌ Cache MISS. Generating...`);

    let chars = [];
    try { chars = JSON.parse(characters || '[]'); } catch(e) {}
    const messages = [{ role: "user", content: [{ type: "text", text: prompt }] }];
    for (const c of chars) {
      if (!c.url) continue;
      try {
        const imgRes = await fetch(c.url);
        if (!imgRes.ok) continue;
        const buf = await imgRes.arrayBuffer();
        const base64 = Buffer.from(buf).toString('base64');
        const ct = imgRes.headers.get('content-type') || 'image/jpeg';
        messages[0].content.push({ type: "image_url", image_url: { url: `data:${ct};base64,${base64}` } });
      } catch(e) { console.warn(`Failed to fetch ${c.name}:`, e.message); }
    }

    const linkRes = await fetch('https://api.linkapi.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model, messages, style })
    });
    if (!linkRes.ok) throw new Error(`LinkAPI error ${linkRes.status}`);
    const linkData = await linkRes.json();
    let b64 = linkData.data?.b64_json || linkData.b64_json || linkData.image;
    if (!b64 && linkData.choices?.[0]?.message?.content) {
      const m = linkData.choices[0].message.content.match(/data:image\/[^;]+;base64,([a-zA-Z0-9+/=]+)/);
      if (m) b64 = m[1];
    }
    if (!b64) throw new Error('No image from LinkAPI');
    b64 = b64.replace(/^data:image\/\w+;base64,/, '').replace(/\s/g, '');

    const form = new FormData();
    form.append('key', finalImgbbKey);
    form.append('image', b64);
    form.append('name', `gen_${Date.now()}`);
    const imgRes = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
    const imgData = await imgRes.json();
    if (!imgRes.ok || !imgData.success) throw new Error(`ImgBB error: ${imgData.error?.message}`);
    const url = imgData.data.url;

    if (redis) {
      try { await redis.set(cacheKey, url, 'EX', 604800); } catch(e) { console.warn(e); }
    }

    console.log(`✅ Redirect to ${url}`);
    return res.redirect(302, url);
  } catch (err) {
    console.error(err);
    return res.status(500).send(`Error: ${err.message}`);
  }
}
