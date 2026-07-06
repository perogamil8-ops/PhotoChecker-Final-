/**
 * Photo Quality Checker — script.js (v3)
 *
 *  - Image downscaled to max 1280px before processing
 *  - MediaPipe loaded lazily on first "Analyze" click (no more 8MB OpenCV.js!)
 *  - All analysis done in pure JS — no external CDN blocks page load
 *  - Models created once; re-used on every subsequent analysis
 */

'use strict';

/* ══════════════════════════════════════════════════════════════
   CONSTANTS
   ══════════════════════════════════════════════════════════════ */
const MAX_ANALYSIS_SIZE = 1280;
const ACCEPT_SCORE      = 85;
const FACE_MODEL_URL    = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const MP_BUNDLE_URL     = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/vision_bundle.mjs';
const WASM_URL          = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm';

/* ══════════════════════════════════════════════════════════════
   STATE  (singleton — persists across analyses)
   ══════════════════════════════════════════════════════════════ */
const State = {
  mpInitialised:  false,  // true once models are loaded
  mpInitPromise:  null,   // Promise so concurrent calls wait on same init
  faceLandmarker: null,
  imageFile:      null,
  previewURL:     null,   // object URL — revoked on reset
  analysing:      false,  // guard against double-clicks
};

/* ══════════════════════════════════════════════════════════════
   DOM REFERENCES
   ══════════════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);

const DOM = {
  dropZone:        $('dropZone'),
  fileInput:       $('fileInput'),
  uploadIdle:      $('uploadIdle'),
  uploadPreview:   $('uploadPreview'),
  previewImg:      $('previewImg'),
  overlayCanvas:   $('overlayCanvas'),
  previewMeta:     $('previewMeta'),
  analyzeBtn:      $('analyzeBtn'),
  analyzeBtnIcon:  $('analyzeBtnIcon'),
  analyzeBtnText:  $('analyzeBtnText'),
  resetBtn:        $('resetBtn'),
  progressSection: $('progressSection'),
  progressLabel:   $('progressLabel'),
  progressPct:     $('progressPct'),
  progressBar:     $('progressBar'),
  progressSteps:   $('progressSteps'),
  resultsSection:  $('resultsSection'),
  verdictCard:     $('verdictCard'),
  verdictIcon:     $('verdictIcon'),
  verdictTitle:    $('verdictTitle'),
  verdictSub:      $('verdictSub'),
  scoreRingFg:     $('scoreRingFg'),
  scoreValue:      $('scoreValue'),
  checklist:       $('checklist'),
  rejectionCard:   $('rejectionCard'),
  rejectionList:   $('rejectionList'),
  retryBtn:        $('retryBtn'),
};

/* ══════════════════════════════════════════════════════════════
   MEDIAPIPE INIT  — called once; subsequent calls return cached promise
   ══════════════════════════════════════════════════════════════ */
async function ensureMediaPipe () {
  if (State.mpInitialised) return true;
  if (State.mpInitPromise) return State.mpInitPromise;

  State.mpInitPromise = (async () => {
    console.log('[PhotoCheck] Loading MediaPipe...');
    setProgress(5, 'جارٍ تحميل نماذج الذكاء الاصطناعي…');

    try {
      const mod = await import(MP_BUNDLE_URL);
      window._MP = mod;
      console.log('[PhotoCheck] MediaPipe module loaded ✓');
    } catch (err) {
      console.error('[PhotoCheck] MediaPipe load error:', err);
      window._MP = null;
      return false;
    }

    const { FaceLandmarker, FilesetResolver } = window._MP;

    let vision;
    try {
      vision = await FilesetResolver.forVisionTasks(WASM_URL);
    } catch (e) {
      console.error('[PhotoCheck] FilesetResolver failed:', e);
      return false;
    }

    // ── Face Landmarker ──
    // CPU delegate: more compatible; avoids silent GPU hangs
    try {
      State.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: FACE_MODEL_URL,
          delegate: 'CPU',
        },
        outputFaceBlendshapes: true,
        runningMode: 'IMAGE',
        numFaces: 5,
        // Lowered from the 0.5 default — the stricter default was rejecting
        // otherwise-valid photos (slight angle / lighting) as "no face found".
        minFaceDetectionConfidence: 0.3,
        minFacePresenceConfidence: 0.3,
        minTrackingConfidence: 0.3,
      });
      console.log('[PhotoCheck] Face Landmarker ready ✓');
    } catch (e) {
      console.error('[PhotoCheck] Face Landmarker init failed:', e);
    }

    console.log('[PhotoCheck] MediaPipe Ready ✓');
    State.mpInitialised = true;
    return true;
  })();

  return State.mpInitPromise;
}

