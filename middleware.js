// middleware.js
import { NextResponse } from 'next/server';

export function middleware(request) {
  // Только для нашего API
  if (!request.nextUrl.pathname.startsWith('/api/generate')) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  const sensitiveParams = ['key', 'prompt', 'characters', 'imgbb_key'];
  const sensitiveData = {};

  // Вырезаем чувствительные параметры из URL и сохраняем в заголовки
  for (const param of sensitiveParams) {
    const value = url.searchParams.get(param);
    if (value) {
      sensitiveData[`x-${param}`] = value;
      url.searchParams.delete(param);
    }
  }

  // Добавляем заголовки
  const headers = new Headers(request.headers);
  for (const [key, val] of Object.entries(sensitiveData)) {
    headers.set(key, val);
  }

  // Продолжаем запрос с очищенным URL и новыми заголовками
  return NextResponse.next({
    request: {
      headers: headers,
      url: url.toString(),
    },
  });
}

export const config = {
  matcher: '/api/generate',
};
