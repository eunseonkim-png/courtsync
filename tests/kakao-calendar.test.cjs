const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validEndpoint } = require('../kakao-calendar.js');
const booking = { reservationId: 'court_2026-10-16_09:00', title: '[CourtSync] 강일테니스장', location: '강일테니스장', start: '2026-10-16T00:00:00Z', end: '2026-10-16T02:00:00Z' };
const reply = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
test('Kakao connection accepts only a clean HTTPS server origin', () => {
  assert.equal(validEndpoint('https://example.workers.dev'), true);
  for (const url of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/token', 'https://example.com/?secret=x', 'https://example.com/#token']) assert.equal(validEndpoint(url), false);
});
test('Kakao matches an existing event before writing', async () => {
  const { syncBooking } = await import('../kakao-server/worker.mjs');
  let calls = 0;
  const result = await syncBooking(booking, 'test-token', async () => { calls++; return reply({ events: [{ id: 'existing', title: booking.title, time: { start_at: booking.start, end_at: booking.end } }], has_next: false }); });
  assert.deepEqual(result, { eventId: 'existing', created: false }); assert.equal(calls, 1);
});
test('Kakao creates a Korea-time event and verifies the saved times', async () => {
  const { syncBooking } = await import('../kakao-server/worker.mjs');
  let calls = 0;
  const result = await syncBooking(booking, 'test-token', async (url, options) => {
    calls++;
    if (calls === 1) return reply({ events: [], has_next: false });
    if (calls === 2) {
      assert.match(url, /create\/event$/);
      const event = JSON.parse(options.body.get('event'));
      assert.equal(event.time.time_zone, 'Asia/Seoul'); assert.equal(event.time.start_at, booking.start);
      return reply({ event_id: 'created' });
    }
    return reply({ id: 'created', title: booking.title, time: { start_at: booking.start, end_at: booking.end } });
  });
  assert.deepEqual(result, { eventId: 'created', created: true }); assert.equal(calls, 3);
});
test('Kakao follows pagination and refuses an untrusted next-page host', async () => {
  const { syncBooking } = await import('../kakao-server/worker.mjs');
  let calls = 0;
  await assert.rejects(syncBooking(booking, 'test-token', async () => { calls++; return reply({ events: [], has_next: true, after_url: 'https://attacker.test/events' }); }));
  assert.equal(calls, 1);
});
test('Kakao never automatically repeats an uncertain creation', async () => {
  const { syncBooking } = await import('../kakao-server/worker.mjs');
  let posts = 0;
  await assert.rejects(syncBooking(booking, 'test-token', async (url, options) => {
    if (options.method === 'POST') { posts++; throw new Error('timeout'); }
    return reply({ events: [], has_next: false });
  }));
  assert.equal(posts, 1);
});
