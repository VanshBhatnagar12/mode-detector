const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';

let facingMode    = 'user';
let currentStream = null;

const MOOD_MAP = {
  happy:     { color: '#f59e0b', message: 'You look happy! Keep smiling!' },
  sad:       { color: '#3b82f6', message: "It's okay to feel sad. Take a deep breath." },
  angry:     { color: '#ef4444', message: 'Take a moment to cool down.' },
  fearful:   { color: '#8b5cf6', message: "You seem scared. You're safe here." },
  disgusted: { color: '#10b981', message: 'Something bothering you?' },
  surprised: { color: '#f97316', message: 'Something caught you off guard!' },
  neutral:   { color: '#64748b', message: 'Feeling neutral. Nice and calm.' },
  excited:   { color: '#fbbf24', message: "You're bursting with excitement!" },
  anxious:   { color: '#7c3aed', message: 'Feeling anxious? Breathe slowly.' },
  contempt:  { color: '#ec4899', message: "Something's not sitting right with you." },
  calm:      { color: '#14b8a6', message: 'You look calm and collected.' },
  bored:     { color: '#94a3b8', message: 'Looks like you need some excitement!' },
  confused:  { color: '#f97316', message: "Feeling puzzled? That's okay." },
  tired:     { color: '#06b6d4', message: 'You look tired. Rest up!' },
};

const PERSON_COLORS  = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6'];
const CONFIRM_FRAMES = 2;
const IOU_THRESHOLD  = 0.3; // overlap threshold for position-based tracking

function getDerivedEmotion(e) {
  if (e.happy > 0.5 && e.surprised > 0.2)   return 'excited';
  if (e.fearful > 0.3 && e.sad > 0.2)        return 'anxious';
  if (e.disgusted > 0.3 && e.angry > 0.2)    return 'contempt';
  if (e.neutral > 0.6 && e.sad > 0.1)        return 'bored';
  if (e.neutral > 0.7)                        return 'calm';
  if (e.fearful > 0.2 && e.surprised > 0.2)  return 'confused';
  if (e.sad > 0.4 && e.neutral > 0.3)        return 'tired';
  return null;
}

function formatTime(ms) { return (ms / 1000).toFixed(1) + 's'; }

// IoU-based position matching (works without face descriptors)
function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

const video        = document.getElementById('video');
const overlay      = document.getElementById('overlay');
const statusEl     = document.getElementById('status');
const moodCard     = document.getElementById('mood-card');
const moodLabel    = document.getElementById('mood-label');
const barContainer = document.getElementById('mood-bar-container');
const flipBtn      = document.getElementById('flip-btn');
const debugEl      = document.getElementById('debug');
const faceCanvas   = document.getElementById('face-canvas');
const faceCtx      = faceCanvas.getContext('2d');
const timerWrap    = document.getElementById('timer-bar-wrap');
const timerCount   = document.getElementById('timer-count');
const timerFill    = document.getElementById('timer-fill');

const SCAN_DURATION = 15000;
let scanStartTime   = null;
let scanDone        = false;

// persons: { box, accumulator, sampleCount, firstSeen, lastSeen, active, photo, missedFrames }
let persons      = [];
let pendingFaces = []; // { box, count }

const cropCanvas = document.createElement('canvas');
const cropCtx    = cropCanvas.getContext('2d');

async function loadModels() {
  statusEl.textContent = 'Loading AI models...';
  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL),
    ]);
    statusEl.textContent = 'Models loaded. Starting camera...';
    await startCamera();
  } catch(err) {
    statusEl.textContent = 'Failed to load models: ' + err.message;
  }
}

async function startCamera() {
  if (currentStream) currentStream.getTracks().forEach(t => t.stop());
  scanStartTime = null;
  scanDone      = false;
  persons       = [];
  pendingFaces  = [];
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 640 }, height: { ideal: 480 } }
    });
    currentStream  = stream;
    video.srcObject = stream;
    await new Promise(resolve => { video.onloadedmetadata = resolve; });
    await video.play();

    // Fix mobile rotation
    const track    = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    const w = settings.width  || video.videoWidth;
    const h = settings.height || video.videoHeight;
    overlay.width  = w;
    overlay.height = h;

    statusEl.textContent = 'Detecting mood...';
    detectLoop();
  } catch (err) {
    statusEl.textContent = '⚠️ Camera access denied. Please allow camera permissions.';
  }
}

