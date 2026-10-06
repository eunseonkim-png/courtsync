(function (root) {
  'use strict';
  const API = 'https://www.googleapis.com/calendar/v3';
  const SCOPES = [
    'https://www.googleapis.com/auth/calendar.events.owned',
    'https://www.googleapis.com/auth/calendar.calendars.readonly'
  ];

  class CalendarError extends Error {
    constructor(message, status = 0, reason = '') {
      super(message);
      this.name = 'CalendarError';
      this.status = status;
      this.reason = reason;
    }
  }
  function validClientId(value) {
    return typeof value === 'string' && /^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(value.trim());
  }
  function readableError(error) {
    if (error.status === 401) return 'Google 연결이 만료됐어요. 다시 연결한 뒤 남은 예약을 등록해 주세요.';
    if (error.reason === 'accessNotConfigured' || error.reason === 'SERVICE_DISABLED') return '앱 연결 설정에서 Google Calendar API를 사용 설정해야 합니다.';
    if (error.status === 429 || /rateLimitExceeded|userRateLimitExceeded/.test(error.reason)) return 'Google 요청 한도에 도달했습니다. 잠시 후 남은 예약을 다시 등록해 주세요.';
    if (error.status === 403) return 'Google 캘린더 권한을 확인해 주세요. 연결 설정의 테스트 사용자와 동의한 권한도 확인해 주세요.';
    if (error.reason === 'EVENT_CHANGED') return 'Google에 같은 예약이 있지만 시간이 변경되어 있어요. 해당 일정을 확인해 주세요.';
    if (error.reason === 'DELETED_TOO_OFTEN') return '이 예약은 Google에서 여러 번 삭제된 기록이 있어요. 개별 추가로 저장해 주세요.';
    if (error.reason === 'ID_MISMATCH') return 'Google의 기존 일정과 예약 정보가 일치하지 않아 등록을 중단했습니다.';
    if (error.reason === 'LIST_LIMIT') return '기존 일정 확인을 끝내지 못했습니다. 잠시 후 다시 시도해 주세요.';
    if (!error.status) return '인터넷 연결을 확인해 주세요. 다시 등록해도 기존 예약은 확인해서 중복을 방지합니다.';
    return `Google 일정 등록에 실패했습니다 (${error.status}). 남은 예약을 다시 시도해 주세요.`;
  }

  function createClient({ fetchImpl = root.fetch?.bind(root), cryptoImpl = root.crypto } = {}) {
    async function digest(value) {
      const bytes = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(value));
      return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    async function request(path, token, body) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      let response;
      try {
        response = await fetchImpl(`${API}${path}`, {
          method: body ? 'POST' : 'GET',
          headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal,
          credentials: 'omit', cache: 'no-store', redirect: 'error'
        });
      } catch { throw new CalendarError('Network request failed'); }
      finally { clearTimeout(timer); }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new CalendarError('Calendar API request failed', response.status,
          data.error?.errors?.[0]?.reason || data.error?.status || '');
      }
      return data;
    }
    async function primaryCalendar(token) {
      const calendar = await request('/calendars/primary?fields=id,summary', token);
      if (typeof calendar.id !== 'string' || !calendar.id) throw new CalendarError('Missing calendar identity');
      return { id: calendar.id, name: calendar.summary || calendar.id, key: await digest(calendar.id) };
    }
    function matchesTime(event, booking) {
      return event.status !== 'cancelled' &&
        Date.parse(event.start?.dateTime) === Date.parse(booking.start) &&
        Date.parse(event.end?.dateTime) === Date.parse(booking.end);
    }
    function checkEvent(event, booking, key) {
      if (!event || typeof event.id !== 'string' || !event.id) throw new CalendarError('Missing saved event identity');
      if (event.extendedProperties?.private?.courtsyncKey !== key) throw new CalendarError('Identity mismatch', 409, 'ID_MISMATCH');
      if (!matchesTime(event, booking)) throw new CalendarError('Event was changed', 409, 'EVENT_CHANGED');
      return event;
    }
    async function findExisting(booking, token, calendarId, key) {
      let pageToken = '';
      for (let page = 0; page < 10; page++) {
        const params = new URLSearchParams({ timeMin: booking.start, timeMax: booking.end,
          singleEvents: 'true', showDeleted: 'false', maxResults: '2500',
          fields: 'nextPageToken,items(id,status,summary,start,end,extendedProperties)' });
        if (pageToken) params.set('pageToken', pageToken);
        const data = await request(`/calendars/${encodeURIComponent(calendarId)}/events?${params}`, token);
        const existing = (data.items || []).find(event => matchesTime(event, booking) &&
          (event.extendedProperties?.private?.courtsyncKey === key || event.summary === booking.title));
        if (existing) return existing;
        if (!data.nextPageToken) return null;
        pageToken = data.nextPageToken;
      }
      throw new CalendarError('List pagination limit reached', 0, 'LIST_LIMIT');
    }
    async function ensureEvent(booking, token, calendarId) {
      if (!booking?.reservationId || !booking.title || !Number.isFinite(Date.parse(booking.start)) ||
          !Number.isFinite(Date.parse(booking.end)) || Date.parse(booking.end) <= Date.parse(booking.start)) {
        throw new CalendarError('Invalid booking', 400);
      }
      const key = await digest(`courtsync:v1:${booking.reservationId}`);
      const baseId = `cs${key}`;
      const calendarPath = `/calendars/${encodeURIComponent(calendarId)}/events`;
      let checkedList = false;
      // A deleted event ID remains reserved. A deterministic generation lets
      // retries recreate an explicitly selected reservation without duplicating it.
      for (let generation = 0; generation < 5; generation++) {
        const id = generation ? `${baseId}g${generation}` : baseId;
        try {
          const existing = await request(`${calendarPath}/${id}`, token);
          if (existing.status === 'cancelled') continue;
          return { event: checkEvent(existing, booking, key), created: false };
        } catch (error) {
          if (error.status === 410) continue;
          if (error.status !== 404) throw error;
        }
        if (!checkedList) {
          const existing = await findExisting(booking, token, calendarId, key);
          checkedList = true;
          if (existing) return { event: existing, created: false };
        }
        const body = {
          id, summary: booking.title, location: booking.location,
          description: '강동구 체육시설 대관 예약\nhttps://gdgd.igangdong.or.kr/page/rent/my.od.list.php',
          start: { dateTime: booking.start, timeZone: 'Asia/Seoul' },
          end: { dateTime: booking.end, timeZone: 'Asia/Seoul' },
          extendedProperties: { private: { courtsyncKey: key } }
        };
        try {
          const event = await request(`${calendarPath}?sendUpdates=none`, token, body);
          if (event.id !== id) throw new CalendarError('Missing saved event identity');
          return { event: checkEvent(event, booking, key), created: true };
        } catch (error) {
          if (error.status !== 409) throw error;
          const existing = await request(`${calendarPath}/${id}`, token);
          if (existing.status === 'cancelled') continue;
          return { event: checkEvent(existing, booking, key), created: false };
        }
      }
      throw new CalendarError('Too many deleted generations', 409, 'DELETED_TOO_OFTEN');
    }
    async function sync(bookings, token, calendarId, onProgress = () => {}) {
      const results = [];
      const unique = [...new Map(bookings.map(item => [item.reservationId, item])).values()];
      for (const booking of unique) {
        let result;
        try { result = { reservationId: booking.reservationId, ok: true, ...await ensureEvent(booking, token, calendarId) }; }
        catch (error) { result = { reservationId: booking.reservationId, ok: false, error }; }
        results.push(result);
        onProgress(result, results.length, unique.length);
        if (!result.ok && (result.error.status === 401 || result.error.status === 403 || result.error.status === 429)) break;
      }
      return results;
    }
    return { primaryCalendar, ensureEvent, sync };
  }
  const api = { SCOPES, validClientId, readableError, CalendarError, createClient };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CourtSyncGoogle = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
