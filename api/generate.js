// /api/generate.js – LinkAPI + ImgBB с поддержкой пользовательского ключа

// Запасной ключ (можно удалить, если хотите требовать ключ всегда)
const DEFAULT_IMGBB_KEY = '9b18b658da2d84f03f07d19da36eb17d';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');

  try {
    const { 
      key,                // API-ключ LinkAPI (обязательный)
      prompt,             // Текстовое описание (обязательный)
      characters,         // JSON-строка с массивом объектов {name, url} (опционально)
      style,              // Стиль (опционально)
      model = 'gemini-3.1-flash-image-preview',
      imgbb_key           // Ключ ImgBB (обязательный, если не хотите использовать запасной)
    } = req.query;

    if (!key) return res.status(400).send('Missing required parameter: key');
    if (!prompt) return res.status(400).send('Missing required parameter: prompt');

    // Проверка наличия ключа ImgBB
    if (!imgbb_key) {
      // Если вы хотите, чтобы ключ был обязательным, раскомментируйте следующую строку:
      // return res.status(400).send('Missing required parameter: imgbb_key');
      
      // Иначе используем запасной (с предупреждением)
      console.warn('imgbb_key not provided, using default');
      imgbb_key = DEFAULT_IMGBB_KEY;
    }

    // Парсим персонажей
    let charactersArray = [];
    if (characters) {
      try {
        charactersArray = JSON.parse(characters);
      } catch (e) {
        console.warn('Failed to parse characters:', e.message);
      }
    }

    console.log(`👥 Персонажи: ${charactersArray.map(c => c.name).join(', ')}`);

    // Формируем запрос к LinkAPI
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

    // Отправляем в LinkAPI
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

    // Очищаем base64
    base64Image = base64Image.replace(/^data:image\/\w+;base64,/, '').replace(/\s/g, '');

    // ------------------------------------------------------
    // ОТПРАВКА В IMGBB с ключом пользователя
    // ------------------------------------------------------
    console.log('📤 Отправка в ImgBB...');
    const imgbbForm = new FormData();
    imgbbForm.append('key', imgbb_key);
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
    console.log('✅ Готово, редирект на:', imageUrl);

    // Редирект на изображение
    return res.redirect(302, imageUrl);

  } catch (error) {
    console.error('❌ Ошибка:', error);
    return res.status(500).send(`Proxy error: ${error.message}`);
  }
}