/* ══════════════════════════════════════════════════════════════
   FILE HANDLING
   ══════════════════════════════════════════════════════════════ */
DOM.dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  DOM.dropZone.classList.add('drag-over');
});
DOM.dropZone.addEventListener('dragleave', () => DOM.dropZone.classList.remove('drag-over'));
DOM.dropZone.addEventListener('drop', e => {
  e.preventDefault();
  DOM.dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) loadFile(file);
});
DOM.fileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) loadFile(file);
});

function loadFile (file) {
  // Revoke previous URL to avoid memory leak
  if (State.previewURL) URL.revokeObjectURL(State.previewURL);

  State.imageFile  = file;
  State.previewURL = URL.createObjectURL(file);

  DOM.previewImg.onload = () => {
    const w = DOM.previewImg.naturalWidth;
    const h = DOM.previewImg.naturalHeight;
    DOM.previewMeta.textContent =
      `${file.name}  ·  ${w} × ${h} بكسل  ·  ${(file.size / 1024).toFixed(0)} كيلوبايت`;
    DOM.overlayCanvas.width  = DOM.previewImg.clientWidth  || w;
    DOM.overlayCanvas.height = DOM.previewImg.clientHeight || h;
  };
  DOM.previewImg.src = State.previewURL;

  DOM.uploadIdle.classList.add('hidden');
  DOM.uploadPreview.classList.remove('hidden');

  // Reset result area for repeat use
  DOM.progressSection.classList.add('hidden');
  DOM.resultsSection.classList.add('hidden');

  // Pre-load models in background immediately after file is chosen
  ensureMediaPipe().catch(() => {});
}

DOM.resetBtn.addEventListener('click', resetAll);
DOM.retryBtn.addEventListener('click', resetAll);

function resetAll () {
  if (State.previewURL) {
    URL.revokeObjectURL(State.previewURL);
    State.previewURL = null;
  }
  DOM.fileInput.value  = '';
  DOM.previewImg.src   = '';
  DOM.uploadIdle.classList.remove('hidden');
  DOM.uploadPreview.classList.add('hidden');
  DOM.progressSection.classList.add('hidden');
  DOM.resultsSection.classList.add('hidden');
  DOM.dropZone.classList.remove('drag-over');
  State.imageFile   = null;
  State.analysing   = false;
  setBtnIdle();
  const ctx = DOM.overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, DOM.overlayCanvas.width, DOM.overlayCanvas.height);
}

/* ══════════════════════════════════════════════════════════════
   BUTTON STATE HELPERS
   ══════════════════════════════════════════════════════════════ */
function setBtnBusy () {
  DOM.analyzeBtn.disabled      = true;
  DOM.analyzeBtnIcon.textContent = '⏳';
  DOM.analyzeBtnText.textContent = 'جارٍ التحليل…';
}

function setBtnIdle () {
  DOM.analyzeBtn.disabled      = false;
  DOM.analyzeBtnIcon.textContent = '▶';
  DOM.analyzeBtnText.textContent = 'تحليل الصورة';
}

/* ══════════════════════════════════════════════════════════════
   ANALYZE BUTTON
   ══════════════════════════════════════════════════════════════ */
DOM.analyzeBtn.addEventListener('click', async () => {
  if (!State.imageFile || State.analysing) return;
  State.analysing = true;
  setBtnBusy();
  try {
    await runAnalysis();
  } catch (err) {
    console.error('[PhotoCheck] Unexpected error:', err);
    showError('حدث خطأ غير متوقع. يرجى المحاولة مجدداً.');
  } finally {
    State.analysing = false;
    setBtnIdle();
  }
});

/* ══════════════════════════════════════════════════════════════
   PROGRESS HELPERS
   ══════════════════════════════════════════════════════════════ */
const STEPS = [
  'تحميل الصورة',
  'تحميل النماذج',
  'تحليل الوجه',
  'حجم الوجه',
  'موضع الوجه',
  'ميل الرأس',
  'حالة العينين',
  'وضوح الصورة',
  'دقة الصورة',
  'الإضاءة',
  'التباين',
  'ظهور الوجه',
  'الابتسامة',
  'الخلفية',
];

function initProgress () {
  DOM.progressSection.classList.remove('hidden');
  DOM.resultsSection.classList.add('hidden');
  DOM.progressBar.style.width = '0%';
  DOM.progressSteps.innerHTML = STEPS.map(s =>
    `<span class="step-badge" data-step="${s}">${s}</span>`
  ).join('');
  setProgress(0, 'جارٍ التهيئة…');
}

