(function () {
  'use strict';
  const VERSION = '0.4.0';
  const LIST_KEY = 'courtsyncReservations';
  const STATUS_KEY = 'courtsyncRegistrationStatus';
  const SOURCE_URL = 'https://gdgd.igangdong.or.kr/page/rent/my.od.list.php';
  const reservationId = item => `${item.facility}_${item.date}_${item.time}`;

  function validDate(value) {
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  function validTime(value, allowMidnight) {
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    if (!match) return false;
    const hour = Number(match[1]), minute = Number(match[2]);
    return minute < 60 && (hour < 24 || (allowMidnight && hour === 24 && minute === 0));
  }
  function validateReservation(item) {
    if (!item || typeof item.facility !== 'string' || !item.facility.trim() ||
        typeof item.date !== 'string' || typeof item.time !== 'string') return false;
    const times = item.time.split('~');
    return validDate(item.date) && times.length === 2 &&
      validTime(times[0], false) && validTime(times[1], true) && times[0] !== times[1];
  }

  function parseReservations(raw) {
    const text = String(raw).replace(/[\u00a0\u200b\ufeff]/g, ' ').replace(/\r\n?/g, '\n');
    const found = new Map();
    const stats = { unpaid: 0, invalid: 0, duplicates: 0 };
    const facilityPattern = /[가-힣]+\s*(?:테니스장|체육시설)/g;
    for (const block of text.split(/상세\s*보기|신청\s*취소/)) {
      const facilities = [...block.matchAll(facilityPattern)];
      for (let i = 0; i < facilities.length; i++) {
        const segment = block.slice(i === 0 ? 0 : facilities[i].index,
          facilities[i + 1] ? facilities[i + 1].index : block.length);
        if (!/결제\s*완료/.test(segment) || /취소\s*완료|환불|예약\s*취소|결제\s*취소/.test(segment)) {
          stats.unpaid++; continue;
        }
        const dates = [...segment.matchAll(/(20\d{2})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})(?:\s*일)?/g)];
        const ranges = [...segment.matchAll(/(\d{1,2})\s*:\s*(\d{2})\s*[~〜～–—-]\s*(\d{1,2})\s*:\s*(\d{2})/g)];
        if (!dates.length || !ranges.length) { stats.invalid++; continue; }
        for (const range of ranges) {
          // Use the nearest use date preceding the time, rather than the application date.
          const before = dates.filter(date => date.index < range.index);
          const dateMatch = before.length ? before[before.length - 1] : dates[0];
          const date = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
          const time = `${range[1].padStart(2, '0')}:${range[2]}~${range[3].padStart(2, '0')}:${range[4]}`;
          const courtArea = segment.slice(0, range.index);
          const explicit = courtArea.match(/([A-Za-z]|\d{1,2})\s*(?:번\s*)?(?:코트|면)/i) || courtArea.match(/코트\s*([A-Za-z]|\d{1,2})/i);
          const afterDate = segment.slice(dateMatch.index + dateMatch[0].length, range.index);
          const bare = afterDate.match(/^\s*(?:\([^)]*\)\s*)?(\d{1,2})\s*$/);
          const court = explicit ? explicit[1].toUpperCase() : bare ? bare[1] : '';
          const item = { facility: `${facilities[i][0].replace(/\s+/g, '')}${court ? ` ${court}코트` : ''}`, date, time };
          if (!validateReservation(item)) { stats.invalid++; continue; }
          item.id = reservationId(item);
          if (found.has(item.id)) stats.duplicates++; else found.set(item.id, item);
        }
      }
    }
    return { items: [...found.values()].sort((a, b) => `${a.date} ${a.time} ${a.facility}`.localeCompare(`${b.date} ${b.time} ${b.facility}`)), stats };
  }

  function eventDates(item) {
    if (!validateReservation(item)) throw new Error('Invalid reservation');
    const [start, end] = item.time.split('~');
    const startDate = new Date(`${item.date}T${start}:00+09:00`);
    let endDate;
    if (end === '24:00') {
      endDate = new Date(`${item.date}T00:00:00+09:00`);
      endDate.setTime(endDate.getTime() + 86400000);
    } else {
      endDate = new Date(`${item.date}T${end}:00+09:00`);
      if (endDate < startDate) endDate.setTime(endDate.getTime() + 86400000);
    }
    const format = date => date.toISOString().replace(/[-:]|\.\d{3}/g, '');
    return [format(startDate), format(endDate)];
  }
  function googleURL(item) {
    const params = new URLSearchParams({ action: 'TEMPLATE', text: `[CourtSync] ${item.facility}`,
      dates: eventDates(item).join('/'), ctz: 'Asia/Seoul', location: item.facility,
      details: `강동구 체육시설 대관 예약\n예약내역: ${SOURCE_URL}` });
    return `https://calendar.google.com/calendar/render?${params}`;
  }
  function googleBooking(item) {
    const iso = date => date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z');
    const [start, end] = eventDates(item).map(iso);
    return { reservationId: reservationId(item), title: `[CourtSync] ${item.facility}`, location: item.facility, start, end };
  }
  function escapeICS(text) {
    return String(text).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
  }
  function foldICS(line) {
    const encoder = new TextEncoder();
    let result = '', bytes = 0;
    for (const character of line) {
      const length = encoder.encode(character).length;
      if (bytes + length > 75) { result += '\r\n '; bytes = 1; }
      result += character; bytes += length;
    }
    return result;
  }
  function buildICS(items, now = new Date()) {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CourtSync//Reservations//KO', 'CALSCALE:GREGORIAN'];
    const stamp = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
    const seen = new Set();
    for (const item of items) {
      const id = reservationId(item);
      if (seen.has(id)) continue;
      seen.add(id);
      const [start, end] = eventDates(item);
      // Stable exact UTF-8 identity, independent of export time.
      const uid = [...new TextEncoder().encode(id)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      lines.push('BEGIN:VEVENT', `UID:${uid}@courtsync.github.io`, `DTSTAMP:${stamp}`,
        `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${escapeICS(`[CourtSync] ${item.facility}`)}`,
        `LOCATION:${escapeICS(item.facility)}`, `DESCRIPTION:${escapeICS(`강동구 체육시설 대관 예약\n예약내역: ${SOURCE_URL}`)}`,
        'STATUS:CONFIRMED', 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.map(foldICS).join('\r\n') + '\r\n';
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseReservations, validateReservation, reservationId, eventDates, googleURL, googleBooking, buildICS };
  }
  if (typeof document === 'undefined') return;

  const element = id => document.getElementById(id);
  let storageAvailable = true;
  function readStorage(key, fallback) {
    try { const value = JSON.parse(localStorage.getItem(key)); return value === null ? fallback : value; }
    catch { storageAvailable = false; return fallback; }
  }
  function writeStorage(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { storageAvailable = false; }
    element('storageNotice').hidden = storageAvailable;
  }
  const stored = readStorage(LIST_KEY, []);
  let parsedList = Array.isArray(stored) ? stored.filter(validateReservation).map(item => ({ facility: item.facility, date: item.date, time: item.time, id: reservationId(item) })) : [];
  const storedStatuses = readStorage(STATUS_KEY, []);
  const statuses = new Map();
  if (Array.isArray(storedStatuses)) {
    for (const item of storedStatuses) {
      if (item && typeof item.id === 'string' && ['confirmed', 'opened', 'exported', 'legacy'].includes(item.status)) {
        statuses.set(item.id, { id: item.id, status: item.status, updatedAt: item.updatedAt });
      }
    }
  }
  // Prior versions marked an event complete just by opening Google. Preserve
  // those histories as provisional, instead of silently claiming they were saved.
  const legacy = readStorage('registeredReservations', []);
  const legacyStatuses = readStorage('reservationStatus', []);
  for (const entry of [...(Array.isArray(legacy) ? legacy : []), ...(Array.isArray(legacyStatuses) ? legacyStatuses : [])]) {
    const id = typeof entry === 'string' ? entry : entry && entry.id;
    if (typeof id === 'string' && !statuses.has(id)) statuses.set(id, { id, status: 'legacy' });
  }
  const googleAPI = window.CourtSyncGoogle;
  const calendarClient = googleAPI.createClient();
  const GOOGLE_KEY = 'courtsyncGoogleRegistrations';
  const CLIENT_KEY = 'courtsyncGoogleClientId';
  const LAST_ACCOUNT_KEY = 'courtsyncLastGoogleCalendarKey';
  const googleRecords = new Map();
  const storedGoogle = readStorage(GOOGLE_KEY, []);
  for (const record of Array.isArray(storedGoogle) ? storedGoogle : []) {
    if (record && typeof record.id === 'string' && /^[a-f0-9]{64}$/.test(record.calendarKey) && typeof record.eventId === 'string') {
      googleRecords.set(`${record.calendarKey}:${record.id}`, record);
    }
  }
  let calendarKey = readStorage(LAST_ACCOUNT_KEY, '');
  if (typeof calendarKey !== 'string' || !/^[a-f0-9]{64}$/.test(calendarKey)) calendarKey = '';
  const configuredId = window.COURTSYNC_CONFIG?.googleClientId;
  let clientId = googleAPI.validClientId(configuredId) ? configuredId.trim() : readStorage(CLIENT_KEY, '');
  if (!googleAPI.validClientId(clientId)) clientId = '';
  let googleToken = '', tokenExpiresAt = 0, connectedCalendar = null;
  let authBusy = false, syncing = false, refreshing = false;
  function googleRegistered(item) { return Boolean(calendarKey && googleRecords.has(`${calendarKey}:${item.id}`)); }
  function registered(item) { return statuses.get(item.id)?.status === 'confirmed' || googleRegistered(item); }
  const selected = new Set(parsedList.filter(item => !registered(item)).map(item => item.id));
  let exportedIds = [];

  function message(text, isError = false) {
    element('feedback').textContent = text;
    element('feedback').className = isError ? 'feedback error' : 'feedback';
  }
  function setStatus(ids, status) {
    const updatedAt = new Date().toISOString();
    for (const id of ids) {
      statuses.set(id, { id, status, updatedAt });
      if (status === 'confirmed') selected.delete(id); else selected.add(id);
    }
    writeStorage(STATUS_KEY, [...statuses.values()]);
    writeStorage('registeredReservations', [...statuses.values()].filter(item => item.status === 'confirmed').map(item => item.id));
    render();
  }
  function button(text, className, onClick) {
    const result = document.createElement('button');
    result.type = 'button'; result.textContent = text; result.className = className;
    result.addEventListener('click', onClick);
    return result;
  }
  function updateSelection() {
    const count = parsedList.filter(item => selected.has(item.id)).length;
    element('exportButton').textContent = `선택한 ${count}건 한꺼번에 내보내기 (.ics)`;
    element('exportButton').disabled = count === 0 || syncing || authBusy || refreshing;
    element('selectedCount').textContent = `${count}건 선택`;
    element('googleBulkButton').textContent = syncing ? 'Google에 등록하는 중…' : `선택한 ${count}건 Google에 자동 등록`;
    element('googleBulkButton').disabled = count === 0 || syncing || authBusy || refreshing;
    for (const id of ['parseButton', 'selectPending', 'selectAll', 'selectNone', 'saveGoogleConfig', 'refreshButton', 'googleDisconnectButton']) {
      element(id).disabled = syncing || authBusy || refreshing;
    }
    element('googleConnectButton').disabled = syncing || authBusy || refreshing;
    element('googleConnectButton').textContent = authBusy ? 'Google 연결 중…' : googleToken && tokenExpiresAt > Date.now() ? 'Google 계정 바꾸기' : clientId ? 'Google 캘린더 연결' : 'Google 연결 설정하기';
    element('googleDisconnectButton').hidden = !googleToken;
    element('googleConnectionStatus').textContent = googleToken && tokenExpiresAt > Date.now() && connectedCalendar ?
      `등록할 기본 캘린더: ${connectedCalendar.id}` : clientId ? '등록할 때 Google 계정을 연결해 주세요.' : '처음 한 번 Google 앱 연결 설정이 필요합니다.';
  }
  function render() {
    element('resultSection').hidden = parsedList.length === 0;
    element('countText').textContent = parsedList.length;
    element('confirmedCount').textContent = parsedList.filter(registered).length;
    element('reservationList').replaceChildren();
    for (const item of parsedList) {
      const status = statuses.get(item.id)?.status;
      const isRegistered = registered(item);
      const card = document.createElement('article');
      card.className = `item-card${isRegistered ? ' registered' : ''}`;
      const row = document.createElement('label'); row.className = 'item-heading';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
      checkbox.checked = selected.has(item.id);
      checkbox.disabled = syncing;
      checkbox.setAttribute('aria-label', `${item.facility} ${item.date} ${item.time} 선택`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(item.id); else selected.delete(item.id);
        updateSelection();
      });
      const title = document.createElement('strong'); title.textContent = `🎾 ${item.facility}`;
      row.append(checkbox, title);
      const details = document.createElement('p'); details.className = 'item-detail';
      details.textContent = `${item.date} · ${item.time.replace('~', '–')} (한국 시간)`;
      const badge = document.createElement('span');
      badge.className = `badge ${isRegistered ? 'success' : 'pending'}`;
      badge.textContent = googleRegistered(item) ? 'Google 등록완료' : ({ confirmed: '등록완료 · 직접 확인', opened: '저장 확인 대기', exported: '파일 내보냄 · 저장 확인 대기', legacy: '이전 기록 · 저장 확인 필요' })[status] || '미등록';
      card.append(row, details, badge);
      const actions = document.createElement('div'); actions.className = 'item-actions';
      const link = document.createElement('a'); link.className = 'button btn-add';
      link.href = googleURL(item); link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = isRegistered ? 'Google 일정 작성 창 열기' : '개별 Google 캘린더 추가';
      link.addEventListener('click', event => {
        if (syncing) { event.preventDefault(); return; }
        if (isRegistered && !window.confirm('이미 등록한 일정입니다. 다시 저장하면 중복될 수 있어요. 일정 작성 창을 열까요?')) { event.preventDefault(); return; }
        if (!isRegistered) setStatus([item.id], 'opened');
        message('Google 캘린더에서 저장한 뒤 돌아와서 ‘저장했어요’를 눌러주세요.');
      });
      actions.append(link);
      if (isRegistered) {
        actions.append(button('등록 표시 해제', 'button secondary', () => {
          googleRecords.delete(`${calendarKey}:${item.id}`);
          writeStorage(GOOGLE_KEY, [...googleRecords.values()]);
          setStatus([item.id], 'opened');
          message('이 앱의 등록 표시를 해제했습니다. 캘린더 일정은 그대로 남아 있습니다.');
        }));
      } else {
        actions.append(button('저장했어요', 'button secondary', () => {
          setStatus([item.id], 'confirmed'); message(`${item.facility} 일정을 등록완료로 표시했습니다.`);
        }));
      }
      for (const action of actions.querySelectorAll('button')) action.disabled = syncing;
      card.append(actions); element('reservationList').append(card);
    }
    updateSelection();
    element('bulkConfirm').hidden = exportedIds.length === 0;
    element('confirmExportButton').disabled = syncing;
    element('storageNotice').hidden = storageAvailable;
  }

  element('parseButton').addEventListener('click', () => {
    const raw = element('rawText').value;
    if (!raw.trim()) { message('예약목록 표를 먼저 붙여넣어 주세요.', true); return; }
    const result = parseReservations(raw);
    if (!result.items.length) {
      message('결제완료 예약을 찾지 못했습니다. 시설명, 이용일자, 이용시간, 결제상태가 모두 포함된 표를 붙여넣어 주세요. 기존 목록은 유지됩니다.', true); return;
    }
    parsedList = result.items; selected.clear();
    for (const item of parsedList) if (!registered(item)) selected.add(item.id);
    exportedIds = [];
    element('googleProgress').hidden = true; element('googleProgress').textContent = '';
    writeStorage(LIST_KEY, parsedList); render();
    const notes = [];
    if (result.stats.unpaid) notes.push(`미결제·취소 ${result.stats.unpaid}건 제외`);
    if (result.stats.invalid) notes.push(`형식 확인 필요 ${result.stats.invalid}건 제외`);
    if (result.stats.duplicates) notes.push(`중복 ${result.stats.duplicates}건 제외`);
    message(`${parsedList.length}건을 추출했습니다.${notes.length ? ` (${notes.join(', ')})` : ''}`);
    element('resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  element('selectPending').addEventListener('click', () => {
    selected.clear();
    for (const item of parsedList) if (!registered(item)) selected.add(item.id);
    render();
  });
  element('selectAll').addEventListener('click', () => { for (const item of parsedList) selected.add(item.id); render(); });
  element('selectNone').addEventListener('click', () => { selected.clear(); render(); });
  element('exportButton').addEventListener('click', async () => {
    const items = parsedList.filter(item => selected.has(item.id));
    if (!items.length) return;
    const file = new File([buildICS(items)], 'CourtSync_Reservations.ics', { type: 'text/calendar;charset=utf-8' });
    element('exportButton').disabled = true;
    try {
      let canShare = false;
      try { canShare = Boolean(navigator.canShare && navigator.canShare({ files: [file] })); } catch { /* Download fallback. */ }
      if (canShare && navigator.share) {
        await navigator.share({ files: [file], title: 'CourtSync 예약 일정' });
      } else {
        const url = URL.createObjectURL(file), link = document.createElement('a');
        link.href = url; link.download = 'CourtSync_Reservations.ics';
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      exportedIds = items.map(item => item.id);
      setStatus(exportedIds.filter(id => statuses.get(id)?.status !== 'confirmed'), 'exported');
      message(`${items.length}건의 일정 파일을 내보냈습니다. 캘린더에 실제로 추가한 후 아래에서 등록완료로 표시하세요.`);
      element('confirmExportButton').textContent = `내보낸 ${items.length}건을 캘린더에 저장했어요`;
    } catch (error) {
      message(error.name === 'AbortError' ? '내보내기를 취소했습니다.' : '파일을 내보내지 못했습니다. Safari에서 다시 시도해 주세요.', error.name !== 'AbortError');
    } finally { updateSelection(); }
  });
  element('confirmExportButton').addEventListener('click', () => {
    setStatus(exportedIds, 'confirmed');
    const count = exportedIds.length; exportedIds = []; render();
    message(`${count}건을 등록완료로 표시했습니다.`);
  });

  function showGoogleSettings() {
    element('googleSettings').open = true;
    element('googleClientId').focus();
    element('googleSettings').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  element('googleClientId').value = clientId;
  element('saveGoogleConfig').addEventListener('click', () => {
    const value = element('googleClientId').value.trim();
    if (!googleAPI.validClientId(value)) {
      message('Google의 웹 애플리케이션 클라이언트 ID를 입력해 주세요. 끝이 .apps.googleusercontent.com인 공개 ID입니다.', true); return;
    }
    clientId = value;
    writeStorage(CLIENT_KEY, clientId);
    googleToken = ''; tokenExpiresAt = 0; connectedCalendar = null;
    element('googleSettings').open = false;
    updateSelection();
    message('연결 설정을 저장했습니다. ‘Google 캘린더 연결’을 눌러 주세요.');
  });
  function connectGoogle() {
    if (!clientId) { showGoogleSettings(); message('처음 한 번 Google 앱 연결 설정을 완료해 주세요.'); return; }
    if (!navigator.onLine) { message('Google 연결에는 인터넷이 필요합니다.', true); return; }
    const oauth = window.google?.accounts?.oauth2;
    if (!oauth) { message('Google 로그인 화면을 불러오지 못했습니다. Safari에서 인터넷 연결을 확인하고 앱을 새로고침해 주세요.', true); return; }
    googleToken = ''; tokenExpiresAt = 0; connectedCalendar = null;
    authBusy = true; updateSelection();
    const finish = () => { authBusy = false; render(); };
    try {
      const tokenClient = oauth.initTokenClient({
        client_id: clientId, scope: googleAPI.SCOPES.join(' '), include_granted_scopes: false,
        callback: async response => {
          if (response.error || !response.access_token || !oauth.hasGrantedAllScopes(response, ...googleAPI.SCOPES)) {
            message('Google 연결이 완료되지 않았습니다. 일정 등록에 필요한 권한을 허용해 주세요.', true); finish(); return;
          }
          try {
            const token = response.access_token;
            const calendar = await calendarClient.primaryCalendar(token);
            googleToken = token;
            tokenExpiresAt = Date.now() + Math.max(0, Number(response.expires_in || 3600) - 60) * 1000;
            connectedCalendar = calendar; calendarKey = calendar.key;
            writeStorage(LAST_ACCOUNT_KEY, calendarKey);
            message('Google 캘린더를 연결했습니다. 등록할 예약을 선택한 뒤 자동 등록 버튼을 눌러 주세요.');
          } catch (error) { message(googleAPI.readableError(error), true); }
          finally { finish(); }
        },
        error_callback: error => {
          message(error.type === 'popup_closed' ? 'Google 연결 창을 닫았습니다.' : 'Google 연결 창을 열지 못했습니다. Safari에서 팝업 차단 설정을 확인해 주세요.', error.type !== 'popup_closed');
          finish();
        }
      });
      // Called synchronously inside a user click so mobile popup permissions apply.
      tokenClient.requestAccessToken({ prompt: 'select_account' });
    } catch { message('Google 연결을 시작하지 못했습니다. 앱을 새로고침한 뒤 다시 시도해 주세요.', true); finish(); }
  }
  element('googleConnectButton').addEventListener('click', connectGoogle);
  element('googleDisconnectButton').addEventListener('click', () => {
    googleToken = ''; tokenExpiresAt = 0; connectedCalendar = null;
    updateSelection(); message('이번 연결을 종료했습니다. 다음 등록 때 Google 계정을 다시 연결해 주세요.');
  });
  element('googleBulkButton').addEventListener('click', async () => {
    if (syncing) return;
    if (!googleToken || tokenExpiresAt <= Date.now() || !connectedCalendar) {
      connectGoogle(); return;
    }
    if (!navigator.onLine) { message('일정을 등록하려면 인터넷에 연결해 주세요.', true); return; }
    const items = parsedList.filter(item => selected.has(item.id));
    if (!items.length) return;
    const bookingMap = new Map(items.map(item => [item.id, item]));
    const targetCalendar = connectedCalendar;
    syncing = true;
    element('googleProgress').hidden = false;
    element('googleProgress').textContent = `Google 일정 확인 · 등록 시작 (0/${items.length})`;
    render();
    try {
      const results = await calendarClient.sync(items.map(googleBooking), googleToken, targetCalendar.id, (result, count, total) => {
        if (result.ok) {
          googleRecords.set(`${targetCalendar.key}:${result.reservationId}`, {
            id: result.reservationId, calendarKey: targetCalendar.key, eventId: result.event.id, verifiedAt: new Date().toISOString()
          });
          writeStorage(GOOGLE_KEY, [...googleRecords.values()]);
          selected.delete(result.reservationId);
        }
        element('googleProgress').textContent = `${count}/${total}건 처리 · ${result.ok ? '저장 확인 완료' : '등록 실패'} (${bookingMap.get(result.reservationId).facility})`;
        render();
      });
      const saved = results.filter(result => result.ok);
      const created = saved.filter(result => result.created).length;
      const failed = results.filter(result => !result.ok);
      const remaining = items.length - saved.length;
      const text = `Google 등록 확인 ${saved.length}건 · 새로 추가 ${created}건 · 기존 일정 ${saved.length - created}건${remaining ? ` · 남은 예약 ${remaining}건` : ''}`;
      element('googleProgress').textContent = text;
      message(text + (failed.length ? `\n${googleAPI.readableError(failed[0].error)}` : ''), remaining > 0);
      if (failed.some(result => result.error.status === 401)) { googleToken = ''; tokenExpiresAt = 0; connectedCalendar = null; }
    } catch (error) { message(googleAPI.readableError(error), true); }
    finally { syncing = false; render(); }
  });
  async function waitForActivation(worker) {
    if (!worker || worker.state === 'activated' || worker.state === 'redundant') return;
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); worker.removeEventListener('statechange', check); resolve(); };
      const check = () => { if (worker.state === 'activated' || worker.state === 'redundant') finish(); };
      const timer = setTimeout(finish, 8000);
      worker.addEventListener('statechange', check); check();
    });
  }
  element('refreshButton').addEventListener('click', async () => {
    if (syncing || authBusy || refreshing) return;
    if (!navigator.onLine) { message('최신 버전 새로고침에는 인터넷 연결이 필요합니다.', true); return; }
    refreshing = true; updateSelection(); element('refreshButton').textContent = '새로고침 중…';
    try {
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration) { await registration.update(); await waitForActivation(registration.installing || registration.waiting); }
      }
    } catch { /* A network-first navigation still refreshes the app shell. */ }
    window.location.replace(new URL(`./?refresh=${Date.now()}`, window.location.href).href);
  });
  render();
  if (parsedList.length) message('지난번 예약목록을 불러왔습니다. 새 예약은 표를 다시 붙여넣어 업데이트하세요.');
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register(`./sw.js?v=${VERSION}`).catch(() => {});
}());
