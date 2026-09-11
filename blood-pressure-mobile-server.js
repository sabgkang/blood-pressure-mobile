require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'records.json');
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30000;

function formatBP(text) {
  const digits = text.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 9) {
    return { text, error: '無法解析：數字長度 ' + digits.length + ' 不符預期（6–9 位）' };
  }
  for (let i = 2; i <= 3; i++) {
    for (let j = i + 2; j <= i + 3; j++) {
      const pulseLen = digits.length - j;
      if (pulseLen < 2 || pulseLen > 3) continue;
      const sys = Number(digits.slice(0, i));
      const dia = Number(digits.slice(i, j));
      const hr = Number(digits.slice(j));
      if (sys >= 60 && sys <= 250 && dia >= 30 && dia <= 150 && hr >= 30 && hr <= 220) {
        const formatted = [sys, dia, hr].join(',');
        return sys > dia
          ? { text: formatted, error: null }
          : { text: formatted, error: '收縮壓（' + sys + '）必須高於舒張壓（' + dia + '）' };
      }
    }
  }
  return { text, error: '無法從輸入內容解析出合理的血壓與心率' };
}

function cnToNum(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = { 零: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0;
  let current = 0;
  for (const char of value) {
    if (char in digits) current = digits[char];
    else if (char === '十') { total += (current || 1) * 10; current = 0; }
    else if (char === '百') { total += (current || 1) * 100; current = 0; }
    else return NaN;
  }
  return total + current;
}

function startOfDay(date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function endOfDay(date) {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
}

function validLocalDate(year, month, day, end) {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = end
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function parseQuery(text, referenceDate) {
  const now = new Date(referenceDate || Date.now());
  const today = startOfDay(now);
  const previousDays = text.match(/前([\d一二三四五六七八九十百兩两]+)天/);
  if (previousDays) {
    const days = cnToNum(previousDays[1]);
    if (!Number.isInteger(days) || days < 1) return { error: '天數無效' };
    if (days > 31) return { error: '查詢範圍 ' + days + ' 天超過一個月，請縮短查詢區間' };
    const from = new Date(today);
    from.setDate(from.getDate() - days + 1);
    return { from, to: endOfDay(now), label: '前' + days + '天' };
  }
  if (/(?:最近|近)?(?:兩|两|二|2)天/.test(text)) {
    const from = new Date(today);
    from.setDate(from.getDate() - 1);
    return { from, to: endOfDay(now), label: '最近兩天' };
  }
  if (/本[週周]|這[週周]|这[週周]/.test(text)) {
    const from = new Date(today);
    from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
    return { from, to: endOfDay(now), label: '本週' };
  }
  if (/本月|這個月|这个月|這月|这月/.test(text)) {
    return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: endOfDay(now), label: '本月' };
  }

  const number = '[\\d一二三四五六七八九十百兩两]+';
  const range = new RegExp('(' + number + ')月(' + number + ')[號号日][^月]*(' + number + ')月(' + number + ')[號号日]');
  const match = text.match(range);
  if (!match) return null;
  const startMonth = cnToNum(match[1]);
  const startDay = cnToNum(match[2]);
  const endMonth = cnToNum(match[3]);
  const endDay = cnToNum(match[4]);
  let startYear = now.getFullYear();
  const endYear = now.getFullYear();
  if (startMonth > endMonth) startYear -= 1;
  const from = validLocalDate(startYear, startMonth, startDay, false);
  const to = validLocalDate(endYear, endMonth, endDay, true);
  if (!from || !to) return { error: '日期不存在，請重新說明' };
  if (to < from) return { error: '日期範圍有誤：結束日期早於開始日期' };
  const days = Math.floor((startOfDay(to) - startOfDay(from)) / 86400000) + 1;
  if (days > 31) return { error: '查詢範圍 ' + days + ' 天超過一個月，請縮短查詢區間' };
  const yearLabel = startYear !== endYear ? startYear + '年' : '';
  return { from, to, label: yearLabel + startMonth + '月' + startDay + '日 至 ' + endMonth + '月' + endDay + '日' };
}

function detectIntent(text) {
  const digits = text.replace(/\D/g, '');
  const numericOnly = text.replace(/[\d\s,，。./／、]/g, '').length === 0;
  return digits.length >= 6 && digits.length <= 9 && numericOnly ? 'bp' : 'query';
}

function safeEqual(actual, expected) {
  const a = Buffer.from(actual || '');
  const b = Buffer.from(expected || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function basicAuth(username, password) {
  return (req, res, next) => {
    const encoded = req.headers.authorization && req.headers.authorization.match(/^Basic\s+(.+)$/i);
    let suppliedUser = '';
    let suppliedPassword = '';
    if (encoded) {
      try {
        [suppliedUser, suppliedPassword] = Buffer.from(encoded[1], 'base64').toString('utf8').split(/:(.*)/s, 2);
      } catch { /* invalid credentials */ }
    }
    if (safeEqual(suppliedUser, username) && safeEqual(suppliedPassword, password)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Blood Pressure Assistant", charset="UTF-8"');
    return res.status(401).send('需要登入');
  };
}

function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.get('host')) return next();
  } catch { /* invalid origin */ }
  return res.status(403).json({ error: '不允許跨來源請求' });
}

function rateLimiter(windowMs, max) {
  const clients = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const entry = clients.get(req.ip);
    if (!entry || now >= entry.resetAt) {
      clients.set(req.ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count <= max) return next();
    res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
    return res.status(429).json({ error: '請求過於頻繁，請稍後再試' });
  };
}

class RecordStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.records = [];
    this.writeQueue = Promise.resolve();
  }
  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(data)) throw new Error('紀錄檔格式錯誤');
      this.records = data;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  async add(record) {
    const operation = this.writeQueue.then(async () => {
      const nextRecords = [...this.records, record];
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      const tempFile = this.filePath + '.' + process.pid + '.tmp';
      await fsp.writeFile(tempFile, JSON.stringify(nextRecords, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(tempFile, this.filePath);
      this.records = nextRecords;
    });
    this.writeQueue = operation.catch(() => {});
    await operation;
  }
  query(from, to) {
    return this.records.filter(record => {
      const timestamp = new Date(record.datetime);
      return Number.isFinite(timestamp.getTime()) && timestamp >= from && timestamp <= to;
    }).sort((a, b) => a.datetime.localeCompare(b.datetime));
  }
}

function createApp(options) {
  options = options || {};
  const config = {
    openaiApiKey: options.openaiApiKey === undefined ? process.env.OPENAI_API_KEY : options.openaiApiKey,
    webhookUrl: options.webhookUrl === undefined ? process.env.WEBHOOK_URL : options.webhookUrl,
    username: options.username === undefined ? process.env.APP_USERNAME : options.username,
    password: options.password === undefined ? process.env.APP_PASSWORD : options.password,
    timeout: options.timeout || REQUEST_TIMEOUT_MS,
  };
  if (!config.username || !config.password) throw new Error('必須設定 APP_USERNAME 與 APP_PASSWORD');
  if (config.password.length < 12) throw new Error('APP_PASSWORD 至少需要 12 個字元');
  if (config.webhookUrl) {
    let webhook;
    try {
      webhook = new URL(config.webhookUrl);
    } catch {
      throw new Error('WEBHOOK_URL 格式無效');
    }
    if (webhook.protocol !== 'https:') throw new Error('WEBHOOK_URL 必須使用 HTTPS');
  }
  const store = options.store || new RecordStore(DATA_FILE);
  if (!options.store) store.load();
  const http = options.http || axios;
  const app = express();

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Permissions-Policy': 'microphone=(self)',
      'Cache-Control': req.path === '/transcribe' ? 'no-store' : 'no-cache',
    });
    next();
  });
  app.use(basicAuth(config.username, config.password));
  app.use(express.static(path.join(__dirname, 'public')));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 2 },
    fileFilter: (_req, file, callback) => callback(null, /^audio\//i.test(file.mimetype)),
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.post('/transcribe', sameOrigin, rateLimiter(15 * 60000, 20), upload.single('audio'), async (req, res) => {
    if (!config.openaiApiKey) return res.status(503).json({ error: '伺服器尚未設定語音辨識服務' });
    if (!req.file) return res.status(400).json({ error: '沒有收到音訊檔案' });
    if (!['btn1', 'btn2'].includes(req.body.btnId)) return res.status(400).json({ error: '使用者按鈕無效' });
    try {
      const form = new FormData();
      const extension = req.file.mimetype.includes('mp4') ? 'm4a' : req.file.mimetype.includes('ogg') ? 'ogg' : 'webm';
      form.append('file', req.file.buffer, { filename: 'recording.' + extension, contentType: req.file.mimetype });
      form.append('model', 'whisper-1');
      form.append('language', 'zh');
      form.append('prompt', '血壓數字或查詢記錄，例如：123,78,90 或 本週血壓');
      const response = await http.post('https://api.openai.com/v1/audio/transcriptions', form, {
        headers: { Authorization: 'Bearer ' + config.openaiApiKey, ...form.getHeaders() },
        timeout: config.timeout,
        maxContentLength: MAX_AUDIO_BYTES + 1048576,
        maxBodyLength: MAX_AUDIO_BYTES + 1048576,
      });
      const raw = String(response.data && response.data.text || '').trim();
      if (!raw) return res.status(422).json({ type: 'unknown', error: '沒有辨識到語音內容' });

      if (detectIntent(raw) === 'bp') {
        const parsed = formatBP(raw);
        if (parsed.error) return res.status(422).json({ type: 'bp', ...parsed, saved: false, synced: false });
        const [sys, dia, hr] = parsed.text.split(',').map(Number);
        const record = {
          id: crypto.randomUUID(),
          datetime: new Date().toISOString(),
          user: req.body.btnId === 'btn1' ? 'A' : 'B',
          sys, dia, hr,
        };
        await store.add(record);
        let synced = false;
        let syncError = null;
        if (config.webhookUrl) {
          try {
            await http.post(config.webhookUrl, { UR: record.user, BU: sys, BD: dia, HR: hr }, {
              timeout: config.timeout,
              headers: { 'Content-Type': 'application/json' },
            });
            synced = true;
          } catch (error) {
            syncError = '遠端同步失敗，本機紀錄已保存';
            console.error('Webhook sync failed:', error.message);
          }
        }
        return res.json({ type: 'bp', text: parsed.text, error: null, saved: true, synced, syncError, syncConfigured: Boolean(config.webhookUrl) });
      }

      const parsedQuery = parseQuery(raw);
      if (!parsedQuery) return res.status(422).json({ type: 'unknown', error: '無法理解「' + raw + '」，請說血壓數字或日期範圍' });
      if (parsedQuery.error) return res.status(422).json({ type: 'query', error: parsedQuery.error });
      return res.json({ type: 'query', label: parsedQuery.label, records: store.query(parsedQuery.from, parsedQuery.to), error: null });
    } catch (error) {
      console.error('Transcription failed:', error.message);
      const status = error.code === 'ECONNABORTED' ? 504 : 502;
      return res.status(status).json({ error: status === 504 ? '語音辨識服務逾時，請重試' : '語音辨識服務暫時無法使用' });
    }
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: '音訊檔案過大，上限為 15 MB' });
    }
    if (error) console.error('Request failed:', error.message);
    return res.status(400).json({ error: '無法處理上傳內容' });
  });
  return app;
}

if (require.main === module) {
  try {
    createApp().listen(PORT, () => console.log('Server running at http://localhost:' + PORT));
  } catch (error) {
    console.error('Startup failed: ' + error.message);
    process.exitCode = 1;
  }
}

module.exports = { RecordStore, cnToNum, createApp, detectIntent, formatBP, parseQuery, validLocalDate };
