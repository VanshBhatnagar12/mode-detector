const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';

let facingMode = 'user';
let currentStream = null;

const PERSON_COLORS = ['#74e0ff', '#ff7b93', '#70f0a6', '#ffcc67', '#a58bff'];
const CONFIRM_FRAMES = 2;
const IOU_THRESHOLD = 0.3;
const SCAN_DURATION = 10000;

const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const statusEl = document.getElementById('status');
const moodCard = document.getElementById('mood-card');
const moodLabel = document.getElementById('mood-label');
const barContainer = document.getElementById('mood-bar-container');
const flipBtn = document.getElementById('flip-btn');
const debugEl = document.getElementById('debug');
const faceCanvas = document.getElementById('face-canvas');
const faceCtx = faceCanvas.getContext('2d');
const timerWrap = document.getElementById('timer-bar-wrap');
const timerCount = document.getElementById('timer-count');
const timerFill = document.getElementById('timer-fill');
const signalPill = document.getElementById('signal-pill');
const statFaces = document.getElementById('stat-faces');
const statMode = document.getElementById('stat-mode');
const statPhase = document.getElementById('stat-phase');

let scanStartTime = null;
let scanDone = false;
let persons = [];
let pendingFaces = [];

const cropCanvas = document.createElement('canvas');
const cropCtx = cropCanvas.getContext('2d');

function getDerivedEmotion(expressions) {
  if (expressions.happy > 0.5 && expressions.surprised > 0.2) return 'excited';
  if (expressions.fearful > 0.3 && expressions.sad > 0.2) return 'anxious';
  if (expressions.disgusted > 0.3 && expressions.angry > 0.2) return 'contempt';
  if (expressions.neutral > 0.6 && expressions.sad > 0.1) return 'bored';
  if (expressions.neutral > 0.7) return 'calm';
  if (expressions.fearful > 0.2 && expressions.surprised > 0.2) return 'confused';
  if (expressions.sad > 0.4 && expressions.neutral > 0.3) return 'tired';
  return null;
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function setStatus(message, tone, phase) {
  statusEl.textContent = message;
  signalPill.textContent = phase;
  signalPill.className = `signal-pill signal-${tone}`;
  statPhase.textContent = phase;
}

function updateStats(faceCount) {
  statFaces.textContent = String(faceCount);
  statMode.textContent = facingMode === 'user' ? 'Front' : 'Rear';
}

function drawRadar() {
  faceCtx.clearRect(0, 0, faceCanvas.width, faceCanvas.height);
  const centerX = faceCanvas.width / 2;
  const centerY = faceCanvas.height / 2;
  const rings = [22, 38, 54];

  faceCtx.strokeStyle = 'rgba(116, 224, 255, 0.18)';
  faceCtx.lineWidth = 1;
  rings.forEach(radius => {
    faceCtx.beginPath();
    faceCtx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    faceCtx.stroke();
  });

  faceCtx.beginPath();
  faceCtx.moveTo(14, centerY);
  faceCtx.lineTo(faceCanvas.width - 14, centerY);
  faceCtx.moveTo(centerX, 14);
  faceCtx.lineTo(centerX, faceCanvas.height - 14);
  faceCtx.stroke();

  persons.forEach((person, index) => {
    const angle = ((index + 1) / Math.max(persons.length, 1)) * Math.PI * 1.6;
    const radius = 22 + (index % rings.length) * 16;
    const x = centerX + Math.cos(angle) * radius;
    const y = centerY + Math.sin(angle) * radius;
    faceCtx.fillStyle = PERSON_COLORS[index % PERSON_COLORS.length];
    faceCtx.beginPath();
    faceCtx.arc(x, y, person.active ? 5 : 3.5, 0, Math.PI * 2);
    faceCtx.fill();
  });
}

async function loadModels() {
  updateStats(0);
  setStatus('Loading AI models...', 'idle', 'Booting');

  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL),
    ]);

    setStatus('Models loaded. Starting camera...', 'idle', 'Ready');
    await startCamera();
  } catch (error) {
    setStatus(`Failed to load models: ${error.message}`, 'error', 'Fault');
  }
}

async function startCamera() {
  if (currentStream) currentStream.getTracks().forEach(track => track.stop());

  scanStartTime = null;
  scanDone = false;
  persons = [];
  pendingFaces = [];
  updateStats(0);
  moodCard.classList.add('hidden');
  timerWrap.classList.add('hidden');
  timerFill.style.width = '0%';
  drawRadar();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 640 }, height: { ideal: 480 } },
    });

    currentStream = stream;
    video.srcObject = stream;
    await new Promise(resolve => {
      video.onloadedmetadata = resolve;
    });
    await video.play();

    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    overlay.width = settings.width || video.videoWidth;
    overlay.height = settings.height || video.videoHeight;

    updateStats(0);
    setStatus('Camera online. Waiting for a face in frame.', 'idle', 'Standby');
    detectLoop();
  } catch (error) {
    setStatus('Camera access denied. Please allow camera permissions.', 'error', 'Blocked');
  }
}