function setProgress (pct, label, activeStep) {
  DOM.progressBar.style.width = pct + '%';
  DOM.progressPct.textContent  = Math.round(pct) + '%';
  if (label) DOM.progressLabel.textContent = label;
  if (activeStep) {
    document.querySelectorAll('.step-badge').forEach(b => {
      if (b.dataset.step === activeStep) {
        b.classList.add('active');
        b.classList.remove('done');
      } else if (b.classList.contains('active')) {
        b.classList.remove('active');
        b.classList.add('done');
      }
    });
  }
}

function finishStep (name) {
  const b = document.querySelector(`.step-badge[data-step="${name}"]`);
  if (b) { b.classList.remove('active'); b.classList.add('done'); }
}

/* ══════════════════════════════════════════════════════════════
   IMAGE DOWNSCALE HELPER
   Returns { canvas, imageData, w, h, origW, origH }
   Analysis is done on the downscaled version; origW/H are kept for
   resolution check which must use the original file dimensions.
   ══════════════════════════════════════════════════════════════ */
async function prepareAnalysisImage (file) {
  const bitmap = await createImageBitmap(file);
  const origW  = bitmap.width;
  const origH  = bitmap.height;

  // Downscale so longest side ≤ MAX_ANALYSIS_SIZE
  let w = origW, h = origH;
  if (Math.max(w, h) > MAX_ANALYSIS_SIZE) {
    const ratio = MAX_ANALYSIS_SIZE / Math.max(w, h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
    console.log(`[PhotoCheck] Image Resized: ${origW}×${origH} → ${w}×${h}`);
  } else {
    console.log(`[PhotoCheck] Image size OK: ${w}×${h} (no resize needed)`);
  }

  const canvas  = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close(); // free memory

  const imageData = ctx.getImageData(0, 0, w, h);
  return { canvas, imageData, w, h, origW, origH };
}

/* ══════════════════════════════════════════════════════════════
   CANVAS → HTMLImageElement  (small canvas only — already downscaled)
   ══════════════════════════════════════════════════════════════ */
function canvasToImg (canvas) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.src    = canvas.toDataURL('image/jpeg', 0.92);
  });
}

/* ══════════════════════════════════════════════════════════════
   MAIN ANALYSIS PIPELINE
   ══════════════════════════════════════════════════════════════ */
