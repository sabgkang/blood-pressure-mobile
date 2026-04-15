require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');

const app = express();
const PORT = 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ─── Mock database ────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }

function fmtDatetime(d) {
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Seeded pseudo-random for deterministic mock data
function seededRand(seed) {
  let s = seed;
  return () => { s = (s * 16807 + 0) % 2147483647; return (s - 1) / 2147483646; };
}

function generateMockData() {
  const rand = seededRand(20260415);
  const records = [];
  const base = new Date();
  base.setHours(0, 0, 0, 0);

  for (let d = 59; d >= 0; d--) {
    const day = new Date(base);
    day.setDate(day.getDate() - d);

    // Morning reading (always)
    records.push({
      datetime: fmtDatetime(new Date(day.getFullYear(), day.getMonth(), day.getDate(),
        7 + Math.floor(rand() * 2), Math.floor(rand() * 60))),
      sys: 112 + Math.floor(rand() * 28),
      dia: 68 + Math.floor(rand() * 22),
      hr:  58 + Math.floor(rand() * 28),
    });

    // Evening reading (~70% of days)
    if (rand() > 0.30) {
      records.push({
        datetime: fmtDatetime(new Date(day.getFullYear(), day.getMonth(), day.getDate(),
          19 + Math.floor(rand() * 3), Math.floor(rand() * 60))),
        sys: 114 + Math.floor(rand() * 26),
        dia: 70 + Math.floor(rand() * 20),
        hr:  60 + Math.floor(rand() * 26),
      });
    }
  }

  return records.sort((a, b) => a.datetime.localeCompare(b.datetime));
}

const mockRecords = generateMockData();

// ─── BP formatter ─────────────────────────────────────────────────────────────

function formatBP(text) {
  const digits = text.replace(/\D/g, '');

  if (digits.length < 5 || digits.length > 9) {
    return { text, error: `Cannot parse: digit count ${digits.length} is outside expected range (5–9)` };
  }

  for (let i = 2; i <= 3; i++) {
    for (let j = i + 2; j <= i + 3; j++) {
      const pulseLen = digits.length - j;
      if (pulseLen < 2 || pulseLen > 3) continue;

      const sys = parseInt(digits.substring(0, i), 10);
      const dia = parseInt(digits.substring(i, j), 10);
      const pul = parseInt(digits.substring(j), 10);

      const inRange =
        sys >= 60  && sys <= 250 &&
        dia >= 30  && dia <= 150 &&
        pul >= 30  && pul <= 220;

      if (inRange) {
        const formatted = `${sys},${dia},${pul}`;
        if (sys <= dia) {
          return { text: formatted, error: `ERROR: SYS (${sys}) must be greater than DIA (${dia})` };
        }
        return { text: formatted, error: null };
      }
    }
  }

  const bestSplits = [[3, 5], [3, 6], [2, 4], [2, 5]];
  for (const [i, j] of bestSplits) {
    const pulseLen = digits.length - j;
    if (pulseLen < 2 || pulseLen > 3) continue;
    const sys = parseInt(digits.substring(0, i), 10);
    const dia = parseInt(digits.substring(i, j), 10);
    const pul = parseInt(digits.substring(j), 10);
    const reasons = [];
    if (sys < 60  || sys > 250) reasons.push(`SYS ${sys} out of range (60–250)`);
    if (dia < 30  || dia > 150) reasons.push(`DIA ${dia} out of range (30–150)`);
    if (pul < 30  || pul > 220) reasons.push(`HR ${pul} out of range (30–220)`);
    if (reasons.length > 0) {
      return { text: `${sys},${dia},${pul}`, error: `ERROR: ${reasons.join('; ')}` };
    }
  }

  return { text, error: 'ERROR: Cannot parse valid blood pressure values from input' };
}

// ─── Query parser ─────────────────────────────────────────────────────────────

// Convert Chinese numeral string (e.g. "十二", "三十一") or Arabic string to integer
function cnToNum(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const map = { 零:0, 一:1, 二:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
  if (s === '十') return 10;
  if (s.startsWith('十')) return 10 + (map[s[1]] || 0);
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    return (map[a] || 0) * 10 + (map[b] || 0);
  }
  return map[s] || 0;
}

function startOfDay(d) {
  const r = new Date(d); r.setHours(0, 0, 0, 0); return r;
}
function endOfDay(d) {
  const r = new Date(d); r.setHours(23, 59, 59, 999); return r;
}

function parseQuery(text) {
  const now = new Date();
  const today = startOfDay(now);

  // ── Last 2 days ──
  if (/兩天|两天|[2二]天/.test(text)) {
    const from = new Date(today); from.setDate(from.getDate() - 1);
    return { from, to: endOfDay(now), label: '最近兩天' };
  }

  // ── 前N天 (last N days, N ≤ 31) ──
  const prevDayRe = /前([\d一二三四五六七八九十百兩两]+)天/;
  const pd = text.match(prevDayRe);
  if (pd) {
    const n = cnToNum(pd[1] === '兩' || pd[1] === '两' ? '2' : pd[1]);
    if (n > 31) return { error: `查詢範圍 ${n} 天超過一個月，請縮短查詢區間` };
    if (n < 1)  return { error: '天數無效' };
    const from = new Date(today); from.setDate(from.getDate() - (n - 1));
    return { from, to: endOfDay(now), label: `前${n}天` };
  }

  // ── This week (last 7 days) ──
  if (/本[週周]|這[週周]|这[週周]/.test(text)) {
    const from = new Date(today); from.setDate(from.getDate() - 6);
    return { from, to: endOfDay(now), label: '本週（最近7天）' };
  }

  // ── This month (last 30 days) ──
  if (/本月|這個月|这个月|這月|这月/.test(text)) {
    const from = new Date(today); from.setDate(from.getDate() - 29);
    return { from, to: endOfDay(now), label: '本月（最近30天）' };
  }

  // ── Date range: X月Y號到X月Z號 (Arabic or Chinese numerals) ──
  const numPat = '[\\d一二三四五六七八九十百]+';
  const rangeRe = new RegExp(
    `(${numPat})月(${numPat})[號号日]` +
    `[^月]*` +
    `(${numPat})月(${numPat})[號号日]`
  );
  const m = text.match(rangeRe);
  if (m) {
    const [, m1, d1, m2, d2] = m;
    const year = now.getFullYear();
    const from = new Date(year, cnToNum(m1) - 1, cnToNum(d1), 0, 0, 0);
    const to   = new Date(year, cnToNum(m2) - 1, cnToNum(d2), 23, 59, 59);

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return { error: '日期格式無法解析，請重新說明' };
    }
    if (to < from) {
      return { error: '日期範圍有誤：結束日期早於開始日期' };
    }
    const diffDays = (to - from) / 86400000;
    if (diffDays > 31) {
      return { error: `查詢範圍 ${Math.round(diffDays)} 天超過一個月，請縮短查詢區間` };
    }

    const label = `${cnToNum(m1)}月${cnToNum(d1)}日 至 ${cnToNum(m2)}月${cnToNum(d2)}日`;
    return { from, to, label };
  }

  return null; // not a recognised query
}

