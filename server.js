require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');

const app = express();
const PORT = 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Parse a run of digits into { text, error }.
// Tries all 2-or-3 digit splits; picks the first that fits BP ranges,
// then validates SYS > DIA and reports specific errors.
function formatBP(text) {
  const digits = text.replace(/\D/g, '');

  if (digits.length < 5 || digits.length > 9) {
    return { text, error: `Cannot parse: digit count ${digits.length} is outside expected range (5–9)` };
  }

  for (let i = 2; i <= 3; i++) {           // SYS: 2–3 digits
    for (let j = i + 2; j <= i + 3; j++) { // DIA: 2–3 digits
      const pulseLen = digits.length - j;
      if (pulseLen < 2 || pulseLen > 3) continue; // HR: 2–3 digits

      const sys = parseInt(digits.substring(0, i), 10);
      const dia = parseInt(digits.substring(i, j), 10);
      const pul = parseInt(digits.substring(j), 10);

      const inRange =
        sys >= 60  && sys <= 250 &&   // SYS: hypotensive crisis ~ hypertensive emergency
        dia >= 30  && dia <= 150 &&   // DIA: extreme low ~ severe hypertension
        pul >= 30  && pul <= 220;     // HR:  extreme bradycardia ~ max exercise rate

      if (inRange) {
        const formatted = `${sys},${dia},${pul}`;
        if (sys <= dia) {
          return { text: formatted, error: `ERROR: SYS (${sys}) must be greater than DIA (${dia})` };
        }
        return { text: formatted, error: null };
      }
    }
  }

  // No split matched — use the most natural grouping to report which field is out of range.
  const bestSplits = [
    [3, 5], [3, 6], [2, 4], [2, 5]   // [i, j] combos ordered by likelihood
  ];
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
    // Hint Whisper to output numbers comma-separated
    form.append('prompt', '三個血壓數字，以逗號分開，例如：123,78,90');

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      form,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          ...form.getHeaders(),
        },
      }
    );

    const raw = response.data.text;
    const { text, error } = formatBP(raw);
    res.json({ text, error });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