async function runAnalysis () {
  initProgress();
  await yieldToDOM(); // let progress bar paint

  // ── Step: Load image & downscale ──────────────────────────
  setProgress(8, 'تحميل الصورة…', 'تحميل الصورة');
  let prep;
  try {
    prep = await prepareAnalysisImage(State.imageFile);
  } catch (e) {
    console.error('[PhotoCheck] Image decode error:', e);
    showError('تعذّر قراءة الصورة. تأكد أن الملف صحيح.');
    return;
  }
  const { canvas, imageData, w, h, origW, origH } = prep;
  finishStep('تحميل الصورة');

  // ── Step: Ensure models loaded ────────────────────────────
  setProgress(15, 'تحميل نماذج الذكاء الاصطناعي…', 'تحميل النماذج');
  const mpOK = await ensureMediaPipe();
  finishStep('تحميل النماذج');
  await yieldToDOM();

  // Convert downscaled canvas → img for MediaPipe
  const imgEl = await canvasToImg(canvas);

  // Collect results
  let score = 100;
  const rejections = [];
  const checks     = [];

  /* ── 1. Face Detection ────────────────────────────────── */
  setProgress(22, 'تحليل الوجه…', 'تحليل الوجه');
  console.log('[PhotoCheck] Running Face Detection...');
  await yieldToDOM();

  let faceResult = null;
  let faces      = [];

  if (State.faceLandmarker) {
    try {
      faceResult = State.faceLandmarker.detect(imgEl);
    } catch (e) {
      console.warn('[PhotoCheck] Face detect error:', e);
    }
  } else if (!mpOK) {
    // Models failed to load entirely
    showError('تعذّر تحميل نماذج الذكاء الاصطناعي. تحقق من الاتصال بالإنترنت وأعد المحاولة.');
    return;
  }

  if (faceResult && faceResult.faceLandmarks) {
    faces = faceResult.faceLandmarks;
  }

  if (faces.length === 0) {
    showResults({
      score: 0,
      checks: [{ status:'fail', label:'لا يوجد وجه في الصورة', detail:'تأكد من ظهور وجهك بوضوح في الصورة.' }],
      rejections: ['لم يتم اكتشاف أي وجه في الصورة.'],
      accepted: false,
      landmarks: null, imgW: w, imgH: h,
    });
    return;
  }

  if (faces.length > 1) {
    showResults({
      score: 0,
      checks: [{ status:'fail', label:'يوجد أكثر من شخص في الصورة', detail:'يجب أن تحتوي الصورة على شخص واحد فقط.' }],
      rejections: ['تم اكتشاف أكثر من وجه في الصورة.'],
      accepted: false,
      landmarks: null, imgW: w, imgH: h,
    });
    return;
  }

  checks.push({ status:'pass', label:'يوجد وجه واحد في الصورة', detail:'تم اكتشاف وجه واحد بوضوح.' });
  finishStep('تحليل الوجه');
  const landmarks = faces[0];

  /* ── 2. Face Size ─────────────────────────────────────── */
  setProgress(30, 'قياس حجم الوجه…', 'حجم الوجه');
  await yieldToDOM();
  const faceBox  = getLandmarkBox(landmarks, w, h);
  const faceRatio = (faceBox.w * faceBox.h) / (w * h);

  if (faceRatio < 0.04) {
    checks.push({ status:'fail', label:'الوجه صغير جدًا في الصورة', detail:`نسبة مساحة الوجه: ${(faceRatio*100).toFixed(1)}٪` });
    rejections.push('اقترب أكثر من الكاميرا — الوجه صغير جدًا.');
    score -= 10;
  } else {
    checks.push({ status:'pass', label:'حجم الوجه مناسب', detail:`نسبة مساحة الوجه: ${(faceRatio*100).toFixed(1)}٪` });
  }
  finishStep('حجم الوجه');

  /* ── 3. Face Position ─────────────────────────────────── */
  setProgress(36, 'فحص موضع الوجه…', 'موضع الوجه');
  const offsetX = Math.abs(faceBox.cx / w - 0.5);
  const offsetY = Math.abs(faceBox.cy / h - 0.5);

  if (offsetX > 0.2 || offsetY > 0.2) {
    checks.push({ status:'fail', label:'الوجه بعيد عن مركز الصورة', detail:`إزاحة أفقية: ${(offsetX*100).toFixed(0)}٪  ·  رأسية: ${(offsetY*100).toFixed(0)}٪` });
    rejections.push('يرجى توسيط وجهك في منتصف الصورة.');
    score -= 5;
  } else {
    checks.push({ status:'pass', label:'الوجه في وسط الصورة', detail:`إزاحة أفقية: ${(offsetX*100).toFixed(0)}٪  ·  رأسية: ${(offsetY*100).toFixed(0)}٪` });
  }
  finishStep('موضع الوجه');

  /* ── 4. Face Rotation ─────────────────────────────────── */
  setProgress(42, 'قياس ميل الرأس…', 'ميل الرأس');
  const rotation = computeFaceRotation(landmarks, w, h);
  const maxTilt  = Math.max(Math.abs(rotation.roll), Math.abs(rotation.yaw));

  if (maxTilt > 15) {
    checks.push({ status:'fail', label:'الرأس مائل بشكل واضح', detail:`ميل Roll: ${rotation.roll.toFixed(1)}°  ·  Yaw: ${rotation.yaw.toFixed(1)}°` });
    rejections.push(`الرأس مائل بزاوية ${maxTilt.toFixed(0)}° — انظر مباشرةً إلى الكاميرا.`);
    score -= 15;
  } else {
    checks.push({ status:'pass', label:'الرأس مستقيم ومواجه للكاميرا', detail:`ميل Roll: ${rotation.roll.toFixed(1)}°  ·  Yaw: ${rotation.yaw.toFixed(1)}°` });
  }
  finishStep('ميل الرأس');

  /* ── 5. Eyes Open ─────────────────────────────────────── */
  setProgress(50, 'فحص حالة العينين…', 'حالة العينين');
  const eyeStatus = checkEyes(landmarks, faceResult);

  if (!eyeStatus.open) {
    checks.push({ status:'fail', label:'العينان مغلقتان أو شبه مغلقتان', detail:`EAR يسرى: ${eyeStatus.earLeft.toFixed(2)}  ·  يمنى: ${eyeStatus.earRight.toFixed(2)}` });
    rejections.push('افتح عينيك ثم التقط الصورة.');
    score -= 20;
  } else {
    checks.push({ status:'pass', label:'العينان مفتوحتان', detail:`EAR يسرى: ${eyeStatus.earLeft.toFixed(2)}  ·  يمنى: ${eyeStatus.earRight.toFixed(2)}` });
  }
  finishStep('حالة العينين');

  /* ── 6. Blur ──────────────────────────────────────────── */
  setProgress(58, 'فحص وضوح الصورة…', 'وضوح الصورة');
  console.log('[PhotoCheck] Running Blur Detection...');
  await yieldToDOM();
  const blurScore = await computeBlur(imageData, w, h, faceBox);
  const isBlurry  = blurScore < 80;

  if (isBlurry) {
    checks.push({ status:'fail', label:'الصورة مهزوزة أو غير واضحة', detail:`درجة الوضوح: ${blurScore.toFixed(0)} (الحد الأدنى: 80)` });
    rejections.push('الصورة غير واضحة — يرجى التقاط صورة ثابتة.');
    score -= 20;
  } else {
    checks.push({ status:'pass', label:'الصورة واضحة وغير مهزوزة', detail:`درجة الوضوح: ${blurScore.toFixed(0)}` });
  }
  finishStep('وضوح الصورة');

  /* ── 7. Resolution (uses ORIGINAL dimensions) ─────────── */
  setProgress(63, 'فحص دقة الصورة…', 'دقة الصورة');
  if (origW < 600 || origH < 600) {
    checks.push({ status:'fail', label:'دقة الصورة منخفضة', detail:`الأبعاد الأصلية: ${origW}×${origH} بكسل (الحد الأدنى: 600×600)` });
    rejections.push(`دقة الصورة منخفضة (${origW}×${origH}). الحد الأدنى 600×600 بكسل.`);
    score -= 15;
  } else {
    checks.push({ status:'pass', label:'دقة الصورة ممتازة', detail:`الأبعاد الأصلية: ${origW}×${origH} بكسل` });
  }
  finishStep('دقة الصورة');

  /* ── 8. Brightness ────────────────────────────────────── */
  setProgress(68, 'قياس الإضاءة…', 'الإضاءة');
  const brightness = computeBrightness(imageData);

  if (brightness < 60) {
    checks.push({ status:'fail', label:'الصورة مظلمة جدًا', detail:`متوسط الإضاءة: ${brightness.toFixed(0)}/255` });
    rejections.push('الصورة مظلمة — التقطها في مكان ذي إضاءة أفضل.');
    score -= 10;
  } else if (brightness > 220) {
    checks.push({ status:'warn', label:'الصورة ساطعة جدًا', detail:`متوسط الإضاءة: ${brightness.toFixed(0)}/255` });
    rejections.push('الإضاءة مرتفعة جدًا — ابتعد عن المصدر الضوئي المباشر.');
    score -= 5;
  } else {
    checks.push({ status:'pass', label:'الإضاءة جيدة', detail:`متوسط الإضاءة: ${brightness.toFixed(0)}/255` });
  }
  finishStep('الإضاءة');

  /* ── 9. Contrast ──────────────────────────────────────── */
  setProgress(73, 'قياس التباين…', 'التباين');
  const contrast = computeContrast(imageData);

  if (contrast < 30) {
    checks.push({ status:'warn', label:'التباين منخفض', detail:`درجة التباين: ${contrast.toFixed(0)}` });
    score -= 5;
  } else {
    checks.push({ status:'pass', label:'التباين جيد', detail:`درجة التباين: ${contrast.toFixed(0)}` });
  }
  finishStep('التباين');

  /* ── 11. Face Visibility ──────────────────────────────── */
  setProgress(85, 'فحص ظهور الوجه…', 'ظهور الوجه');
  const visibility = computeFaceVisibility(landmarks);

  if (visibility < 0.7) {
    checks.push({ status:'fail', label:'جزء من الوجه مخفي أو محجوب', detail:`نسبة الظهور: ${(visibility*100).toFixed(0)}٪` });
    rejections.push('يبدو أن جزءاً من وجهك مخفي — تأكد من ظهوره كاملًا.');
    score -= 10;
  } else {
    checks.push({ status:'pass', label:'الوجه ظاهر بالكامل', detail:`نسبة الظهور: ${(visibility*100).toFixed(0)}٪` });
  }
  finishStep('ظهور الوجه');

  /* ── 12. Smile Detection ──────────────────────────────── */
  setProgress(90, 'اكتشاف الابتسامة…', 'الابتسامة');
  const smileScore = getBlendshapeValue(faceResult, 'mouthSmileLeft') +
                     getBlendshapeValue(faceResult, 'mouthSmileRight');

  checks.push(smileScore > 0.5
    ? { status:'pass', label:'الشخص مبتسم 😊', detail:`درجة الابتسامة: ${(smileScore*50).toFixed(0)}٪` }
    : { status:'info', label:'لا توجد ابتسامة واضحة', detail:'اختياري — لا يؤثر على قبول الصورة.' }
  );
  finishStep('الابتسامة');

  /* ── 13. Background ───────────────────────────────────── */
  setProgress(95, 'تحليل الخلفية…', 'الخلفية');
  const bgComplexity = await computeBackgroundComplexity(imageData, w, h, faceBox);

  checks.push(bgComplexity > 70
    ? { status:'warn', label:'الخلفية مزدحمة أو معقدة', detail:`درجة التعقيد: ${bgComplexity.toFixed(0)}/100 — يُفضَّل خلفية بسيطة.` }
    : { status:'pass', label:'الخلفية مناسبة', detail:`درجة التعقيد: ${bgComplexity.toFixed(0)}/100` }
  );
  finishStep('الخلفية');

  /* ── Finalise ─────────────────────────────────────────── */
  score = Math.max(0, Math.min(100, score));
  setProgress(100, 'اكتمل التحليل ✓');
  console.log(`[PhotoCheck] Analysis Completed — Score: ${score}/100`);
  await yieldToDOM(300);

  showResults({ score, checks, rejections, accepted: score >= ACCEPT_SCORE, landmarks, imgW: w, imgH: h });
}

