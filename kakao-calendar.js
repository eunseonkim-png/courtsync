(function (root) {
  'use strict';
  function validEndpoint(value) {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; } catch { return false; }
  }
  function createClient(endpoint) {
    if (!validEndpoint(endpoint)) throw new Error('카카오 연결 서버 주소를 먼저 설정해 주세요.');
    const origin = new URL(endpoint).origin;
    let session = null;
    function connect() {
      const nonce = root.crypto.randomUUID();
      const popup = root.open(`${origin}/login?nonce=${encodeURIComponent(nonce)}`, 'courtsync-kakao', 'width=500,height=720');
      if (!popup) return Promise.reject(new Error('팝업을 허용한 뒤 카카오 연결을 다시 눌러 주세요.'));
      return new Promise((resolve, reject) => {
        const cleanup = () => { root.removeEventListener('message', receive); clearInterval(timer); clearTimeout(timeout); };
        const receive = event => {
          if (event.origin !== origin || event.source !== popup || event.data?.type !== 'courtsync-kakao' || event.data.nonce !== nonce) return;
          cleanup();
          if (event.data.error) { reject(new Error(event.data.error)); return; }
          if (typeof event.data.session !== 'string' || !/^[a-f0-9]{64}$/.test(event.data.accountKey) || !Number.isFinite(event.data.expiresAt)) { reject(new Error('연결 응답을 확인하지 못했습니다.')); return; }
          session = event.data; resolve({ accountKey: session.accountKey });
        };
        root.addEventListener('message', receive);
        const timer = setInterval(() => { if (popup.closed) { cleanup(); reject(new Error('카카오 연결 창이 닫혔습니다.')); } }, 1000);
        const timeout = setTimeout(() => { cleanup(); reject(new Error('카카오 연결 시간이 지났습니다. 다시 연결해 주세요.')); }, 300000);
      });
    }
    async function syncOne(booking) {
      if (!session || session.expiresAt <= Date.now()) throw new Error('카카오 연결이 만료됐어요. 다시 연결해 주세요.');
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await root.fetch(`${origin}/event`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.session}` }, body: JSON.stringify(booking), signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
        const data = await response.json();
        if (!response.ok) { if (response.status === 401) session = null; throw new Error(data.error || '카카오 등록을 완료하지 못했습니다.'); }
        return data;
      } finally { clearTimeout(timer); }
    }
    return { connect, syncOne, connected: () => Boolean(session && session.expiresAt > Date.now()), disconnect: () => { session = null; } };
  }
  const api = { validEndpoint, createClient };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CourtSyncKakao = api;
}(typeof window === 'undefined' ? globalThis : window));