flipBtn.addEventListener('click', async () => {
  facingMode = facingMode === 'user' ? 'environment' : 'user';
  video.classList.toggle('rear', facingMode === 'environment');
  overlay.classList.toggle('rear', facingMode === 'environment');
  await startCamera();
});

async function detectLoop() {
  // Lower scoreThreshold + larger inputSize helps detect faces with caps
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.25 });
  const ctx     = overlay.getContext('2d');

  const detect = async () => {
    if (scanDone) return;
    try {
      const results = await faceapi
        .detectAllFaces(video, options)
        .withFaceLandmarks()
        .withFaceExpressions();

      ctx.clearRect(0, 0, overlay.width, overlay.height);

      if (results.length > 0) {
        if (!scanStartTime) {
          scanStartTime = Date.now();
          timerWrap.classList.remove('hidden');
        }

        const elapsed      = Date.now() - scanStartTime;
        const matched      = new Set();
        const newPending   = [];

        results.forEach(result => {
          const box = result.detection.box;

          // Match to existing person by IoU
          let bestIdx  = -1;
          let bestIou  = IOU_THRESHOLD;
          persons.forEach((p, i) => {
            const score = iou(box, p.box);
            if (score > bestIou) { bestIou = score; bestIdx = i; }
          });

          if (bestIdx !== -1 && !matched.has(bestIdx)) {
            matched.add(bestIdx);
            const p      = persons[bestIdx];
            p.box        = box;
            p.lastSeen   = elapsed;
            p.active     = true;
            p.missedFrames = 0;
            const expressions = result.expressions;
            Object.keys(p.accumulator).forEach(k => { p.accumulator[k] += expressions[k] || 0; });
            p.sampleCount++;
            drawPersonOnCanvas(ctx, result, bestIdx, expressions);
          } else {
            // Check pending
            let pi = -1, pBest = IOU_THRESHOLD;
            pendingFaces.forEach((pf, i) => {
              const score = iou(box, pf.box);
              if (score > pBest) { pBest = score; pi = i; }
            });

            if (pi !== -1) {
              pendingFaces[pi].count++;
              pendingFaces[pi].box = box;
              if (pendingFaces[pi].count >= CONFIRM_FRAMES) {
                const photo  = captureFace(box);
                const newIdx = persons.length;
                persons.push({
                  box, photo,
                  accumulator:  { happy:0, sad:0, angry:0, fearful:0, disgusted:0, surprised:0, neutral:0 },
                  sampleCount:  0,
                  firstSeen:    elapsed,
                  lastSeen:     elapsed,
                  active:       true,
                  missedFrames: 0,
                });
                matched.add(newIdx);
                drawPersonOnCanvas(ctx, result, newIdx, result.expressions);
              } else {
                newPending.push(pendingFaces[pi]);
              }
            } else {
              newPending.push({ box, count: 1 });
            }
          }
        });

        pendingFaces = newPending;
        persons.forEach((p, i) => {
          if (!matched.has(i)) {
            p.missedFrames = (p.missedFrames || 0) + 1;
            p.active = false;
          }
        });

        updateMoodCard();
        moodCard.classList.remove('hidden');

        const remaining = Math.max(0, Math.ceil((SCAN_DURATION - elapsed) / 1000));
        timerCount.textContent = remaining;
        timerFill.style.width  = Math.min((elapsed / SCAN_DURATION) * 100, 100) + '%';
        statusEl.textContent   = `${results.length} face${results.length > 1 ? 's' : ''} detected`;

        if (elapsed >= SCAN_DURATION) {
          scanDone = true;
          const finalData = persons.map((p, i) => {
            const avg = {};
            Object.keys(p.accumulator).forEach(k => {
              avg[k] = p.sampleCount > 0 ? p.accumulator[k] / p.sampleCount : 0;
            });
            return { name: `Person ${i + 1}`, avg, firstSeen: p.firstSeen, lastSeen: p.lastSeen, photo: p.photo || null };
          });
          localStorage.setItem('md_result', JSON.stringify(finalData));
          window.location.href = 'result.html';
          return;
        }

      } else {
        persons.forEach(p => p.active = false);
        pendingFaces = [];
        moodCard.classList.add('hidden');
        faceCtx.clearRect(0, 0, faceCanvas.width, faceCanvas.height);
        statusEl.textContent = 'No face detected. Please look at the camera.';
      }

    } catch(err) {
      debugEl.textContent = err.message;
    }
    setTimeout(detect, 100);
  };

  detect();
}