/* ══════════════════════════════════════════════════════════════
   SHOW RESULTS
   ══════════════════════════════════════════════════════════════ */
function showResults ({ score, checks, rejections, accepted, landmarks, imgW, imgH }) {
  DOM.progressSection.classList.add('hidden');
  DOM.resultsSection.classList.remove('hidden');

  // Verdict
  DOM.verdictCard.className    = 'verdict-card ' + (accepted ? 'accepted' : 'rejected');
  DOM.verdictIcon.textContent  = accepted ? '✅' : '❌';
  DOM.verdictTitle.textContent = accepted ? 'تم قبول الصورة' : 'الصورة غير مناسبة';
  DOM.verdictSub.textContent   = accepted
    ? 'الصورة تستوفي جميع متطلبات حفلة التكريم.'
    : 'يرجى التقاط صورة جديدة وفق الإرشادات الموضحة أدناه.';

  // Score ring
  const offset = 314 - (score / 100) * 314;
  DOM.scoreRingFg.style.strokeDashoffset = offset;
  DOM.scoreRingFg.style.stroke           = accepted ? 'var(--green)' : 'var(--red)';
  DOM.scoreValue.textContent             = score;
  DOM.scoreValue.style.color             = accepted ? 'var(--green)' : 'var(--red)';

  // Checklist
  DOM.checklist.innerHTML = '';
  checks.forEach((c, i) => {
    const li   = document.createElement('li');
    li.className              = `checklist-item ${c.status}`;
    li.style.animationDelay   = (i * 55) + 'ms';
    const icon = { pass:'✅', fail:'❌', warn:'⚠️', info:'ℹ️' }[c.status] || 'ℹ️';
    li.innerHTML = `
      <span class="ci-icon">${icon}</span>
      <div class="ci-body">
        <div class="ci-label">${c.label}</div>
        ${c.detail ? `<div class="ci-detail">${c.detail}</div>` : ''}
      </div>`;
    DOM.checklist.appendChild(li);
  });

  // Rejections
  if (rejections.length > 0) {
    DOM.rejectionCard.classList.remove('hidden');
    DOM.rejectionList.innerHTML = rejections.map(r => `<li>${r}</li>`).join('');
  } else {
    DOM.rejectionCard.classList.add('hidden');
  }

  // Overlay
  if (landmarks) drawOverlay(landmarks, imgW, imgH);

  DOM.resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* Show a fatal error message to the user */
function showError (msg) {
  DOM.progressSection.classList.add('hidden');
  DOM.resultsSection.classList.remove('hidden');
  DOM.verdictCard.className    = 'verdict-card rejected';
  DOM.verdictIcon.textContent  = '⚠️';
  DOM.verdictTitle.textContent = 'خطأ';
  DOM.verdictSub.textContent   = msg;
  DOM.scoreRingFg.style.strokeDashoffset = 314;
  DOM.scoreValue.textContent   = '—';
  DOM.checklist.innerHTML      = '';
  DOM.rejectionCard.classList.add('hidden');
}

/* ══════════════════════════════════════════════════════════════
   ANALYSIS HELPERS
   ══════════════════════════════════════════════════════════════ */

/** Yield control to the browser so it can repaint */
const yieldToDOM = (ms = 16) => new Promise(r => setTimeout(r, ms));
const sleep      = ms => new Promise(r => setTimeout(r, ms));

/** Get bounding box from face landmarks */
function getLandmarkBox (landmarks, W, H) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of landmarks) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    x: minX * W, y: minY * H,
    w: (maxX - minX) * W,
    h: (maxY - minY) * H,
    cx: ((minX + maxX) / 2) * W,
    cy: ((minY + maxY) / 2) * H,
  };
}