flipBtn.addEventListener('click', async () => {
  facingMode = facingMode === 'user' ? 'environment' : 'user';
  video.classList.toggle('rear', facingMode === 'environment');
  overlay.classList.toggle('rear', facingMode === 'environment');
  setStatus('Switching camera feed...', 'alert', 'Switching');
  await startCamera();
});

async function detectLoop() {
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.25 });
  const ctx = overlay.getContext('2d');

  const detect = async () => {
    if (scanDone) return;

    try {
      const results = await faceapi.detectAllFaces(video, options).withFaceLandmarks().withFaceExpressions();
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      debugEl.textContent = '';

      if (results.length > 0) {
        if (!scanStartTime) {
          scanStartTime = Date.now();
          timerWrap.classList.remove('hidden');
        }

        const elapsed = Date.now() - scanStartTime;
        const matched = new Set();
        const newPending = [];

        results.forEach(result => {
          const box = result.detection.box;
          let bestIdx = -1;
          let bestIou = IOU_THRESHOLD;

          persons.forEach((person, index) => {
            const score = iou(box, person.box);
            if (score > bestIou) {
              bestIou = score;
              bestIdx = index;
            }
          });

          if (bestIdx !== -1 && !matched.has(bestIdx)) {
            matched.add(bestIdx);
            const person = persons[bestIdx];
            person.box = box;
            person.lastSeen = elapsed;
            person.active = true;
            person.missedFrames = 0;
            Object.keys(person.accumulator).forEach(key => {
              person.accumulator[key] += result.expressions[key] || 0;
            });
            person.sampleCount += 1;
            drawPersonOnCanvas(ctx, result, bestIdx);
            return;
          }

          let pendingIndex = -1;
          let pendingBest = IOU_THRESHOLD;
          pendingFaces.forEach((pendingFace, index) => {
            const score = iou(box, pendingFace.box);
            if (score > pendingBest) {
              pendingBest = score;
              pendingIndex = index;
            }
          });

          if (pendingIndex !== -1) {
            pendingFaces[pendingIndex].count += 1;
            pendingFaces[pendingIndex].box = box;
            if (pendingFaces[pendingIndex].count >= CONFIRM_FRAMES) {
              const newIndex = persons.length;
              persons.push({
                box,
                photo: captureFace(box),
                accumulator: { happy: 0, sad: 0, angry: 0, fearful: 0, disgusted: 0, surprised: 0, neutral: 0 },
                sampleCount: 0,
                firstSeen: elapsed,
                lastSeen: elapsed,
                active: true,
                missedFrames: 0,
              });
              matched.add(newIndex);
              drawPersonOnCanvas(ctx, result, newIndex);
            } else {
              newPending.push(pendingFaces[pendingIndex]);
            }
          } else {
            newPending.push({ box, count: 1 });
          }
        });

        pendingFaces = newPending;
        persons.forEach((person, index) => {
          if (!matched.has(index)) {
            person.missedFrames = (person.missedFrames || 0) + 1;
            person.active = false;
          }
        });

        updateMoodCard();
        updateStats(results.length);
        moodCard.classList.remove('hidden');

        const remaining = Math.max(0, Math.ceil((SCAN_DURATION - elapsed) / 1000));
        timerCount.textContent = remaining;
        timerFill.style.width = `${Math.min((elapsed / SCAN_DURATION) * 100, 100)}%`;
        setStatus(`${results.length} face${results.length > 1 ? 's' : ''} tracked in frame.`, 'live', 'Scanning');

        if (elapsed >= SCAN_DURATION) {
          scanDone = true;
          setStatus('Scan complete. Building the result view...', 'live', 'Complete');
          const finalData = persons.map((person, index) => {
            const avg = {};
            Object.keys(person.accumulator).forEach(key => {
              avg[key] = person.sampleCount > 0 ? person.accumulator[key] / person.sampleCount : 0;
            });
            return { name: `Person ${index + 1}`, avg, firstSeen: person.firstSeen, lastSeen: person.lastSeen, photo: person.photo || null };
          });
          localStorage.setItem('md_result', JSON.stringify(finalData));
          window.location.href = 'result.html';
          return;
        }
      } else {
        persons.forEach(person => {
          person.active = false;
        });
        pendingFaces = [];
        updateStats(0);
        drawRadar();
        moodCard.classList.add('hidden');
        setStatus('No face detected. Move into the camera frame.', 'alert', 'Searching');
      }
    } catch (error) {
      debugEl.textContent = error.message;
      setStatus('Live analysis hit an error.', 'error', 'Fault');
    }

    setTimeout(detect, 100);
  };

  detect();
}

