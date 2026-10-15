// Cloudflare Worker. All secrets are Worker secrets; never put them in config.js.
const enc = new TextEncoder();
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const unb64 = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value)))].map(v => v.toString(16).padStart(2, '0')).join('');
async function key(env) { return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc.encode(env.SESSION_SECRET)), 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function seal(value, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return b64(iv) + '.' + b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), enc.encode(JSON.stringify(value)))));
}
async function unseal(value, env, kind) {
  const [iv, body] = value.split('.');
  const data = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await key(env), unb64(body))));
  if (data.kind !== kind || data.expiresAt <= Date.now()) throw new Error('Expired session');
  return data;
}
function json(data, status = 200, origin) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}) } });
}
async function kakao(path, token, body, fetcher) {
  const response = await fetcher(`https://kapi.kakao.com${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, ...(body ? { body: new URLSearchParams(body) } : {}), signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok) { const error = new Error('Kakao API failed'); error.status = response.status; throw error; }
  return data;
}
export function validBooking(b) {
  return b && typeof b.reservationId === 'string' && b.reservationId.length <= 500 && typeof b.title === 'string' && b.title.startsWith('[CourtSync] ') && b.title.length <= 50 && typeof b.location === 'string' && b.location.length <= 100 && typeof b.start === 'string' && typeof b.end === 'string' && Number.isFinite(Date.parse(b.start)) && Date.parse(b.end) > Date.parse(b.start) && Date.parse(b.end) - Date.parse(b.start) <= 86400000;
}
export async function syncBooking(b, token, fetcher = fetch) {
  if (!validBooking(b)) throw new Error('Invalid booking');
  const query = new URLSearchParams({ calendar_id: 'primary', from: b.start, to: b.end, limit: '1000' });
  let path = `/v2/api/calendar/events?${query}`;
  for (let page = 0; page < 20; page++) {
    const list = await kakao(path, token, null, fetcher);
    const match = (list.events || []).find(e => e.id && e.title === b.title && Date.parse(e.time?.start_at) === Date.parse(b.start) && Date.parse(e.time?.end_at) === Date.parse(b.end));
    if (match) return { eventId: match.id, created: false };
    if (!list.has_next) break;
    if (page === 19) throw new Error('List incomplete');
    const next = new URL(list.after_url);
    if (next.hostname !== 'kapi.kakao.com' || next.pathname !== '/v2/api/calendar/events') throw new Error('Invalid page');
    path = next.pathname + next.search;
  }
  // Do not retry a failed POST automatically: next attempt lists first to recover an uncertain result.
  const result = await kakao('/v2/api/calendar/create/event', token, { calendar_id: 'primary', event: JSON.stringify({ title: b.title, time: { start_at: b.start, end_at: b.end, time_zone: 'Asia/Seoul', all_day: false, lunar: false }, location: { name: b.location }, description: `강동구 테니스 예약\nCourtSync 예약: ${b.reservationId}`, reminders: [60] }) }, fetcher);
  if (!result.event_id) throw new Error('Missing event id');
  const saved = await kakao(`/v2/api/calendar/event?${new URLSearchParams({ calendar_id: 'primary', event_id: result.event_id })}`, token, null, fetcher);
  const event = saved.event || saved;
  if (event.title !== b.title || Date.parse(event.time?.start_at) !== Date.parse(b.start) || Date.parse(event.time?.end_at) !== Date.parse(b.end)) throw new Error('Save not verified');
  return { eventId: result.event_id, created: true };
}
function popup(data, origin, cookie = '') {
  const nonce = crypto.randomUUID();
  const script = JSON.stringify(data).replaceAll('<', '\\u003c');
  return new Response(`<!doctype html><html lang="ko"><meta charset="utf-8"><title>CourtSync 카카오 연결</title><p>연결 결과를 CourtSync로 전달했습니다. 이 창을 닫고 돌아가세요.</p><script nonce="${nonce}">if(window.opener){window.opener.postMessage(${script},${JSON.stringify(origin)});window.close();}</script></html>`, { headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`, ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
}
export default { async fetch(request, env) {
  const url = new URL(request.url), origin = env.APP_ORIGIN || 'https://eunseonkim-png.github.io';
  if (!env.KAKAO_REST_KEY || !env.KAKAO_CLIENT_SECRET || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return json({ error: '카카오 연결 서버 설정이 아직 완료되지 않았습니다.' }, 503, origin);
  if (url.pathname === '/login' && request.method === 'GET') {
    const nonce = url.searchParams.get('nonce');
    if (!/^[\w-]{20,100}$/.test(nonce || '')) return json({ error: '잘못된 연결 요청입니다.' }, 400);
    const verifier = crypto.randomUUID(), state = await seal({ kind: 'oauth', nonce, verifier, expiresAt: Date.now() + 300000 }, env);
    const params = new URLSearchParams({ client_id: env.KAKAO_REST_KEY, redirect_uri: `${url.origin}/callback`, response_type: 'code', scope: 'talk_calendar', state });
    return new Response(null, { status: 302, headers: { Location: `https://kauth.kakao.com/oauth/authorize?${params}`, 'Set-Cookie': `cs_oauth=${verifier}; HttpOnly; Secure; SameSite=Lax; Path=/callback; Max-Age=300`, 'Cache-Control': 'no-store' } });
  }
  if (url.pathname === '/callback' && request.method === 'GET') {
    let state;
    const clear = 'cs_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/callback; Max-Age=0';
    try {
      state = await unseal(url.searchParams.get('state') || '', env, 'oauth');
      const cookie = /(?:^|;\s*)cs_oauth=([^;]+)/.exec(request.headers.get('Cookie') || '')?.[1];
      if (cookie !== state.verifier) throw new Error('Invalid OAuth state');
      if (!url.searchParams.get('code')) throw new Error('Denied');
      const result = await fetch('https://kauth.kakao.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: env.KAKAO_REST_KEY, client_secret: env.KAKAO_CLIENT_SECRET, redirect_uri: `${url.origin}/callback`, code: url.searchParams.get('code') }), signal: AbortSignal.timeout(15000) });
      const token = await result.json();
      if (!result.ok || !token.access_token) throw new Error('Token exchange failed');
      const user = await kakao('/v2/user/me', token.access_token, null, fetch);
      if (!user.id) throw new Error('Missing user');
      // Verifies calendar permission without creating any event.
      await kakao('/v2/api/calendar/calendars', token.access_token, null, fetch);
      const accountKey = await hash(`kakao:${env.KAKAO_REST_KEY}:${user.id}`);
      const expiresAt = Date.now() + Math.min(Number(token.expires_in) || 3600, 3600) * 1000 - 60000;
      const session = await seal({ kind: 'session', token: token.access_token, accountKey, expiresAt }, env);
      return popup({ type: 'courtsync-kakao', nonce: state.nonce, session, accountKey, expiresAt }, origin, clear);
    } catch { return popup({ type: 'courtsync-kakao', nonce: state?.nonce, error: '카카오 연결을 완료하지 못했습니다. 로그인 설정과 톡캘린더 동의항목을 확인해 주세요.' }, origin, clear); }
  }
  if (request.headers.get('Origin') !== origin) return json({ error: '허용되지 않은 사이트입니다.' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', Vary: 'Origin' } });
  if (url.pathname !== '/event' || request.method !== 'POST') return json({ error: '찾을 수 없습니다.' }, 404, origin);
  let session;
  try { session = await unseal((request.headers.get('Authorization') || '').replace(/^Bearer /, ''), env, 'session'); } catch { return json({ error: '카카오를 다시 연결해 주세요.' }, 401, origin); }
  try {
    const text = await request.text();
    if (text.length > 3000) return json({ error: '예약 정보가 너무 큽니다.' }, 400, origin);
    const booking = JSON.parse(text);
    if (!validBooking(booking)) return json({ error: '예약 날짜와 시간을 확인해 주세요.' }, 400, origin);
    return json(await syncBooking(booking, session.token), 200, origin);
  } catch (error) {
    const status = error.status === 401 ? 401 : error.status === 403 ? 403 : 502;
    return json({ error: status === 403 ? '톡캘린더 권한과 카카오 앱 멤버 등록을 확인해 주세요.' : '등록 결과를 확인하지 못했습니다. 다시 시도하면 기존 일정을 먼저 확인합니다.' }, status, origin);
  }
} };