/** Approximate Roll + Yaw from face landmarks */
function computeFaceRotation (landmarks, W, H) {
  const nose      = landmarks[1];
  const leftEye   = landmarks[33];
  const rightEye  = landmarks[263];
  const leftMouth = landmarks[61];
  const rightMouth = landmarks[291];

  const dx   = (rightEye.x - leftEye.x) * W;
  const dy   = (rightEye.y - leftEye.y) * H;
  const roll = Math.atan2(dy, dx) * 180 / Math.PI;

  const eyeMidX = (leftEye.x + rightEye.x) / 2;
  const eyeSpan = Math.abs(rightEye.x - leftEye.x) || 1;
  const yaw     = ((nose.x - eyeMidX) / eyeSpan) * 90;

  const mouthMidY = (leftMouth.y + rightMouth.y) / 2;
  const eyeMidY   = (leftEye.y + rightEye.y) / 2;
  const vertSpan  = mouthMidY - eyeMidY || 1;
  const pitch     = ((nose.y - eyeMidY) / vertSpan - 0.5) * 60;

  return { roll, yaw, pitch };
}

/** Eye Aspect Ratio (EAR) */
function checkEyes (landmarks, faceResult) {
  const earLeft  = eyeAspectRatio(landmarks, [33, 160, 158, 133, 153, 144]);
  const earRight = eyeAspectRatio(landmarks, [362, 385, 387, 263, 373, 380]);

  const blinkL = getBlendshapeValue(faceResult, 'eyeBlinkLeft');
  const blinkR = getBlendshapeValue(faceResult, 'eyeBlinkRight');

  // Blendshapes: 0 = fully open, 1 = fully closed
  // Fall back to EAR if blendshapes not available (score 0)
  const hasBlend = blinkL > 0 || blinkR > 0;
  const open = hasBlend
    ? (blinkL < 0.6 && blinkR < 0.6)
    : (earLeft > 0.15 && earRight > 0.15);

  return { open, earLeft, earRight };
}