function drawPersonOnCanvas(ctx, result, personIdx) {
  const color = PERSON_COLORS[personIdx % PERSON_COLORS.length];
  const box = result.detection.box;
  const dominant = result.expressions.asSortedArray()[0];
  const emotionKey = getDerivedEmotion(result.expressions) || dominant.expression;
  const isFront = facingMode === 'user';
  const x = isFront ? overlay.width - box.x - box.width : box.x;

  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.shadowBlur = 18;
  ctx.shadowColor = color;
  ctx.strokeRect(x, box.y, box.width, box.height);
  ctx.shadowBlur = 0;

  const label = `Person ${personIdx + 1}  ${emotionKey.toUpperCase()}`;
  ctx.font = '600 14px Rajdhani';
  const textWidth = ctx.measureText(label).width;
  const labelY = Math.max(8, box.y - 24);

  ctx.fillStyle = 'rgba(7, 17, 31, 0.88)';
  ctx.fillRect(x, labelY, textWidth + 16, 22);
  ctx.strokeStyle = color;
  ctx.strokeRect(x, labelY, textWidth + 16, 22);
  ctx.fillStyle = '#e8f3ff';
  ctx.fillText(label, x + 8, labelY + 16);
  drawLandmarks(ctx, result.landmarks, color, isFront);
}

function drawLandmarks(ctx, landmarks, color, isFront) {
  const mirroredX = point => (isFront ? overlay.width - point.x : point.x);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.55;

  landmarks.positions.forEach(point => {
    ctx.beginPath();
    ctx.arc(mirroredX(point), point.y, 1.4, 0, Math.PI * 2);
    ctx.fill();
  });

  [landmarks.getJawOutline(), landmarks.getLeftEyeBrow(), landmarks.getRightEyeBrow(), landmarks.getLeftEye(), landmarks.getRightEye(), landmarks.getNose(), landmarks.getMouth()].forEach(group => {
    ctx.beginPath();
    group.forEach((point, index) => {
      if (index === 0) ctx.moveTo(mirroredX(point), point.y);
      else ctx.lineTo(mirroredX(point), point.y);
    });
    ctx.stroke();
  });

  ctx.globalAlpha = 1;
}

function updateMoodCard() {
  drawRadar();
  moodLabel.textContent = `${persons.length} subject${persons.length === 1 ? '' : 's'} indexed`;
  barContainer.innerHTML = persons.map((person, index) => {
    const color = PERSON_COLORS[index % PERSON_COLORS.length];
    const sorted = Object.entries(person.accumulator).sort((a, b) => b[1] - a[1]);
    const emotionKey = sorted[0][0];
    const pct = person.sampleCount > 0 ? Math.round((sorted[0][1] / person.sampleCount) * 100) : 0;
    const stateLabel = person.active ? 'live' : 'out';
    const avatar = person.photo
      ? `<img class="person-avatar" src="${person.photo}" alt="Person ${index + 1}" style="border: 2px solid ${color};" />`
      : `<div class="person-avatar-placeholder" style="border: 2px solid ${color};">P${index + 1}</div>`;

    return `
      <div class="person-row">
        ${avatar}
        <div class="person-meta">
          <div class="person-title">
            <strong style="color:${color};">Person ${index + 1}</strong>
            <span class="person-state">${stateLabel}</span>
          </div>
          <div class="bar-track">
            <div class="bar-fill" style="width:${pct}%; background:${color};"></div>
          </div>
          <div class="person-detail">
            <span>${emotionKey}</span>
            <span>${pct}% confidence</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function captureFace(box) {
  const padding = 24;
  const x = Math.max(0, box.x - padding);
  const y = Math.max(0, box.y - padding);
  const width = Math.min(video.videoWidth - x, box.width + padding * 2);
  const height = Math.min(video.videoHeight - y, box.height + padding * 2);
  cropCanvas.width = width;
  cropCanvas.height = height;
  cropCtx.drawImage(video, x, y, width, height, 0, 0, width, height);
  return cropCanvas.toDataURL('image/jpeg', 0.7);
}

window.addEventListener('load', loadModels);
