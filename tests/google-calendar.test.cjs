const { test } = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { googleBooking } = require('../app.js');
const { createClient, validClientId, readableError, CalendarError, SCOPES } = require('../google-calendar.js');
const booking = googleBooking({ facility: '강일테니스장 2코트', date: '2026-10-08', time: '06:00~08:00' });
const response = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const saved = body => ({ ...body, status: 'confirmed' });
const makeClient = fetchImpl => createClient({ fetchImpl, cryptoImpl: webcrypto });

test('requires a public Google web client ID and limited calendar scopes', () => {
  assert.equal(validClientId('123-example.apps.googleusercontent.com'), true);
  assert.equal(validClientId('a-client-secret'), false);
  assert.equal(validClientId(undefined), false);
  assert.ok(SCOPES.includes('https://www.googleapis.com/auth/calendar.events.owned'));
  assert.ok(!SCOPES.includes('https://www.googleapis.com/auth/calendar'));
});
test('identifies the target primary calendar and uses authorized uncached requests', async () => {
  const client = makeClient(async (url, options) => {
    assert.equal(url, 'https://www.googleapis.com/calendar/v3/calendars/primary?fields=id,summary');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    return response(200, { id: 'test@example.com', summary: 'Test Calendar' });
  });
  const calendar = await client.primaryCalendar('test-token');
  assert.equal(calendar.id, 'test@example.com');
  assert.match(calendar.key, /^[a-f0-9]{64}$/);
});
test('creates a correctly timed event after checking for existing appointments', async () => {
  const calls = [];
  const client = makeClient(async (url, options) => {
    calls.push({url,options});
    if (options.method === 'POST') return response(200, saved(JSON.parse(options.body)));
    if (url.includes('/events?')) return response(200, { items: [] });
    return response(404);
  });
  const result = await client.ensureEvent(booking, 'token', 'test@example.com');
  assert.equal(result.created, true);
  assert.equal(calls.length, 3);
  const body = JSON.parse(calls[2].options.body);
  assert.match(body.id, /^[a-v0-9]{5,1024}$/);
  assert.equal(body.start.dateTime, '2026-10-07T21:00:00Z');
  assert.equal(body.end.dateTime, '2026-10-07T23:00:00Z');
  assert.equal(body.start.timeZone, 'Asia/Seoul');
  assert.equal(body.summary, '[CourtSync] 강일테니스장 2코트');
  assert.match(calls[2].url, /sendUpdates=none/);
});
test('recognizes a manually added matching CourtSync event and does not create a duplicate', async () => {
  let writes = 0;
  const client = makeClient(async (url, options) => {
    if (options.method === 'POST') { writes++; return response(500); }
    if (url.includes('/events?')) return response(200, { items: [
      { id: 'unrelated', summary: 'Another appointment', start:{dateTime:booking.start}, end:{dateTime:booking.end} },
      { id: 'manually-added', summary: booking.title, start:{dateTime:'2026-10-08T06:00:00+09:00'}, end:{dateTime:'2026-10-08T08:00:00+09:00'} }
    ] });
    return response(404);
  });
  const result = await client.ensureEvent(booking, 'token', 'primary');
  assert.equal(result.event.id, 'manually-added');
  assert.equal(result.created, false);
  assert.equal(writes, 0);
});
test('same title at another time is not treated as a matching reservation', async () => {
  const client = makeClient(async (url, options) => {
    if (options.method === 'POST') return response(200, saved(JSON.parse(options.body)));
    if (url.includes('/events?')) return response(200, { items: [{ id:'other', summary:booking.title, start:{dateTime:'2026-10-07T20:00:00Z'}, end:{dateTime:booking.end} }] });
    return response(404);
  });
  assert.equal((await client.ensureEvent(booking,'token','primary')).created,true);
});
test('a timed-out creation can be retried without creating another event', async () => {
  let event, writes = 0;
  const client = makeClient(async (url, options) => {
    if (options.method === 'POST') {
      writes++; event = saved(JSON.parse(options.body)); throw new Error('Connection lost after Google accepted the event');
    }
    if (url.includes('/events?')) return response(200, {items:[]});
    return event ? response(200,event) : response(404);
  });
  await assert.rejects(client.ensureEvent(booking,'token','primary'));
  const retried = await client.ensureEvent(booking,'token','primary');
  assert.equal(retried.created,false);
  assert.equal(writes,1);
});
test('handles simultaneous creation conflicts by verifying the existing event', async () => {
  let event;
  const client = makeClient(async (url, options) => {
    if (options.method === 'POST') { event=saved(JSON.parse(options.body)); return response(409); }
    if (url.includes('/events?')) return response(200,{items:[]});
    return event ? response(200,event) : response(404);
  });
  assert.equal((await client.ensureEvent(booking,'token','primary')).created,false);
});
test('does not overwrite an event whose time was changed in Google', async () => {
  let event;
  const client = makeClient(async (url, options) => {
    if (options.method === 'POST') { event=saved(JSON.parse(options.body)); return response(200,event); }
    if (url.includes('/events?')) return response(200,{items:[]});
    return event ? response(200,event) : response(404);
  });
  await client.ensureEvent(booking,'token','primary');
  event.start.dateTime='2026-10-07T20:00:00Z';
  await assert.rejects(client.ensureEvent(booking,'token','primary'), error=>error.reason==='EVENT_CHANGED');
});
test('explicitly selected deleted events can be recreated with a stable next-generation ID', async () => {
  let event, id;
  const client=makeClient(async(url,options)=>{
    if(options.method==='POST') { event=saved(JSON.parse(options.body)); id=event.id; return response(200,event); }
    if(url.includes('/events?')) return response(200,{items:[]});
    if(event && url.endsWith('/'+id)) return response(200,event);
    if(/g1$/.test(url)) return response(404);
    return response(200,{id:'deleted',status:'cancelled'});
  });
  const result=await client.ensureEvent(booking,'token','primary');
  assert.match(result.event.id,/g1$/);
  assert.equal((await client.ensureEvent(booking,'token','primary')).created,false);
});
test('batch records only successful events and stops on expired authorization', async () => {
  const second={...booking,reservationId:booking.reservationId+'_2',title:booking.title+' other'};
  const third={...booking,reservationId:booking.reservationId+'_3'};
  let writes=0;
  const progressed=[];
  const client=makeClient(async(url,options)=>{
    if(options.method==='POST') { writes++; return response(200,saved(JSON.parse(options.body))); }
    if(writes) return response(401);
    if(url.includes('/events?')) return response(200,{items:[]});
    return response(404);
  });
  const results=await client.sync([booking,second,third],'token','primary',result=>progressed.push(result));
  assert.equal(results.length,2);
  assert.equal(results[0].ok,true);
  assert.equal(results[1].ok,false);
  assert.equal(results[1].error.status,401);
  assert.equal(progressed.filter(result=>result.ok).length,1);
  assert.equal(writes,1);
});
test('deduplicates input reservations before a batch request',async()=>{
  let writes=0;
  const client=makeClient(async(url,options)=>{
    if(options.method==='POST'){writes++;return response(200,saved(JSON.parse(options.body)));}
    if(url.includes('/events?'))return response(200,{items:[]});
    return response(404);
  });
  assert.equal((await client.sync([booking,booking],'token','primary')).length,1);
  assert.equal(writes,1);
});
test('identifies configuration, expired connection and quota errors',()=>{
  assert.match(readableError(new CalendarError('',401)),/만료/);
  assert.match(readableError(new CalendarError('',403,'accessNotConfigured')),/사용 설정/);
  assert.match(readableError(new CalendarError('',403,'rateLimitExceeded')),/요청 한도/);
});