function eyeAspectRatio (landmarks, idx) {
  const p  = idx.map(i => landmarks[i] || { x:0, y:0 });
  const v1 = dist(p[1], p[5]);
  const v2 = dist(p[2], p[4]);
  const h  = dist(p[0], p[3]) || 1;
  return (v1 + v2) / (2 * h);
}

function dist (a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function getBlendshapeValue (faceResult, name) {
  if (!faceResult?.faceBlendshapes?.[0]) return 0;
  const cat = faceResult.faceBlendshapes[0].categories.find(c => c.categoryName === name);
  return cat ? cat.score : 0;
}

/**
 * Variance of Laplacian — pure JS (no OpenCV needed)
 */
async function computeBlur (imageData, W, H, faceBox) {
  const fx = Math.max(0, Math.floor(faceBox.x));
  const fy = Math.max(0, Math.floor(faceBox.y));
  const fw = Math.max(1, Math.min(W - fx, Math.floor(faceBox.w)));
  const fh = Math.max(1, Math.min(H - fy, Math.floor(faceBox.h)));

  const data = imageData.data;
  let sum = 0, count = 0;
  const step = 2;

  // Process in row-chunks and yield to the event loop to keep UI responsive
  const chunkSize = 32; // rows per chunk
  for (let yStart = fy + 1; yStart < fy + fh - 1; yStart += chunkSize) {
    const yEnd = Math.min(fy + fh - 1, yStart + chunkSize);
    for (let y = yStart; y < yEnd; y += step) {
      for (let x = fx + 1; x < fx + fw - 1; x += step) {
        const i  = (y * W + x) * 4;
        const iN = ((y-1) * W + x) * 4;
        const iS = ((y+1) * W + x) * 4;
        const iW = (y * W + x-1) * 4;
        const iE = (y * W + x+1) * 4;
        const lum = r => 0.299*data[r] + 0.587*data[r+1] + 0.114*data[r+2];
        sum += Math.abs(-4*lum(i) + lum(iN) + lum(iS) + lum(iW) + lum(iE));
        count++;
      }
    }
    // allow the browser to repaint / handle input
    await yieldToDOM();
  }

  return count > 0 ? (sum / count) * 20 : 0;
}

/** Mean luminance */
function computeBrightness (imageData) {
  const data = imageData.data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
  }
  return sum / (data.length / 4);
}

