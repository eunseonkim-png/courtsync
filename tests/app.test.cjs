const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseReservations, eventDates, buildICS, googleURL, validateReservation } = require('../app.js');
const row = '강일테니스장 2026-10-08(목) 2 06:00~08:00 결제완료 상세보기 신청취소';

test('extracts multiple paid rows, omits cancellations and removes duplicates', () => {
  const result = parseReservations(`${row}\n고덕테니스장 2026-10-10(토) 1 09:00~11:00 결제 완료 상세보기\n${row}\n강일테니스장 2026-10-09(금) 3 06:00~08:00 결제대기 상세보기\n강일테니스장 2026-10-11(일) 4 06:00~08:00 결제완료 취소완료 상세보기`);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].facility, '강일테니스장 2코트');
  assert.equal(result.stats.duplicates, 1);
  assert.equal(result.stats.unpaid, 2);
});
test('accepts wrapped copied rows, date separators, unicode time separators and court names', () => {
  const result = parseReservations('강일테니스장\n2026.10.8 (목)\n2번 코트\n6:00 ～ 8:00\n결제 완료\n상세 보기\n고덕테니스장 2026/10/9 A코트 09:00–11:00 결제완료');
  assert.deepEqual(result.items.map(item => [item.facility, item.date, item.time]), [
    ['강일테니스장 2코트', '2026-10-08', '06:00~08:00'],
    ['고덕테니스장 A코트', '2026-10-09', '09:00~11:00']
  ]);
});
test('chooses use date rather than earlier application date', () => {
  assert.equal(parseReservations(`신청일 2026-10-01 ${row}`).items[0].date, '2026-10-08');
});
test('does not require detailed-view buttons to separate rows', () => {
  assert.equal(parseReservations('강일테니스장 2026-10-08 1코트 06:00~08:00 결제완료\n고덕테니스장 2026-10-09 2코트 09:00~11:00 결제완료').items.length, 2);
});
test('rejects invalid dates, times, equal start/end and missing required fields', () => {
  for (const invalid of ['2026-02-30 06:00~08:00', '2026-10-08 25:00~26:00', '2026-10-08 06:60~08:00', '2026-10-08 06:00~06:00']) {
    assert.equal(parseReservations(`강일테니스장 ${invalid} 결제완료`).items.length, 0);
  }
  assert.equal(parseReservations('결제완료 예약정보 없음').items.length, 0);
  assert.equal(validateReservation({ facility: '강일테니스장', date: '2026-10-08', time: '06:00~24:01' }), false);
});
test('Google and ICS both preserve Korean local time even outside Korea', () => {
  const item = parseReservations(row).items[0];
  assert.deepEqual(eventDates(item), ['20261007T210000Z', '20261007T230000Z']);
  const params = new URL(googleURL(item)).searchParams;
  assert.equal(params.get('dates'), '20261007T210000Z/20261007T230000Z');
  assert.equal(params.get('ctz'), 'Asia/Seoul');
});
test('handles midnight and overnight events, including month/year rollovers', () => {
  assert.deepEqual(eventDates({ facility: '강일테니스장', date: '2026-12-31', time: '23:00~24:00' }), ['20261231T140000Z', '20261231T150000Z']);
  assert.deepEqual(eventDates({ facility: '강일테니스장', date: '2026-12-31', time: '23:00~01:00' }), ['20261231T140000Z', '20261231T160000Z']);
});
test('ICS uses CRLF, stable unique identities, stamps and UTF-8 safe 75-octet folding', () => {
  const item = parseReservations(row).items[0];
  const first = buildICS([item, item], new Date('2026-10-06T00:00:00Z'));
  const second = buildICS([item], new Date('2026-10-07T00:00:00Z'));
  assert.equal((first.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.equal(first.replace(/\r\n /g, '').match(/^UID:(.*)$/m)[1], second.replace(/\r\n /g, '').match(/^UID:(.*)$/m)[1]);
  assert.match(first, /DTSTAMP:20261006T000000Z/);
  assert.match(first, /DTSTART:20261007T210000Z/);
  assert.equal(first.replace(/\r\n/g, '').includes('\n'), false);
  assert.ok(first.endsWith('END:VCALENDAR\r\n'));
  for (const line of first.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75);
  assert.match(first.replace(/\r\n /g, ''), /SUMMARY:\[CourtSync\] 강일테니스장 2코트/);
});
test('ICS escapes text so data cannot inject calendar properties', () => {
  const item = { facility: '강일,테니스장;코트\\A\nEND:VEVENT', date: '2026-10-08', time: '06:00~08:00' };
  const content = buildICS([item]).replace(/\r\n /g, '');
  assert.ok(content.includes('강일\\,테니스장\\;코트\\\\A\\nEND:VEVENT'));
  assert.equal(content.split('\r\n').filter(line => line === 'END:VEVENT').length, 1);
});
