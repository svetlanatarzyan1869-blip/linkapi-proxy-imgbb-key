// /api/generate.js – LinkAPI + ImgBB + In‑memory Cache с нормализацией параметров

const DEFAULT_IMGBB_KEY = '9b18b658da2d84f03f07d19da36eb17d';

// Простой in-memory кэш (живёт до перезапуска сервера)
const cache = new Map();

// Нормализация промпта: удаляем повторяющиеся стили, лишние пробелы, приводим к нижнему регистру
function normalizePrompt(prompt, style) {
    let normalized = prompt.trim().toLowerCase();
    // Если стиль уже есть в промпте, удаляем его, чтобы не дублировать
    if (style) {
        const styleLower = style.toLowerCase();
        normalized = normalized.replace(styleLower, '').replace(/,\s*,/g, ',').trim();
    }
    // Удаляем множественные пробелы
    normalized = normalized.replace(/\s+/g, ' ').trim();
    return normalized;
}

// Нормализация JSON персонажей: сортировка полей, удаление лишних пробелов
function normalizeCharacters(charactersStr) {
    if (!charactersStr) return '';
    try {
        let chars = JSON.parse(charactersStr);
        if (!Array.isArray(chars)) return charactersStr;
        // Сортируем по имени, чтобы порядок не влиял на ключ
        chars.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        // Убираем лишние поля (оставляем только name и url)
        const normalized = chars.map(({ name, url }) => ({ name: (name || '').trim(), url: (url || '').trim() }));
        return JSON.stringify(normalized);
    } catch (e) {
        console.warn('Failed to parse characters for normalization:', e.message);
        return charactersStr; // если не JSON, возвращаем как есть
    }
}

// Функция для создания ключа кэша из параметров
function getCacheKey(prompt, characters, style, model) {
    const normalizedPrompt = normalizePrompt(prompt, style);
    const normalizedCharacters = normalizeCharacters(characters);
    const str = `${normalizedPrompt}|${normalizedCharacters}|${(style || '').toLowerCase().trim()}|${(model || '').toLowerCase().trim()}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') return res.status(405).send('Method not allowed');

    try {
        const { 
            key, 
            prompt: rawPrompt, 
            characters: rawCharacters, 
            style, 
            model = 'gemini-3.1-flash-image-preview',
            imgbb_key
        } = req.query;

        if (!key) return res.status(400).send('Missing required parameter: key');
        if (!rawPrompt) return res.status(400).send('Missing required parameter: prompt');

        let finalImgbbKey = imgbb_key;
        if (!finalImgbbKey) {
            console.warn('imgbb_key not provided, using default');
            finalImgbbKey = DEFAULT_IMGBB_KEY;
        }

        // ------------------------------------------------------
        // 1️⃣ НОРМАЛИЗАЦИЯ И ПРОВЕРКА КЭША
        // ------------------------------------------------------
        const normalizedPrompt = normalizePrompt(rawPrompt, style);
        const normalizedCharacters = normalizeCharacters(rawCharacters);
        const cacheKey = getCacheKey(rawPrompt, rawCharacters, style, model);

        console.log('🔑 Ключ кэша:', cacheKey);
        console.log('📝 Нормализованный промпт:', normalizedPrompt);
        console.log('👥 Нормализованные персонажи:', normalizedCharacters);

        if (cache.has(cacheKey)) {
            const cachedUrl = cache.get(cacheKey);
            console.log(`📦 Возвращаем из кэша (${cacheKey}): ${cachedUrl}`);
            return res.redirect(302, cachedUrl);
        }

        console.log(`🆕 Нет в кэше (${cacheKey}), генерируем новое...`);

        // ------------------------------------------------------
        // 2️⃣ ПАРСИМ ПЕРСОНАЖЕЙ (используем оригинальные данные для запроса)
        // ------------------------------------------------------
        let charactersArray = [];
        if (rawCharacters) {
            try {
                charactersArray = JSON.parse(rawCharacters);
            } catch (e) {
                console.warn('Failed to parse characters:', e.message);
            }
        }

        console.log(`👥 Персонажи (исходные): ${charactersArray.map(c => c.name).join(', ')}`);

        // ------------------------------------------------------
        // 3️⃣ ЗАПРОС К LINKAPI
        // ------------------------------------------------------
        const messages = [{ 
            role: "user", 
            content: [{ type: "text", text: rawPrompt }] 
        }];

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

        // ------------------------------------------------------
        // 4️⃣ ЗАГРУЗКА НА IMGBB
        // ------------------------------------------------------
        console.log('📤 Отправка в ImgBB...');
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
        console.log('✅ Готово:', imageUrl);

        // ------------------------------------------------------
        // 5️⃣ СОХРАНЯЕМ В КЭШ И ВОЗВРАЩАЕМ РЕДИРЕКТ
        // ------------------------------------------------------
        cache.set(cacheKey, imageUrl);
        console.log(`💾 Сохранено в кэш (${cacheKey})`);

        return res.redirect(302, imageUrl);

    } catch (error) {
        console.error('❌ Ошибка:', error);
        return res.status(500).send(`Proxy error: ${error.message}`);
    }
}
