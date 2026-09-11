const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { RecordStore, cnToNum, createApp, detectIntent, formatBP, normalizeSpokenBP, parseQuery } = require('../blood-pressure-mobile-server');

test('解析中文數字', () => {
  assert.equal(cnToNum('兩'), 2);
  assert.equal(cnToNum('十二'), 12);
  assert.equal(cnToNum('二十一'), 21);
  assert.equal(cnToNum('一百零二'), 102);
});

test('解析與驗證血壓', () => {
  assert.deepEqual(formatBP('120 80 70'), { text: '120,80,70', error: null });
  assert.deepEqual(formatBP('123 100 88'), { text: '123,100,88', error: null });
  assert.deepEqual(formatBP('98 77 65'), { text: '98,77,65', error: null });
  assert.deepEqual(formatBP('9877100'), { text: '98,77,100', error: null });
  assert.deepEqual(formatBP('12080100'), { text: '120,80,100', error: null });
  assert.deepEqual(formatBP('180120100'), { text: '180,120,100', error: null });
  assert.match(formatBP('90,95,70').error, /收縮壓/);
  assert.deepEqual(formatBP('120,80,100'), { text: '120,80,100', error: null });
  assert.equal(detectIntent('120，80，70'), 'bp');
  assert.equal(detectIntent('180120100'), 'bp');
  assert.equal(detectIntent('今天血壓如何'), 'query');
  assert.equal(normalizeSpokenBP('一二三七七八八'), '1237788');
  assert.equal(normalizeSpokenBP('一二三 七七 八八'), '1237788');
  assert.deepEqual(formatBP(normalizeSpokenBP('一二三七七八八')), { text: '123,77,88', error: null });
  assert.deepEqual(formatBP(normalizeSpokenBP('一二零八零一零零')), { text: '120,80,100', error: null });
  assert.equal(normalizeSpokenBP('查詢前十二天'), '查詢前十二天');
});

test('相對日期不會把前12天誤判為兩天', () => {
  const result = parseQuery('查詢前12天', new Date(2026, 8, 11, 12));
  assert.equal(result.label, '前12天');
  assert.equal(result.from.getDate(), 31);
});

test('本週以星期一開始，本月以每月一日開始', () => {
  const reference = new Date(2026, 8, 11, 12);
  assert.equal(parseQuery('本週', reference).from.getDate(), 7);
  assert.equal(parseQuery('本月', reference).from.getDate(), 1);
});

test('拒絕不存在的日期並支援跨年範圍', () => {
  const reference = new Date(2026, 0, 2, 12);
  assert.match(parseQuery('2月30日到3月1日', reference).error, /不存在/);
  const crossYear = parseQuery('12月30日到1月2日', reference);
  assert.equal(crossYear.from.getFullYear(), 2025);
  assert.equal(crossYear.to.getFullYear(), 2026);
});

test('RecordStore 會持久保存及查詢真實紀錄', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bp-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'records.json');
  const store = new RecordStore(file);
  store.load();
  const record = { id: '1', datetime: '2026-09-11T02:00:00.000Z', user: 'A', sys: 120, dia: 80, hr: 70 };
  await store.add(record);
  const reloaded = new RecordStore(file);
  reloaded.load();
  assert.deepEqual(reloaded.query(new Date('2026-09-11T00:00:00Z'), new Date('2026-09-12T00:00:00Z')), [record]);
});

test('HTTP 端點要求登入', async t => {
  const store = { records: [], add: async () => {}, query: () => [] };
  const server = createApp({ username: 'paul', password: 'test-password', store }).listen(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base + '/health')).status, 401);
  const response = await fetch(base + '/health', {
    headers: { Authorization: 'Basic ' + Buffer.from('paul:test-password').toString('base64') },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('拒絕弱密碼與非 HTTPS Webhook', () => {
  assert.throws(
    () => createApp({ username: 'paul', password: 'short', store: {} }),
    /至少需要 12 個字元/,
  );
  assert.throws(
    () => createApp({ username: 'paul', password: 'test-password', webhookUrl: 'http://example.com', store: {} }),
    /必須使用 HTTPS/,
  );
  assert.throws(
    () => createApp({ username: 'paul', password: 'test-password', asrApiUrl: 'invalid', store: {} }),
    /ASR_API_URL 格式無效/,
  );
});

test('語音血壓會保存並透過 GET 同步', async t => {
  const saved = [];
  const calls = [];
  const store = { add: async record => saved.push(record), query: () => [] };
  const http = {
    post: async (url, body) => {
      calls.push({ url, body });
      if (url.includes('/audio/transcriptions')) return { data: { text: '120 80 70' } };
      return { data: { ok: true } };
    },
    get: async (url, config) => {
      calls.push({ url, ...config });
      return { data: { ok: true } };
    },
  };
  const server = createApp({
    username: 'paul',
    password: 'test-password',
    asrApiUrl: 'https://tea-asr4090.yo3dp.cc/v1/audio/transcriptions',
    webhookUrl: 'https://example.com/hook',
    store,
    http,
  }).listen(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));

  const form = new FormData();
  form.append('audio', new Blob([Buffer.from('audio')], { type: 'audio/webm' }), 'recording.webm');
  form.append('btnId', 'btn1');
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/transcribe', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from('paul:test-password').toString('base64') },
    body: form,
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.saved, true);
  assert.equal(result.synced, true);
  assert.equal(saved.length, 1);
  assert.deepEqual(calls[1].params, { UR: 'A', BU: 120, BD: 80, HR: 70 });
});
