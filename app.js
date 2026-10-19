/* ============================================================
   Премиальная HTML5-книга — логика (StPageFlip)
   «Его Высочество Юмор» / Борис Шварцман
   ------------------------------------------------------------
   • реалистичное перелистывание (StPageFlip, canvas-тени),
     твёрдые обложки, изгиб и тень страницы;
   • адаптив: разворот из двух страниц на десктопе,
     одна страница на телефоне;
   • управление: свайп/перетаскивание, клик по краю страницы,
     уголок страницы, стрелки клавиатуры, кнопки, свайп пальцем;
   • умная подгрузка изображений (окно вокруг текущей страницы
     + фоновая предзагрузка всего издания);
   • звук шелеста страниц, сгенерированный Web Audio API;
   • прелоадер с прогрессом, подсказка, «кнопка во весь экран»,
     ссылка на страницу (#p123).
   ============================================================ */

(function () {
  'use strict';

  /* ---------------- НАСТРОЙКИ ---------------- */
  var CONFIG = {
    manifest: 'assets/pages/pages.json',
    // Резервные значения, если pages.json недоступен (запуск через file://)
    fallbackTotal: 248,
    fallbackWidth: 870,
    fallbackHeight: 1339,

    maxWidthPage: 620,     // предельная ширина ОДНОЙ страницы, px
    minWidthPage: 260,     // ширина блока меньше 2× этого значения → портрет
    minHeightPage: 240,
    maxHeightPage: 1200,
    flippingTime: 900,     // длительность анимации, мс
    maxShadowOpacity: 0.5,

    preloadStart: 6,       // страниц ждём до снятия прелоадера
    nearBehind: 10,        // подгружать позади текущей страницы
    nearAhead: 20,         // …и впереди
    concurrent: 3,         // параллельных загрузок изображений
    edgeRatio: 0.12,       // доля ширины разворота = «клик по краю»
    hintMs: 6500,

    magnetHold: 2000,      // удержал уголок 2 с → «магнитный» переворот
    magnetTime: 2600,      // …он же — медленный и контролируемый, мс
    holdSlop: 12           // допуск движения курсора при удержании, px
  };

  /* ---------------- DOM ---------------- */
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage'), wrap = $('bookWrap'), flipbook = $('flipbook');
  var counter = $('counter'), prevBtn = $('prevBtn'), nextBtn = $('nextBtn');
  var zonePrev = $('zonePrev'), zoneNext = $('zoneNext');
  var soundBtn = $('soundBtn'), fsBtn = $('fsBtn');
  var tocBtn = $('tocBtn'), tocPanel = $('tocPanel'), tocBackdrop = $('tocBackdrop');
  var tocClose = $('tocClose'), tocList = $('tocList');
  var hint = $('hint'), loader = $('loader'), loadBar = $('loadBar'), loadNote = $('loadNote');

  /* ---------------- Состояние ---------------- */
  var book = null;
  var manifest = null;
  var total = CONFIG.fallbackTotal;
  var P_W = CONFIG.fallbackWidth, P_H = CONFIG.fallbackHeight;

  var pageEls = [];              // DOM-элементы страниц (0-based)
  var imgState = {};             // n → 'queue' | 'load' | 'ok' | 'err'
  var queue = [];                // номера страниц в очереди (по приоритету)
  var running = 0;
  var idleCursor = 1;            // фоновая предзагрузка «с начала»
  var waiters = {};              // n → [callbacks] — «страница готова»
  var initialDone = false;
  var initialGot = 0;

  var lastUserFlip = 0;
  var downX = 0, downY = 0;
  var fitScheduled = false, hintShown = false;

  /* ============================================================
     ЗВУК — короткий шелест бумаги, сгенерированный Web Audio API
     ============================================================ */
  var Sound = (function () {
    var ctx = null, enabled = true, lastAt = 0, listeners = [];

    try {
      var saved = localStorage.getItem('book.sound');
      if (saved !== null) enabled = saved === '1';
    } catch (e) { /* file:// или приватный режим */ }

    function ac() {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      if (!ctx) { try { ctx = new C(); } catch (e) { return null; } }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }

    function noise(c, dur) {
      var len = Math.max(1, Math.floor(c.sampleRate * dur));
      var buf = c.createBuffer(1, len, c.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      return buf;
    }

    function rustle() {
      if (!enabled) return;
      var c = ac(); if (!c) return;
      var now = c.currentTime;
      if (now - lastAt < 0.18) return;
      lastAt = now;

      /* 1. Мягкий шелест бумаги: широкая полоса шума без резких «свистов»,
            плавный подъём громости и такое же погашение */
      var dur = 0.62;
      var src = c.createBufferSource();
      src.buffer = noise(c, dur);
      var bp = c.createBiquadFilter();
      bp.type = 'bandpass'; bp.Q.value = 0.35;      // шире → мягче, без свиста
      bp.frequency.setValueAtTime(750, now);
      bp.frequency.exponentialRampToValueAtTime(2600, now + 0.14);
      bp.frequency.exponentialRampToValueAtTime(1100, now + dur);
      var lp = c.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 5600;   // убираем резкость
      var g = c.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.17, now + 0.11);   // без «удара»
      g.gain.exponentialRampToValueAtTime(0.055, now + 0.34);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      src.connect(bp); bp.connect(lp); lp.connect(g); g.connect(c.destination);
      src.start(now); src.stop(now + dur + 0.02);

      /* 2. Глухой мягкий «дохлоп» края листа — тихо и без щелчка */
      var s2 = c.createBufferSource();
      s2.buffer = noise(c, 0.16);
      var lp2 = c.createBiquadFilter();
      lp2.type = 'lowpass'; lp2.frequency.value = 300;
      var g2 = c.createGain();
      g2.gain.setValueAtTime(0.0001, now);
      g2.gain.exponentialRampToValueAtTime(0.09, now + 0.035);
      g2.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
      s2.connect(lp2); lp2.connect(g2); g2.connect(c.destination);
      s2.start(now); s2.stop(now + 0.2);
    }

    return {
      rustle: rustle,
      unlock: function () { var c = ac(); if (c && c.state === 'suspended') c.resume(); },
      isEnabled: function () { return enabled; },
      toggle: function () {
        enabled = !enabled;
        try { localStorage.setItem('book.sound', enabled ? '1' : '0'); } catch (e) {}
        listeners.forEach(function (fn) { fn(enabled); });
        if (enabled) rustle();
      },
      onChange: function (fn) { listeners.push(fn); }
    };
  })();

  /* ============================================================
     ИЗОБРАЖЕНИЯ: приоритетная очередь + фоновая предзагрузка
     ============================================================ */
  function clampPage(n) {
    n = Math.round(n || 1);
    return n < 1 ? 1 : (n > total ? total : n);
  }
  function srcOf(n) {
    return (manifest && manifest.pages && manifest.pages[n - 1] && manifest.pages[n - 1].src) ||
           ('assets/pages/page-' + n + '.webp');
  }

  function enqueue(n, front) {
    n = clampPage(n);
    if (imgState[n]) return;                 // уже грузится или готова
    if (queue.indexOf(n) !== -1) return;
    imgState[n] = 'queue';
    if (front) queue.unshift(n); else queue.push(n);
  }

  function pump() {
    while (running < CONFIG.concurrent && queue.length) loadOne(queue.shift());
  }

  function loadOne(n) {
    running++;
    imgState[n] = 'load';
    var img = new Image();
    img.decoding = 'async';

    var finish = function (ok) {
      running--;
      imgState[n] = ok ? 'ok' : 'err';
      if (ok) paint(n);
      markLoaded(n, ok);
      pump();
      idlePump();
    };
    img.onload = function () { finish(true); };
    img.onerror = function () { finish(false); };
    img.src = srcOf(n);                      // начинаем загрузку сразу
  }

  function isLoaded(n) { return imgState[n] === 'ok'; }

  function paint(n) {
    var el = pageEls[n - 1];
    if (!el) return;
    var inner = el.firstElementChild;
    if (inner) inner.style.backgroundImage = 'url("' + srcOf(n) + '")';
  }

  function whenLoaded(n, cb) {
    n = clampPage(n);
    if (isLoaded(n)) { cb(); return; }
    (waiters[n] = waiters[n] || []).push(cb);
  }

  function markLoaded(n, ok) {
    var list = waiters[n];
    if (list) { delete waiters[n]; list.forEach(function (fn) { try { fn(); } catch (e) {} }); }

    // Прелоадер: ждём первые N страниц (и ошибки тоже «прогресс»)
    if (!initialDone && n <= CONFIG.preloadStart) {
      initialGot++;
      setBar(initialGot / CONFIG.preloadStart);
      if (initialGot >= CONFIG.preloadStart) finishLoader();
    }
  }

  function scheduleAround(center) {
    center = clampPage(center);
    var order = [center], d, i;
    for (d = 1; d <= CONFIG.nearAhead; d++) order.push(center + d);
    for (d = 1; d <= CONFIG.nearBehind; d++) order.push(center - d);

    // Ставим в начало очереди, сохраняя приоритет (центр → вперёд → назад)
    var front = [];
    for (i = 0; i < order.length; i++) {
      var n = clampPage(order[i]);
      if (!imgState[n] && front.indexOf(n) === -1) {
        imgState[n] = 'queue';
        front.push(n);
      }
    }
    if (front.length) {
      queue = front.concat(queue.filter(function (q) { return front.indexOf(q) === -1; }));
    }
    pump();
  }

  function idlePump() {
    if (running > 0 || queue.length) return;
    while (idleCursor <= total && imgState[idleCursor]) idleCursor++;
    if (idleCursor <= total) { enqueue(idleCursor, false); pump(); }
  }

  function prewarm(n) {                       // точечная подгрузка для прыжка
    for (var d = -2; d <= 2; d++) enqueue(n + d, true);
    pump();
  }

  /* ============================================================
     РАЗМЕР КНИГИ: вписываем разворот и в ширину, и в высоту
     ============================================================ */
  function available() {
    var cs = window.getComputedStyle(stage);
    return {
      w: Math.max(200, stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
      h: Math.max(200, stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom))
    };
  }

  /* Ориентацию выбираем САМИ — от доступного места, а не от состояния
     книги (оно может быть «вчерашним»). StPageFlip считает портретным
     блок уже 2×minWidthPage, поэтому ширину жёстко согласуем с этим. */
  function widthFor(portrait, a) {
    var K = portrait ? (P_W / P_H)        // блок: одна страница
                     : ((2 * P_W) / P_H); // блок: разворот
    var cap = portrait ? CONFIG.maxWidthPage : CONFIG.maxWidthPage * 2;
    return Math.max(CONFIG.minWidthPage, Math.min(a.w, a.h * K, cap));
  }

  function fitBook() {
    var a = available();
    var K_L = (2 * P_W) / P_H;             // ширина/высота блока в альбомной
    var minW = CONFIG.minWidthPage * 2;    // порог «одна страница» у StPageFlip

    // Альбомный разворот только если он помещается и по ширине, и по высоте
    var portrait = !(a.w >= minW && a.h >= minW / K_L);

    var w = widthFor(portrait, a);
    if (portrait) w = Math.min(w, minW - 1);   // библиотека должна согласиться
    else          w = Math.max(w, minW);

    wrap.style.width = Math.round(w) + 'px';
    flipbook.classList.toggle('is-portrait', portrait);

    var shadow = $('bookShadow');
    if (shadow) shadow.style.width = Math.round(w * 0.92) + 'px';

    if (book) book.update();               // пересчёт границ + ориентации
  }

  function scheduleFit() {
    if (fitScheduled) return;
    fitScheduled = true;
    requestAnimationFrame(function () { fitScheduled = false; fitBook(); });
  }

  /* ============================================================
     СОЗДАНИЕ СТРАНИЦ
     ============================================================ */
  function createPages() {
    var frag = document.createDocumentFragment();
    for (var i = 1; i <= total; i++) {
      var el = document.createElement('div');
      el.className = 'page';
      el.setAttribute('data-page', i);
      // Первую и последнюю страницы делаем твёрдыми (обложки)
      if (i === 1 || i === total) el.setAttribute('data-density', 'hard');
      var inner = document.createElement('div');
      inner.className = 'page-content';
      el.appendChild(inner);
      pageEls.push(el);
      frag.appendChild(el);
    }
    flipbook.appendChild(frag);
  }

  /* ============================================================
     НАВИГАЦИЯ / СЧЁТЧИК
     ============================================================ */
  function updateCounter() {
    if (!book) return;
    var pc = book.getPageCollection();
    var spreads = pc.getSpread();
    var si = pc.getCurrentSpreadIndex();
    var sp = spreads[si] || [0];

    var label = (sp.length > 1)
      ? '<b>' + (sp[0] + 1) + '–' + (sp[1] + 1) + '</b>'
      : '<b>' + (sp[0] + 1) + '</b>';
    counter.innerHTML = label + '<span class="slash">/</span>' + total;

    var atStart = si <= 0;
    var atEnd = si >= spreads.length - 1;
    prevBtn.disabled = atStart;
    nextBtn.disabled = atEnd;
    zonePrev.classList.toggle('off', atStart);
    zoneNext.classList.toggle('off', atEnd);

    try { history.replaceState(null, '', '#p' + (sp[0] + 1)); } catch (e) {}
    markTocCurrent();
  }

  function turn(dir, clientY) {
    if (!book) return;
    var now = Date.now();
    if (now - lastUserFlip < 250) return;
    lastUserFlip = now;
    var corner = 'top';
    if (typeof clientY === 'number') {
      var r = wrap.getBoundingClientRect();
      if (clientY > r.top + r.height / 2) corner = 'bottom';
    }
    if (dir > 0) book.flipNext(corner); else book.flipPrev(corner);
  }

  function gotoPage(n) {
    if (!book) return;
    n = clampPage(n);
    prewarm(n);

    var jumped = false, tries = 0;

    function jump(force) {
      if (jumped || !book) return;
      // Прыгаем, пока идёт полноценная анимация перелистывания — иначе
      // индексы разворотов разъезжаются. Состояние предпросмотра угла
      // страницы (fold_corner) прыжку не мешает.
      var st = book.getState();
      var busy = (st === 'flipping' || st === 'user_fold');
      if (busy && !force) return;
      jumped = true;
      lastUserFlip = Date.now();
      book.turnToPage(n - 1);
      updateCounter();
    }

    whenLoaded(n, function () { jump(false); });
    (function poll() {
      if (jumped) return;
      jump(tries >= 60);                       // ~3 с — страховка
      if (!jumped && ++tries <= 60) setTimeout(poll, 50);
    })();
  }

  /* ============================================================
     СОДЕРЖАНИЕ — меню построенo из страниц 243–244 (сверено с текстом)
     ============================================================ */
  var tocData = (window.__TOC || []).slice();
  var tocBuilt = false;
  var tocCurrentKey = '';

  function tocKeyOf(item) { return item.p + '|' + item.n; }

  function buildToc() {
    if (tocBuilt || !tocList) return;
    tocBuilt = true;

    if (!tocData.length && window.fetch) {
      // Резерв: подтягиваем JSON, если toc.js не загрузился
      fetch('assets/pages/toc.json', { cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (Array.isArray(j)) { tocData = j; tocBuilt = false; buildToc(); } })
        .catch(function () {});
      return;
    }

    var frag = document.createDocumentFragment();
    var lastGroup = null;
    tocData.forEach(function (it) {
      var group = it.s || 'Содержание';
      if (group !== lastGroup) {
        lastGroup = group;
        var h = document.createElement('div');
        h.className = 'toc-group';
        h.textContent = group;
        if (it.u) {
          var sub = document.createElement('span');
          sub.className = 'toc-sub';
          sub.textContent = it.u;
          h.appendChild(sub);
        }
        frag.appendChild(h);
      }

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toc-item';
      btn.setAttribute('data-page', it.p);
      btn.setAttribute('data-key', tocKeyOf(it));

      var t = document.createElement('span');
      t.textContent = it.t;
      var d = document.createElement('i');
      d.className = 'ti-dots';
      var n = document.createElement('span');
      n.className = 'ti-num';
      n.textContent = it.n;              // печатный номер — как в книге

      btn.appendChild(t); btn.appendChild(d); btn.appendChild(n);
      btn.addEventListener('click', function () {
        gotoPage(it.p);
        closeToc();
      });
      frag.appendChild(btn);
    });
    tocList.appendChild(frag);
    markTocCurrent();
  }

  function markTocCurrent() {
    if (!tocList || !tocList.firstChild) return;
    var page = 1;
    if (book) {
      var pc = book.getPageCollection();
      var sp = pc.getSpread()[pc.getCurrentSpreadIndex()];
      if (sp && sp.length) page = sp[0] + 1;
    }
    // пункт, чей раздел начинается не позже текущей страницы
    var best = null;
    for (var i = 0; i < tocData.length; i++) {
      if (tocData[i].p <= page) best = tocData[i]; else break;
    }
    var key = best ? tocKeyOf(best) : '';
    if (key === tocCurrentKey) return;
    tocCurrentKey = key;

    var prev = tocList.querySelector('.is-current');
    if (prev) prev.classList.remove('is-current');
    if (key) {
      var cur = tocList.querySelector('[data-key="' + key + '"]');
      if (cur) cur.classList.add('is-current');
    }
  }

  function openToc() {
    buildToc();
    tocBackdrop.hidden = false;
    tocPanel.hidden = false;
    requestAnimationFrame(function () {
      tocBackdrop.classList.add('open');
      tocPanel.classList.add('open');
    });
    tocBtn.setAttribute('aria-expanded', 'true');
    markTocCurrent();
    var cur = tocList.querySelector('.is-current');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'center' });
  }

  function closeToc() {
    tocBackdrop.classList.remove('open');
    tocPanel.classList.remove('open');
    tocBtn.setAttribute('aria-expanded', 'false');
    setTimeout(function () {
      tocBackdrop.hidden = true;
      tocPanel.hidden = true;
    }, 400);
  }

  function tocIsOpen() { return tocBtn.getAttribute('aria-expanded') === 'true'; }

  /* ============================================================
     КЛИК ПО КРАЮ РАЗВОРОТА (с проверкой углов — их ведёт библиотека)
     ============================================================ */
  function hitTest(cx, cy) {
    if (!book) return null;
    var wr = wrap.getBoundingClientRect();
    var b = book.getBoundsRect();
    if (!b || !b.pageWidth) return null;

    var portrait = book.getOrientation() === 'portrait';
    var bx = cx - wr.left - b.left;         // координата внутри «книги»
    var by = cy - wr.top - b.top;
    var visLeft = portrait ? b.pageWidth : 0;
    var visW = portrait ? b.pageWidth : b.width;

    var f = (bx - visLeft) / visW;
    if (f < -0.03 || f > 1.03) return null; // мимо книги

    var inside = bx > 0 && by > 0 && bx < b.width && by < b.height;
    var s = Math.sqrt(b.width * b.width + b.height * b.height) / 5;
    var corner = inside && (
      Math.hypot(bx, by) < s ||
      Math.hypot(bx - b.width, by) < s ||
      Math.hypot(bx, by - b.height) < s ||
      Math.hypot(bx - b.width, by - b.height) < s
    );
    return { f: f, corner: corner };
  }

  /* Отладочный доступ (для автотестов и консоли) */
  window.__bk = {
    get book() { return book; },
    gotoPage: function (n) { return gotoPage(n); },
    turn: turn,
    hitTest: hitTest,
    counter: function () { return counter ? counter.textContent : ''; },
    orientation: function () { return book ? book.getOrientation() : null; },
    state: function () { return book ? book.getState() : null; }
  };

  /* ============================================================
     ПРЕЛОАДЕР
     ============================================================ */
  function setBar(v) {
    loadBar.style.width = Math.round(Math.min(1, Math.max(0, v)) * 100) + '%';
  }

  function finishLoader() {
    if (initialDone) return;
    initialDone = true;
    setBar(1);
    loadNote.textContent = 'Готово';
    loader.classList.add('hide');
    setTimeout(showHint, 450);
  }

  function showHint() {
    if (hintShown) return;
    hintShown = true;
    hint.classList.add('show');
    setTimeout(function () { hint.classList.remove('show'); }, CONFIG.hintMs);
  }

  /* ============================================================
     ИНИЦИАЛИЗАЦИЯ КНИГИ
     ============================================================ */
  function startBook() {
    createPages();

    fitBook();                              // до создания книги (наш resize-слушатель уже первый)

    if (typeof window.St === 'undefined' || !window.St.PageFlip) {
      loadNote.textContent = 'Не найдена библиотека vendor/page-flip.browser.js';
      setBar(0);
      return;
    }

    book = new window.St.PageFlip(flipbook, {
      size: 'stretch',
      width: P_W,
      height: P_H,
      minWidth: CONFIG.minWidthPage,
      maxWidth: CONFIG.maxWidthPage,
      minHeight: CONFIG.minHeightPage,
      maxHeight: CONFIG.maxHeightPage,
      usePortrait: true,
      autoSize: true,
      startPage: 0,
      startZIndex: 0,
      flippingTime: CONFIG.flippingTime,
      drawShadow: true,
      maxShadowOpacity: CONFIG.maxShadowOpacity,
      showCover: true,                      // обложки — твёрдые
      showPageCorners: true,
      disableFlipByClick: true,             // кликаем только по краям (см. hitTest)
      clickEventForward: true,
      useMouseEvents: true,
      mobileScrollSupport: true,
      swipeDistance: 30
    });

    /* --- события --- */
    book.on('init', function () {
      fitBook();
      updateCounter();
      scheduleAround(1);
      // точный стартовый переход из ссылки (#p123)
      var m = /[#&]p(\d+)/.exec(location.hash || '');
      if (m) gotoPage(parseInt(m[1], 10));
      if (initialDone) showHint();
    });

    book.on('flip', function (e) {
      var idx = e.data.page;
      scheduleAround(idx + 1);
      updateCounter();
    });

    book.on('changeState', function (e) {
      if (e.data === 'flipping') Sound.rustle();
    });

    book.on('changeOrientation', function () {
      scheduleFit();
      updateCounter();
    });

    book.loadFromHTML(pageEls);
    fitBook();
    scheduleAround(1);
  }

  /* ============================================================
     «МАГНИТ»: удержание уголка страницы 2 секунды →
     медленный контролируемый переворот (длительность берётся из настроек
     библиотеки, поэтому обычные клики остаются быстрыми)
     ============================================================ */
  var holdRing = document.createElement('i');
  holdRing.className = 'hold-ring';
  holdRing.setAttribute('aria-hidden', 'true');
  wrap.appendChild(holdRing);

  var hold = { timer: 0, active: false, dir: 1, corner: 'top',
               clientX: 0, clientY: 0, sx: 0, sy: 0 };

  function holdCancel() {
    if (hold.timer) { clearTimeout(hold.timer); hold.timer = 0; }
    if (hold.active) holdRing.classList.remove('show');
    hold.active = false;
  }

  function holdStart(cx, cy) {
    var hit = hitTest(cx, cy);
    if (!hit || !hit.corner) return;
    if (!book) return;

    var dir = hit.f >= 0.5 ? 1 : -1;
    if ((dir > 0 && nextBtn.disabled) || (dir < 0 && prevBtn.disabled)) return;

    hold.active = true;
    hold.dir = dir;
    hold.clientX = cx; hold.clientY = cy;
    hold.sx = cx; hold.sy = cy;
    hold.corner = (cy > wrap.getBoundingClientRect().top + wrap.getBoundingClientRect().height / 2)
      ? 'bottom' : 'top';

    var r = wrap.getBoundingClientRect();
    holdRing.style.left = (cx - r.left) + 'px';
    holdRing.style.top = (cy - r.top) + 'px';
    holdRing.classList.remove('go');
    holdRing.classList.add('show');

    hold.timer = setTimeout(magnetFlip, CONFIG.magnetHold);
  }

  function magnetFlip() {
    hold.timer = 0;
    if (!hold.active || !book) return;
    if (book.getState && book.getState() === 'flipping') { holdCancel(); return; }
    hold.active = false;
    holdRing.classList.remove('show');
    holdRing.classList.add('go');
    setTimeout(function () { holdRing.classList.remove('go'); }, 520);

    var s = (book.getSettings && book.getSettings()) || null;
    var old = s ? s.flippingTime : null;
    if (s) s.flippingTime = CONFIG.magnetTime;    // медленно и контролируемо
    try {
      // «Отпускаем» палец библиотеки — она сама начнёт переворот,
      // ровно как по клику на уголке, но в замедленном темпе.
      window.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, cancelable: true,
        clientX: hold.clientX, clientY: hold.clientY, button: 0
      }));
      if (!book.getState || book.getState() !== 'flipping') {
        if (hold.dir > 0) book.flipNext(hold.corner);
        else book.flipPrev(hold.corner);
      }
    } catch (e) { /* книга не готова — просто пропускаем */ }
    if (s && old !== null) s.flippingTime = old;

    lastUserFlip = Date.now();
    Sound.rustle();
  }

  /* ============================================================
     СОБЫТИЯ ИНТЕРФЕЙСА
     ============================================================ */
  function bindUI() {
    /* Клик/тап: ведём только сами, если попали в 12% края разворота */
    wrap.addEventListener('pointerdown', function (e) {
      downX = e.clientX; downY = e.clientY;
      Sound.unlock();
      // удержание уголка → «магнитный» переворот через 2 секунды
      if (!(e.target && e.target.closest && e.target.closest('button, a'))) {
        holdStart(e.clientX, e.clientY);
      }
    });

    /* Движение/отпускание снимают «удержание» (пользователь листает сам) */
    window.addEventListener('pointermove', function (e) {
      if (hold.active && Math.hypot(e.clientX - hold.sx, e.clientY - hold.sy) > CONFIG.holdSlop) {
        holdCancel();
      }
    }, { passive: true });
    window.addEventListener('pointerup', holdCancel);
    window.addEventListener('pointercancel', holdCancel);
    window.addEventListener('blur', holdCancel);
    document.addEventListener('visibilitychange', function () { if (document.hidden) holdCancel(); });

    wrap.addEventListener('click', function (e) {
      if (e.button && e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest('button, a')) return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 8) return;   // это был свайп
      var hit = hitTest(e.clientX, e.clientY);
      if (!hit || hit.corner) return;        // уголок страницы сама ведёт StPageFlip
      if (hit.f >= 1 - CONFIG.edgeRatio) turn(1, e.clientY);
      else if (hit.f <= CONFIG.edgeRatio) turn(-1, e.clientY);
    });

    /* Курсор-«пальчик» у краёв */
    var rafMove = 0;
    wrap.addEventListener('pointermove', function (e) {
      if (rafMove) return;
      rafMove = requestAnimationFrame(function () {
        rafMove = 0;
        var hit = hitTest(e.clientX, e.clientY);
        var edge = !!hit && !hit.corner &&
                   (hit.f >= 1 - CONFIG.edgeRatio || hit.f <= CONFIG.edgeRatio);
        wrap.classList.toggle('hot', edge);
      });
    });
    wrap.addEventListener('pointerleave', function () {
      wrap.classList.remove('hot');
    });

    prevBtn.addEventListener('click', function () { turn(-1); });
    nextBtn.addEventListener('click', function () { turn(1); });

    window.addEventListener('keydown', function (e) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (tocIsOpen() && e.key !== 'Escape') return;   // пока открыто содержание
      switch (e.key) {
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
          e.preventDefault(); turn(1); break;
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault(); turn(-1); break;
        case 'Home':
          e.preventDefault(); gotoPage(1); break;
        case 'End':
          e.preventDefault(); gotoPage(total); break;
        case 'Escape':
          if (tocIsOpen()) { e.preventDefault(); closeToc(); }
          holdCancel();
          break;
      }
    });

    /* Звук */
    var syncSound = function (on) { soundBtn.setAttribute('aria-pressed', on ? 'true' : 'false'); };
    syncSound(Sound.isEnabled());
    Sound.onChange(syncSound);
    soundBtn.addEventListener('click', function () { Sound.toggle(); });

    /* Содержание */
    tocBtn.addEventListener('click', function () {
      if (tocIsOpen()) closeToc(); else openToc();
    });
    tocClose.addEventListener('click', closeToc);
    tocBackdrop.addEventListener('click', closeToc);

    /* Во весь экран */
    fsBtn.addEventListener('click', function () {
      try {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
      } catch (e) { /* не поддерживается */ }
    });
    document.addEventListener('fullscreenchange', function () {
      fsBtn.setAttribute('aria-pressed', document.fullscreenElement ? 'true' : 'false');
      scheduleFit();
    });

    /* Ресайз и смена ориентации */
    window.addEventListener('resize', scheduleFit);
    window.addEventListener('orientationchange', scheduleFit);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleFit);
  }

  /* ============================================================
     СТАРТ
     ============================================================ */
  function loadManifest() {
    return new Promise(function (resolve) {
      if (!window.fetch) return resolve(null);
      fetch(CONFIG.manifest, { cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { resolve(j && j.total ? j : null); })
        .catch(function () { resolve(null); });
    });
  }

  function boot() {
    loadManifest().then(function (json) {
      if (json) {
        manifest = json;
        total = json.total;
        P_W = json.width || P_W;
        P_H = json.height || P_H;
      } else {
        // без манифеста — собираем имена файлов сами
        manifest = { total: total, pages: [] };
        for (var i = 1; i <= total; i++) manifest.pages.push({ src: 'assets/pages/page-' + i + '.webp' });
      }

      bindUI();          // слушатели ресайза регистрируем ДО книги
      startBook();

      // первые страницы + прелоадер
      scheduleAround(1);
      for (var n = 1; n <= CONFIG.preloadStart; n++) enqueue(n, true);
      pump();
      setBar(0);
      setTimeout(finishLoader, 10000);     // страховка по таймеру

      // если страница не пришла — не держим пользователя в прелоадере
      window.addEventListener('load', function () { setTimeout(finishLoader, 3000); });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