function drawPersonOnCanvas(ctx, result, personIdx, expressions) {
  const color      = PERSON_COLORS[personIdx % PERSON_COLORS.length];
  const box        = result.detection.box;
  const dominant   = expressions.asSortedArray()[0];
  const emotionKey = getDerivedEmotion(expressions) || dominant.expression;

  ctx.strokeStyle = color;
  ctx.lineWidth   = 3;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  const label = `Person ${personIdx + 1}: ${emotionKey.toUpperCase()}`;
  ctx.font     = 'bold 14px Segoe UI';
  const tw     = ctx.measureText(label).width;
  ctx.fillStyle = color;
  ctx.fillRect(box.x, box.y - 24, tw + 10, 22);
  ctx.fillStyle = '#fff';
  ctx.fillText(label, box.x + 5, box.y - 7);

  drawLandmarks(ctx, result.landmarks, color);
}

function drawLandmarks(ctx, landmarks, color) {
  ctx.fillStyle   = color;
  ctx.strokeStyle = color;
  ctx.lineWidth   = 1.2;
  ctx.globalAlpha = 0.5;
  landmarks.positions.forEach(pt => {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 1.5, 0, Math.PI * 2);
    ctx.fill();
  });
  [
    landmarks.getJawOutline(), landmarks.getLeftEyeBrow(), landmarks.getRightEyeBrow(),
    landmarks.getLeftEye(), landmarks.getRightEye(), landmarks.getNose(), landmarks.getMouth(),
  ].forEach(group => {
    ctx.beginPath();
    group.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
}

function updateMoodCard() {
  faceCtx.clearRect(0, 0, faceCanvas.width, faceCanvas.height);
  moodLabel.textContent = `${persons.length} Person${persons.length > 1 ? 's' : ''} Detected`;
  moodLabel.style.color = '#0369a1';
  barContainer.innerHTML = '';
  persons.forEach((p, i) => {
    const color      = PERSON_COLORS[i % PERSON_COLORS.length];
    const sorted     = Object.entries(p.accumulator).sort((a, b) => b[1] - a[1]);
    const emotionKey = sorted[0][0];
    const pct        = p.sampleCount > 0 ? Math.round((sorted[0][1] / p.sampleCount) * 100) : 0;
    const photoHtml  = p.photo
      ? `<img src="${p.photo}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;border:2px solid ${color};flex-shrink:0;"/>`
      : `<div style="width:40px;height:40px;border-radius:50%;background:#f1f5f9;border:2px solid ${color};display:flex;align-items:center;justify-content:center;font-size:1.2rem;flex-shrink:0;">👤</div>`;
    barContainer.innerHTML += `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f1f5f9;">
        ${photoHtml}
        <div style="flex:1;">
          <div style="font-weight:700;color:${color};font-size:0.85rem;">
            Person ${i + 1} <span style="font-size:0.7rem;">${p.active ? '🟢 in frame' : '⚫ left'}</span>
          </div>
          <div style="font-size:0.8rem;color:#475569;">${emotionKey} — ${pct}%</div>
        </div>
      </div>`;
  });
}

function captureFace(box) {
  const pad = 24;
  const x   = Math.max(0, box.x - pad);
  const y   = Math.max(0, box.y - pad);
  const w   = Math.min(video.videoWidth  - x, box.width  + pad * 2);
  const h   = Math.min(video.videoHeight - y, box.height + pad * 2);
  cropCanvas.width  = w;
  cropCanvas.height = h;
  cropCtx.drawImage(video, x, y, w, h, 0, 0, w, h);
  return cropCanvas.toDataURL('image/jpeg', 0.7);
}

window.addEventListener('load', loadModels);