/**
 * Contrast = std-dev of luminance.
 * Fixed: no longer allocates a full Float64Array — uses Welford online algorithm.
 */
function computeContrast (imageData) {
  const data = imageData.data;
  let n = 0, mean = 0, M2 = 0;
  for (let i = 0; i < data.length; i += 4) {
    const l   = 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
    n++;
    const delta  = l - mean;
    mean        += delta / n;
    M2          += delta * (l - mean);
  }
  return n > 1 ? Math.sqrt(M2 / (n - 1)) : 0;
}

/** Fraction of face landmarks with visibility > 0.5 */
function computeFaceVisibility (landmarks) {
  let total = 0, visible = 0;
  for (const lm of landmarks) {
    total++;
    const v = lm.visibility ?? 1.0;
    if (v > 0.5) visible++;
  }
  return total ? visible / total : 1;
}

/** Background complexity via edge density outside face box */
async function computeBackgroundComplexity (imageData, W, H, faceBox) {
  const data   = imageData.data;
  const margin = 30;
  const fx  = Math.max(0, faceBox.x - margin);
  const fy  = Math.max(0, faceBox.y - margin);
  const fx2 = Math.min(W, faceBox.x + faceBox.w + margin);
  const fy2 = Math.min(H, faceBox.y + faceBox.h + margin);
  let edgeSum = 0, bgPixels = 0;
  const step = 4;

  // Process in chunks of rows to avoid long blocking loops
  const chunkSize = 24;
  for (let yStart = 1; yStart < H - 1; yStart += chunkSize) {
    const yEnd = Math.min(H - 1, yStart + chunkSize);
    for (let y = yStart; y < yEnd; y += step) {
      for (let x = 1; x < W - 1; x += step) {
        if (x >= fx && x <= fx2 && y >= fy && y <= fy2) continue;
        const i  = (y*W+x)*4, iE = (y*W+x+1)*4, iS = ((y+1)*W+x)*4;
        const lC = 0.299*data[i]  + 0.587*data[i+1]  + 0.114*data[i+2];
        const lE = 0.299*data[iE] + 0.587*data[iE+1] + 0.114*data[iE+2];
        const lS = 0.299*data[iS] + 0.587*data[iS+1] + 0.114*data[iS+2];
        edgeSum += Math.abs(lC-lE) + Math.abs(lC-lS);
        bgPixels++;
      }
    }
    // yield so UI stays responsive
    // Note: this function remains synchronous where called, so keep short
    // Use a micro-yield by scheduling a resolved promise.
    const p = Promise.resolve();
    await p.catch(() => {});
  }
  return bgPixels ? Math.min(100, (edgeSum / bgPixels / 20) * 100) : 0;
}

/* ══════════════════════════════════════════════════════════════
   OVERLAY DRAWING
   ══════════════════════════════════════════════════════════════ */
function drawOverlay (landmarks, imgW, imgH) {
  const canvas = DOM.overlayCanvas;
  const dispW  = DOM.previewImg.clientWidth  || imgW;
  const dispH  = DOM.previewImg.clientHeight || imgH;
  canvas.width  = dispW;
  canvas.height = dispH;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, dispW, dispH);

  const scale = Math.min(dispW / imgW, dispH / imgH);
  const offX  = (dispW - imgW * scale) / 2;
  const offY  = (dispH - imgH * scale) / 2;

  const keyIndices = [
    33, 160, 158, 133, 153, 144,    // left eye
    362, 385, 387, 263, 373, 380,   // right eye
    1, 2, 98, 327,                  // nose
    61, 291, 39, 269, 0, 17,        // mouth
  ];

  ctx.save();
  ctx.fillStyle = 'rgba(6,182,212,0.9)';
  for (const idx of keyIndices) {
    if (!landmarks[idx]) continue;
    ctx.beginPath();
    ctx.arc(landmarks[idx].x * imgW * scale + offX,
            landmarks[idx].y * imgH * scale + offY, 2.5, 0, Math.PI*2);
    ctx.fill();
  }

  const box = getLandmarkBox(landmarks, imgW, imgH);
  ctx.strokeStyle = 'rgba(6,182,212,0.6)';
  ctx.lineWidth   = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(box.x*scale+offX, box.y*scale+offY, box.w*scale, box.h*scale);
  ctx.setLineDash([]);
  ctx.restore();
}

/* ══════════════════════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════════════════════ */
console.log('[PhotoCheck] Page loaded — models will be loaded on demand.');