function queryRecords(from, to) {
  return mockRecords.filter(r => {
    const t = new Date(r.datetime.replace(' ', 'T'));
    return t >= from && t <= to;
  });
}

// ─── Intent detection ─────────────────────────────────────────────────────────

// If the transcription is 5–9 digits (possibly with spaces/punctuation), treat as BP entry.
// Otherwise attempt query parsing.
function detectIntent(text) {
  const digits = text.replace(/\D/g, '');
  if (digits.length >= 5 && digits.length <= 9 && text.replace(/[\d\s,，。.]/g, '').length === 0) {
    return 'bp';
  }
  return 'query';
}

// ─── Express setup ────────────────────────────────────────────────────────────

const storage = multer.memoryStorage();
const upload = multer({ storage });

app.use(express.static(path.join(__dirname, 'public')));

app.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file received' });
  }

  try {
    const form = new FormData();
    form.append('file', req.file.buffer, {
      filename: 'recording.webm',
      contentType: req.file.mimetype || 'audio/webm',
    });
    form.append('model', 'whisper-1');
    form.append('language', 'zh');
    form.append('prompt', '血壓數字或查詢記錄，例如：123,78,90 或 本週血壓');

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      form,
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() } }
    );

    const raw = response.data.text.trim();
    const intent = detectIntent(raw);

    if (intent === 'bp') {
      const { text, error } = formatBP(raw);
      // Only upload if BP parsed successfully
      let uploaded = false;
      if (!error) {
        const [sys, dia, hr] = text.split(',');
        const ur = req.body.btnId === 'btn1' ? 'A' : 'B';
        try {
          await axios.get(
            `https://n8n4090.yo3dp.cc/webhook/ESP32_To_BPR?UR=${ur}&BU=${sys}&BD=${dia}&HR=${hr}`
          );
          uploaded = true;
        } catch (uploadErr) {
          console.error('Upload failed:', uploadErr.message);
        }
      }
      return res.json({ type: 'bp', text, error, uploaded });
    }

    // Query intent
    const parsed = parseQuery(raw);
    if (!parsed) {
      return res.json({ type: 'bp', text: raw, error: null }); // fallback: show as-is
    }
    if (parsed.error) {
      return res.json({ type: 'query', error: parsed.error });
    }

    const records = queryRecords(parsed.from, parsed.to);
    return res.json({ type: 'query', label: parsed.label, records, error: null });

  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
