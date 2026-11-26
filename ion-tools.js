/*! ion-tools.js — 어떤 HTML 수업자료에도 붙는 노트 / 메모 / 구문 / 단어 도구
 * 사용: <script src=".../ion-tools.js" data-doc="2025-고1-3월-18번"
 *        data-supabase-url="https://xxxx.supabase.co" data-supabase-key="anon 공개키"></script>
 * 저장: 로컬 먼저(localStorage) → Supabase 표 1개(ion_items)에 동기화. 오프라인에서도 동작.
 */
(function () {
  'use strict';
  if (window.IonTools) return;

  /* ───────── 설정 ───────── */
  var S = document.currentScript || document.querySelector('script[src*="ion-tools"]');
  var ds = (S && S.dataset) || {};
  function autoDoc() {
    var p = decodeURIComponent((location.pathname.split('/').pop() || 'index')).replace(/\.html?$/i, '').replace(/\s*\(\d+\)$/, '');
    return p || document.title || 'doc';
  }
  var CFG = {
    doc: ds.doc || autoDoc(),
    url: (ds.supabaseUrl || '').replace(/\/+$/, ''),
    key: ds.supabaseKey || '',
    table: ds.table || 'ion_items',
    createUser: ds.createUser !== 'false',
    tabs: (ds.tabs || 'note,memo,phrase,word').split(',').map(function (s) { return s.trim(); }),
    ns: ds.ns || 'ion:v1',
    bridge: (ds.bridge || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean)
  };
  var REMOTE = !!(CFG.url && CFG.key);

  /* ───────── 유틸 ───────── */
  var LS = window.localStorage;
  function jget(k, d) { try { var v = LS.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function jset(k, v) { try { LS.setItem(k, JSON.stringify(v)); } catch (e) { } }
  function nowISO() { return new Date().toISOString(); }
  function uid() { return Math.random().toString(36).slice(2, 8) + Date.now().toString(36); }
  function hash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  function debounce(fn, ms) { var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); }; }
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    (kids || []).forEach(function (c) { if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ───────── 로컬 저장소 (항목 = doc + kind + key) ───────── */
  var K_ITEMS = CFG.ns + ':items', K_DIRTY = CFG.ns + ':dirty', K_PULL = CFG.ns + ':pull', K_SESS = CFG.ns + ':sess', K_PREF = CFG.ns + ':pref';
  var items = jget(K_ITEMS, {}), dirty = jget(K_DIRTY, {}), pref = jget(K_PREF, {});
  var listeners = [];
  function iid(doc, kind, k) { return doc + '\u0001' + kind + '\u0001' + k; }
  var saveLocal = debounce(function () { jset(K_ITEMS, items); jset(K_DIRTY, dirty); }, 120);
  function flushLocal() { jset(K_ITEMS, items); jset(K_DIRTY, dirty); }
  function emit(ev) { listeners.forEach(function (f) { try { f(ev); } catch (e) { } }); }

  var Store = {
    get: function (doc, kind, k) { var it = items[iid(doc, kind, k)]; return it && !it.del ? it.body : null; },
    put: function (doc, kind, k, body) {
      var id = iid(doc, kind, k);
      items[id] = { doc: doc, kind: kind, k: k, body: body, ts: nowISO(), del: false };
      dirty[id] = items[id].ts; saveLocal(); schedulePush(); emit({ type: 'change', kind: kind });
    },
    remove: function (doc, kind, k) {
      var id = iid(doc, kind, k);
      items[id] = { doc: doc, kind: kind, k: k, body: null, ts: nowISO(), del: true };
      dirty[id] = items[id].ts; saveLocal(); schedulePush(); emit({ type: 'change', kind: kind });
    },
    list: function (kind, doc) {
      var out = [];
      for (var id in items) {
        var it = items[id];
        if (it.del || it.kind !== kind) continue;
        if (doc != null && it.doc !== doc) continue;
        out.push(it);
      }
      return out;
    }
  };

  /* ───────── Supabase 연결 (SDK 없이 REST) ───────── */
  var sess = jget(K_SESS, null);
  var state = { s: REMOTE ? (sess ? 'idle' : 'out') : 'local', msg: '', at: null };
  function setState(s, msg) { state.s = s; state.msg = msg || ''; if (s === 'ok') state.at = nowISO(); emit({ type: 'state' }); }

  function http(method, path, body, extra) {
    var headers = { apikey: CFG.key, 'Content-Type': 'application/json' };
    headers.Authorization = 'Bearer ' + ((extra && extra.anon) ? CFG.key : (sess ? sess.at : CFG.key));
    if (extra && extra.headers) for (var k in extra.headers) headers[k] = extra.headers[k];
    return fetch(CFG.url + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { }
        if (!r.ok) { var e = new Error((j && (j.msg || j.message || j.error_description || j.error)) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  function saveSess(j) {
    sess = { at: j.access_token, rt: j.refresh_token, exp: Date.now() + (j.expires_in || 3600) * 1000, uid: j.user && j.user.id, email: j.user && j.user.email };
    jset(K_SESS, sess);
  }
  function refresh() {
    if (!sess || !sess.rt) return Promise.reject(new Error('로그인이 필요합니다'));
    return http('POST', '/auth/v1/token?grant_type=refresh_token', { refresh_token: sess.rt }, { anon: true }).then(saveSess);
  }
  function authed(method, path, body, extra) {
    var pre = (sess && sess.exp - Date.now() < 60000) ? refresh() : Promise.resolve();
    return pre.then(function () { return http(method, path, body, extra); }).catch(function (e) {
      if (e.status === 401 && sess && sess.rt && !(extra && extra._retried)) {
        return refresh().then(function () { return authed(method, path, body, Object.assign({}, extra, { _retried: true })); });
      }
      throw e;
    });
  }
  var Auth = {
    sendCode: function (email) { return http('POST', '/auth/v1/otp', { email: email, create_user: CFG.createUser }, { anon: true }); },
    verify: function (email, code) {
      return http('POST', '/auth/v1/verify', { type: 'email', email: email, token: String(code).trim() }, { anon: true }).then(function (j) {
        saveSess(j); setState('idle'); return Sync.run();
      });
    },
    password: function (email, pw) {
      return http('POST', '/auth/v1/token?grant_type=password', { email: email, password: pw }, { anon: true }).then(function (j) { saveSess(j); setState('idle'); return Sync.run(); });
    },
    logout: function () { sess = null; LS.removeItem(K_SESS); setState(REMOTE ? 'out' : 'local'); },
    email: function () { return sess && sess.email; }
  };

  var pushTimer = null, running = false, again = false;
  function schedulePush() { if (!REMOTE || !sess) return; clearTimeout(pushTimer); pushTimer = setTimeout(function () { Sync.run(); }, 1500); }

  var Sync = {
    run: function () {
      if (!REMOTE || !sess) return Promise.resolve();
      if (!navigator.onLine) { setState('offline'); return Promise.resolve(); }
      if (running) { again = true; return Promise.resolve(); }
      running = true; setState('busy');
      return Sync.push().then(Sync.pull).then(function () { setState('ok'); }).catch(function (e) {
        if (e.status === 401 || e.status === 400 && /refresh|token/i.test(e.message)) { sess = null; LS.removeItem(K_SESS); setState('out', '다시 로그인해 주세요'); }
        else setState('err', e.message);
      }).then(function () { running = false; flushLocal(); if (again) { again = false; return Sync.run(); } });
    },
    push: function () {
      var ids = Object.keys(dirty);
      if (!ids.length) return Promise.resolve();
      var rows = ids.map(function (id) {
        var it = items[id];
        return { user_id: sess.uid, doc: it.doc, kind: it.kind, k: it.k, body: it.body, deleted: !!it.del, updated_at: it.ts };
      });
      var chunks = [], i;
      for (i = 0; i < rows.length; i += 200) chunks.push(rows.slice(i, i + 200));
      var path = '/rest/v1/' + CFG.table + '?on_conflict=user_id,doc,kind,k';
      var sentTs = {}; ids.forEach(function (id) { sentTs[id] = dirty[id]; });
      return chunks.reduce(function (p, c) {
        return p.then(function () { return authed('POST', path, c, { headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } }); });
      }, Promise.resolve()).then(function () {
        ids.forEach(function (id) { if (dirty[id] === sentTs[id]) delete dirty[id]; });
      });
    },
    pull: function () {
      var cursor = jget(K_PULL, '1970-01-01T00:00:00Z'), changed = false;
      function page() {
        var q = '/rest/v1/' + CFG.table + '?select=doc,kind,k,body,deleted,updated_at,synced_at&synced_at=gt.' + encodeURIComponent(cursor) + '&order=synced_at.asc&limit=500';
        return authed('GET', q).then(function (rows) {
          rows = rows || [];
          rows.forEach(function (r) {
            var id = iid(r.doc, r.kind, r.k), loc = items[id];
            if (loc && dirty[id] && Date.parse(loc.ts) > Date.parse(r.updated_at)) { /* 내 변경이 더 최신 → 유지 */ }
            else if (!loc || Date.parse(loc.ts) <= Date.parse(r.updated_at)) {
              items[id] = { doc: r.doc, kind: r.kind, k: r.k, body: r.body, ts: r.updated_at, del: !!r.deleted };
              delete dirty[id]; changed = true;
            }
            if (r.synced_at > cursor) cursor = r.synced_at;
          });
          if (rows.length >= 500) return page();
        });
      }
      return page().then(function () { jset(K_PULL, cursor); flushLocal(); if (changed) emit({ type: 'change', kind: '*' }); });
    }
  };

  /* ───────── 기존 앱 연결: localStorage 키를 그대로 서버와 동기화 (data-bridge="ion_") ───────── */
  var applying = false, kvPending = 0, lsSet = Storage.prototype.setItem, lsRm = Storage.prototype.removeItem;
  function bmatch(k) { return typeof k === 'string' && k.indexOf(CFG.ns) !== 0 && CFG.bridge.some(function (p) { return k.indexOf(p) === 0; }); }
  if (CFG.bridge.length) {
    Storage.prototype.setItem = function (k, v) { lsSet.call(this, k, v); if (this === LS && !applying && bmatch(k)) Store.put('*', 'kv', k, { v: String(v) }); };
    Storage.prototype.removeItem = function (k) { lsRm.call(this, k); if (this === LS && !applying && bmatch(k)) Store.remove('*', 'kv', k); };
  }
  function bridgeScan() {            // 이미 이 기기에 있던 값을 처음 한 번 서버 대기열에 올림
    if (!CFG.bridge.length) return;
    for (var i = 0; i < LS.length; i++) {
      var k = LS.key(i); if (!bmatch(k)) continue;
      if (items[iid('*', 'kv', k)] === undefined) Store.put('*', 'kv', k, { v: LS.getItem(k) });
    }
  }
  function bridgeApply() {           // 다른 기기에서 받은 값을 localStorage에 반영
    if (!CFG.bridge.length) return 0;
    var n = 0; applying = true;
    try {
      Store.list('kv', '*').forEach(function (it) { if (LS.getItem(it.k) !== it.body.v) { lsSet.call(LS, it.k, it.body.v); n++; } });
      for (var id in items) { var it = items[id]; if (it.kind === 'kv' && it.del && LS.getItem(it.k) !== null) { lsRm.call(LS, it.k); n++; } }
    } finally { applying = false; }
    return n;
  }

  /* ───────── 본문 텍스트 위치 찾기 (구문 하이라이트·이동) ───────── */
  var host, root, ui = {};
  function textIndex() {
    var nodes = [], full = '';
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentElement;
        if (!p || p.closest('script,style,noscript,textarea,#ion-tools-host')) return NodeFilter.FILTER_REJECT;
        return n.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var n; while ((n = w.nextNode())) { nodes.push({ n: n, s: full.length }); full += n.nodeValue; }
    return { nodes: nodes, full: full };
  }
  function rangeAt(idx, a, b) {
    var ns = idx.nodes, sN, sO, eN, eO;
    for (var i = 0; i < ns.length; i++) {
      var s = ns[i].s, e = s + ns[i].n.nodeValue.length;
      if (!sN && a < e) { sN = ns[i].n; sO = a - s; }
      if (b <= e) { eN = ns[i].n; eO = b - s; break; }
    }
    if (!sN || !eN) return null;
    var r = document.createRange(); try { r.setStart(sN, Math.max(0, sO)); r.setEnd(eN, Math.max(0, eO)); } catch (e) { return null; } return r;
  }
  function findRanges(text, ctx, all) {
    var idx = textIndex(), out = [], from = 0, p;
    if (!text) return out;
    while ((p = idx.full.indexOf(text, from)) >= 0) {
      var r = rangeAt(idx, p, p + text.length); if (r) out.push({ r: r, p: p });
      from = p + text.length; if (!all && out.length > 30) break;
    }
    if (!all && out.length > 1 && ctx) {
      var best = out.filter(function (o) { return idx.full.slice(Math.max(0, o.p - 60), o.p + text.length + 60).indexOf(ctx) >= 0; });
      if (best.length) return [best[0].r];
    }
    return out.map(function (o) { return o.r; });
  }
  var hlOK = !!(window.CSS && CSS.highlights && window.Highlight);
  var paintHL = debounce(function () {
    if (!hlOK) return;
    var rs = [];
    Store.list('phrase').forEach(function (it) { var f = findRanges(it.body.text, it.body.ctx); if (f[0]) rs.push(f[0]); });
    CSS.highlights.set('ion-phrase', new Highlight(...rs));
  }, 250);
  function jumpTo(text, ctx) {
    var f = findRanges(text, ctx); if (!f[0]) return false;
    var el = f[0].startContainer.parentElement; if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (hlOK) { CSS.highlights.set('ion-flash', new Highlight(f[0])); setTimeout(function () { CSS.highlights.delete('ion-flash'); }, 1800); }
    return true;
  }

  /* ───────── 스티커 메모 (요소 기준 상대 위치로 저장) ───────── */
  var COLORS = ['#fff3a3', '#ffd6e0', '#cfeeff', '#d9f5c8'];
  function cssPath(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement) {
      if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) { parts.unshift('#' + CSS.escape(el.id)); break; }
      var tag = el.tagName.toLowerCase(), i = 1, sib = el;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) i++;
      parts.unshift(tag + ':nth-of-type(' + i + ')');
      el = el.parentElement;
    }
    return parts.join('>');
  }
  function anchorFor(clientX, clientY) {
    host.style.pointerEvents = 'none';
    var el = document.elementFromPoint(clientX, clientY);
    host.style.pointerEvents = '';
    var px = clientX + scrollX, py = clientY + scrollY;
    if (!el || el === document.documentElement || el === document.body) return { sel: '', fx: 0, fy: 0, px: px, py: py };
    var r = el.getBoundingClientRect();
    return { sel: cssPath(el), fx: r.width ? (clientX - r.left) / r.width : 0, fy: r.height ? (clientY - r.top) / r.height : 0, px: px, py: py };
  }
  function posOf(a) {
    var el = null; if (a.sel) { try { el = document.querySelector(a.sel); } catch (e) { } }
    if (el) { var r = el.getBoundingClientRect(); if (r.width || r.height) return { x: r.left + scrollX + a.fx * r.width, y: r.top + scrollY + a.fy * r.height }; }
    return { x: a.px, y: a.py };
  }
  var stickyEls = {}, placing = false;
  function renderStickies() {
    var list = Store.list('memo', CFG.doc), seen = {};
    list.forEach(function (it) {
      seen[it.k] = 1;
      var el = stickyEls[it.k];
      if (!el) { el = stickyEls[it.k] = makeSticky(it.k); ui.layer.appendChild(el); }
      var b = it.body, p = posOf(b);
      el.style.left = Math.max(0, p.x) + 'px'; el.style.top = Math.max(0, p.y) + 'px';
      el.style.background = b.c || COLORS[0];
      el.style.display = pref.hideMemo ? 'none' : '';
      var ta = el.querySelector('textarea');
      if (root.activeElement !== ta && ta.value !== b.t) ta.value = b.t || '';
    });
    for (var k in stickyEls) if (!seen[k]) { stickyEls[k].remove(); delete stickyEls[k]; }
  }
  var relayout = (function () { var q = false; return function () { if (q) return; q = true; requestAnimationFrame(function () { q = false; renderStickies(); }); }; })();

  function makeSticky(k) {
    var ta = h('textarea', { placeholder: '메모…', rows: 3 });
    var save = debounce(function () { var b = Store.get(CFG.doc, 'memo', k); if (b && b.t !== ta.value) { b = Object.assign({}, b, { t: ta.value }); Store.put(CFG.doc, 'memo', k, b); } }, 500);
    ta.addEventListener('input', save);
    var bar = h('div', { class: 'sbar' }, [
      h('span', { class: 'sdots' }, COLORS.map(function (c) {
        return h('i', { style: 'background:' + c, onclick: function () { var b = Store.get(CFG.doc, 'memo', k); if (b) Store.put(CFG.doc, 'memo', k, Object.assign({}, b, { c: c })); } });
      })),
      h('b', { class: 'sx', title: '삭제', text: '×', onclick: function () { if (!ta.value || confirm('이 메모를 지울까요?')) Store.remove(CFG.doc, 'memo', k); } })
    ]);
    var el = h('div', { class: 'stk', 'data-k': k }, [bar, ta]);
    var drag = null;
    bar.addEventListener('pointerdown', function (e) {
      if (e.target.closest('i,b')) return;
      var r = el.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      bar.setPointerCapture(e.pointerId); e.preventDefault();
    });
    bar.addEventListener('pointermove', function (e) {
      if (!drag) return; el.style.left = (e.clientX - drag.dx + scrollX) + 'px'; el.style.top = (e.clientY - drag.dy + scrollY) + 'px';
    });
    bar.addEventListener('pointerup', function (e) {
      if (!drag) return; drag = null;
      var b = Store.get(CFG.doc, 'memo', k); if (!b) return;
      var r = el.getBoundingClientRect(), a = anchorFor(r.left + 6, r.top + 6);
      Store.put(CFG.doc, 'memo', k, Object.assign({}, b, a));
    });
    return el;
  }
  function addMemoAt(cx, cy) {
    var a = anchorFor(cx, cy), k = uid();
    Store.put(CFG.doc, 'memo', k, Object.assign({ t: '', c: COLORS[pref.ci % COLORS.length || 0] }, a));
    pref.ci = ((pref.ci || 0) + 1) % COLORS.length; jset(K_PREF, pref);
    renderStickies();
    var ta = stickyEls[k] && stickyEls[k].querySelector('textarea'); if (ta) ta.focus();
  }
  function setPlacing(on) {
    placing = on; document.documentElement.classList.toggle('ion-placing', on);
    if (ui.addMemoBtn) ui.addMemoBtn.textContent = on ? '붙일 위치를 클릭하세요 (Esc 취소)' : '+ 메모 붙이기';
    if (on) closePanel();
  }
  document.addEventListener('click', function (e) {
    if (!placing) return;
    if (e.target.closest && e.target.closest('#ion-tools-host')) return;
    e.preventDefault(); e.stopPropagation(); setPlacing(false); addMemoAt(e.clientX, e.clientY);
  }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && placing) setPlacing(false); });

  /* ───────── 패널 UI ───────── */
  var CSS_TEXT = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:-apple-system,"Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif}',
    '.dock{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:46px;height:46px;border-radius:50%;background:#1f3a5f;color:#fff;font-size:13px;font-weight:700;border:0;cursor:pointer;box-shadow:0 2px 10px #0004;display:flex;align-items:center;justify-content:center}',
    '.dock .dt{position:absolute;right:2px;top:2px;width:11px;height:11px;border-radius:50%;border:2px solid #fff;background:#9aa3b0}',
    '.dt.ok{background:#2fb26a}.dt.busy{background:#e0a21b}.dt.err,.dt.out{background:#d9534f}.dt.local{background:#9aa3b0}.dt.offline{background:#888}',
    '.drawer{position:fixed;top:0;right:0;bottom:0;width:min(380px,100vw);z-index:2147483001;background:#fff;box-shadow:-4px 0 24px #0003;display:none;flex-direction:column;color:#1d2330;font-size:14px}',
    '.drawer.on{display:flex}',
    '.hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #e6e9ee}.hd b{flex:1;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.x{border:0;background:none;font-size:22px;cursor:pointer;color:#6b7480;line-height:1}',
    '.tabs{display:flex;border-bottom:1px solid #e6e9ee}.tabs button{flex:1;padding:9px 0;border:0;background:none;font-size:13px;cursor:pointer;color:#6b7480;border-bottom:2px solid transparent}.tabs button.on{color:#2f5bff;border-color:#2f5bff;font-weight:700}',
    '.body{flex:1;overflow:auto;padding:12px}',
    'textarea,input{width:100%;border:1px solid #d3d8df;border-radius:8px;padding:8px 10px;font-size:14px;color:#1d2330;background:#fff;outline:0}textarea:focus,input:focus{border-color:#2f5bff}',
    '.note{height:calc(100vh - 150px);resize:none;line-height:1.6}',
    '.btn{border:1px solid #cdd5e0;background:#fff;border-radius:8px;padding:7px 12px;font-size:13px;cursor:pointer;color:#1d2330}.btn.pri{background:#1f3a5f;color:#fff;border-color:#1f3a5f}.btn.sm{padding:3px 8px;font-size:12px}',
    '.row{display:flex;gap:6px;align-items:center;margin-bottom:8px}',
    '.card{border:1px solid #e3e6ea;border-radius:10px;padding:9px 11px;margin-bottom:8px;background:#fafbfc}',
    '.card .t{font-size:14px;line-height:1.5;cursor:pointer}.card .m{font-size:11.5px;color:#8a93a1;margin-top:3px;display:flex;gap:8px;align-items:center}.card textarea{margin-top:6px;font-size:13px;min-height:44px}',
    '.card .m .sp{flex:1}.link{color:#2f5bff;cursor:pointer}.del{color:#b3bac6;cursor:pointer;border:0;background:none;font-size:15px}.del:hover{color:#d9534f}',
    '.empty{color:#9aa3b0;text-align:center;padding:30px 0;font-size:13px}',
    '.hint{font-size:12px;color:#8a93a1;margin:6px 0}',
    '.wd{display:flex;align-items:center;gap:8px;padding:7px 4px;border-bottom:1px solid #eef0f3}.wd .en{font-family:Georgia,serif;font-weight:700;font-size:15px;min-width:90px;cursor:pointer}.wd input{border:0;padding:3px 4px;border-bottom:1px dashed #d3d8df;border-radius:0;flex:1;font-size:13px}.star{cursor:pointer;color:#c4cad4;font-size:16px;border:0;background:none}.star.on{color:#f0a60c}',
    '.sel{position:fixed;z-index:2147483002;display:none;background:#1f3a5f;border-radius:8px;padding:4px;box-shadow:0 2px 10px #0005;gap:2px}.sel.on{display:flex}.sel button{border:0;background:none;color:#fff;font-size:12.5px;padding:5px 9px;border-radius:6px;cursor:pointer}.sel button:hover{background:#ffffff26}',
    '.layer{position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147482990}',
    '.stk{position:absolute;width:190px;border-radius:4px;box-shadow:0 3px 10px #0003;display:flex;flex-direction:column}.stk .sbar{display:flex;align-items:center;justify-content:space-between;padding:3px 6px;cursor:move;background:#0000000d;touch-action:none}',
    '.sdots{display:flex;gap:4px}.sdots i{width:11px;height:11px;border-radius:50%;border:1px solid #0003;cursor:pointer}.sx{cursor:pointer;color:#6b7480;font-size:16px;line-height:1}',
    '.stk textarea{border:0;background:transparent;border-radius:0 0 4px 4px;min-height:70px;resize:vertical;font-size:13px;color:#222}',
    '.toast{position:fixed;left:16px;bottom:16px;z-index:2147483003;background:#1f3a5f;color:#fff;border-radius:10px;padding:9px 12px;font-size:13px;display:none;gap:10px;align-items:center;box-shadow:0 2px 10px #0005}.toast.on{display:flex}.toast button{border:0;border-radius:6px;padding:4px 10px;cursor:pointer}',
    '.stat{font-size:13px;line-height:1.7}.stat .pill{display:inline-block;padding:1px 9px;border-radius:10px;font-size:12px;background:#eef2ff;color:#2443c9}',
    '@media print{.dock,.drawer,.sel,.layer{display:none!important}}'
  ].join('');

  var pushed = null, W = 380;
  function fsEl() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function pushPage(on) {
    var de = document.documentElement;
    if (pushed) {                                   // 이전 상태 복원
      de.style.marginRight = pushed.m; de.style.overflowX = pushed.o; de.style.transition = pushed.t;
      if (pushed.f) pushed.f.style.width = pushed.fw;
      pushed = null;
    }
    if (on && innerWidth >= 760) {
      var f = fsEl(), fe = f && f !== de ? f : null;
      pushed = { m: de.style.marginRight, o: de.style.overflowX, t: de.style.transition, f: fe, fw: fe ? fe.style.width : '' };
      if (fe) fe.style.width = 'calc(100% - ' + W + 'px)';
      else { de.style.transition = 'margin-right .15s'; de.style.marginRight = W + 'px'; de.style.overflowX = 'auto'; }
    }
    setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 180);
  }
  /* 전체화면: 전체화면 요소 안으로 도구를 옮겨야 보임 */
  function onFS() {
    var f = fsEl(), tgt = f && f !== document.documentElement && f !== document.body ? f : document.body;
    if (host.parentNode !== tgt) tgt.appendChild(host);
    if (ui.drawer.classList.contains('on')) pushPage(true);
  }
  document.addEventListener('fullscreenchange', onFS); document.addEventListener('webkitfullscreenchange', onFS);
  function openPanel(tab) { ui.drawer.classList.add('on'); pushPage(true); if (tab) showTab(tab); else drawTab(true); }
  function closePanel() { ui.drawer.classList.remove('on'); pushPage(false); }
  var curTab = null;
  var TABNAME = { note: '노트', memo: '메모', phrase: '구문', word: '단어', acct: '계정' };
  function showTab(t) { curTab = t; Array.prototype.forEach.call(ui.tabs.children, function (b) { b.classList.toggle('on', b.dataset.t === t); }); drawTab(true); }
  function drawTab(force) {
    if (!curTab) return;
    var fn = { note: drawNote, memo: drawMemo, phrase: drawPhrase, word: drawWord, acct: drawAcct }[curTab];
    var keep = root.activeElement, ks = keep && keep.dataset && keep.dataset.keep;
    if (!force && ks && ui.body.contains(keep)) return;     // 입력 중에는 다시 그리지 않음
    ui.body.textContent = ''; fn(ui.body);
  }

  function drawNote(box) {
    var cur = Store.get('*', 'note', 'main') || { t: '' };
    var ta = h('textarea', { class: 'note', 'data-keep': 1, placeholder: '나의 공용 노트를 자유롭게 적으세요. 자동 저장됩니다.' });
    ta.value = cur.t;
    var info = h('div', { class: 'hint', text: cur.ts ? '마지막 저장 ' + fmtTime(cur.ts) : '' });
    var save = debounce(function () { Store.put('*', 'note', 'main', { t: ta.value, ts: nowISO() }); info.textContent = '저장됨 ' + fmtTime(nowISO()); }, 600);
    ta.addEventListener('input', save);
    box.appendChild(ta); box.appendChild(info);
  }

  function drawMemo(box) {
    ui.addMemoBtn = h('button', { class: 'btn pri', text: '+ 메모 붙이기', onclick: function () { setPlacing(!placing); } });
    var tog = h('button', { class: 'btn', text: pref.hideMemo ? '메모 보이기' : '메모 숨기기', onclick: function () { pref.hideMemo = !pref.hideMemo; jset(K_PREF, pref); renderStickies(); drawTab(); } });
    box.appendChild(h('div', { class: 'row' }, [ui.addMemoBtn, tog]));
    box.appendChild(h('div', { class: 'hint', text: '붙인 메모는 머리 부분을 끌어서 옮기고, 색 점으로 색을 바꿉니다.' }));
    var list = Store.list('memo', CFG.doc).sort(function (a, b) { return a.ts < b.ts ? 1 : -1; });
    if (!list.length) box.appendChild(h('div', { class: 'empty', text: '아직 메모가 없습니다.' }));
    list.forEach(function (it) {
      var card = h('div', { class: 'card' }, [
        h('div', { class: 't', text: it.body.t || '(빈 메모)', onclick: function () { var el = stickyEls[it.k]; if (el) { closePanel(); window.scrollTo({ top: Math.max(0, el.offsetTop - 120), behavior: 'smooth' }); } } }),
        h('div', { class: 'm' }, [h('span', { text: fmtTime(it.ts) }), h('span', { class: 'sp' }), h('button', { class: 'del', text: '삭제', onclick: function () { Store.remove(CFG.doc, 'memo', it.k); } })])
      ]);
      box.appendChild(card);
    });
  }

  var phScope = 'doc', phQ = '';
  function drawPhrase(box) {
    var q = h('input', { placeholder: '구문 검색', value: phQ, 'data-keep': 1, oninput: function (e) { phQ = e.target.value; renderList(); } });
    var sc = h('button', { class: 'btn sm', text: phScope === 'doc' ? '이 자료만' : '전체 자료', onclick: function () { phScope = phScope === 'doc' ? 'all' : 'doc'; drawTab(); } });
    box.appendChild(h('div', { class: 'row' }, [q, sc]));
    box.appendChild(h('div', { class: 'hint', text: '본문에서 문장을 드래그하면 나타나는 "구문 담기"로 저장합니다.' }));
    var listBox = h('div'); box.appendChild(listBox);
    function renderList() {
      listBox.textContent = '';
      var arr = Store.list('phrase', undefined).filter(function (it) { if (phScope === 'doc' && (it.body.src || it.doc) !== CFG.doc) return false; var s = (it.body.text + ' ' + (it.body.memo || '')).toLowerCase(); return !phQ || s.indexOf(phQ.toLowerCase()) >= 0; })
        .sort(function (a, b) { return a.ts < b.ts ? 1 : -1; });
      if (!arr.length) { listBox.appendChild(h('div', { class: 'empty', text: '담은 구문이 없습니다.' })); return; }
      arr.forEach(function (it) {
        var memo = h('textarea', { placeholder: '내 메모', 'data-keep': 1 }); memo.value = it.body.memo || '';
        var sv = debounce(function () { Store.put(it.doc, 'phrase', it.k, Object.assign({}, it.body, { memo: memo.value })); }, 600);
        memo.addEventListener('input', sv);
        var here = (it.body.src || it.doc) === CFG.doc;
        listBox.appendChild(h('div', { class: 'card' }, [
          h('div', { class: 't', text: it.body.text, onclick: function () { if (here && jumpTo(it.body.text, it.body.ctx)) closePanel(); } }),
          memo,
          h('div', { class: 'm' }, [h('span', { text: fmtTime(it.ts) }), h('span', { class: 'sp', text: here ? '' : (it.body.src || it.doc) }),
            h('button', { class: 'del', text: '삭제', onclick: function () { if (confirm('이 구문을 지울까요?')) Store.remove(it.doc, 'phrase', it.k); } })])
        ]));
      });
    }
    renderList();
  }

  var wdQ = '', focusWord = null;
  function drawWord(box) {
    var en = h('input', { placeholder: '영어', 'data-keep': 1 }), ko = h('input', { placeholder: '뜻', 'data-keep': 1 });
    var add = function () {
      var e = en.value.trim(); if (!e) return;
      Store.put('*', 'word', e.toLowerCase(), { en: e, ko: ko.value.trim(), star: false, src: CFG.doc });
      en.value = ko.value = ''; drawTab();
    };
    ko.addEventListener('keydown', function (e) { if (e.key === 'Enter') add(); });
    en.addEventListener('keydown', function (e) { if (e.key === 'Enter') ko.focus(); });
    box.appendChild(h('div', { class: 'row' }, [en, ko, h('button', { class: 'btn pri sm', text: '추가', onclick: add })]));
    var q = h('input', { placeholder: '내 단어장 검색', value: wdQ, 'data-keep': 1, oninput: function (e) { wdQ = e.target.value; renderList(); } });
    box.appendChild(h('div', { class: 'row' }, [q]));
    var listBox = h('div'); box.appendChild(listBox);
    function renderList() {
      listBox.textContent = '';
      var arr = Store.list('word').filter(function (it) { return !wdQ || (it.body.en + ' ' + it.body.ko).toLowerCase().indexOf(wdQ.toLowerCase()) >= 0; })
        .sort(function (a, b) { return a.ts < b.ts ? 1 : -1; });
      if (!arr.length) { listBox.appendChild(h('div', { class: 'empty', text: '단어를 추가해 보세요. 모든 자료에서 같은 단어장이 보입니다.' })); return; }
      arr.forEach(function (it) {
        var kin = h('input', { placeholder: '뜻', 'data-keep': 1 }); kin.value = it.body.ko || '';
        var sv = debounce(function () { Store.put('*', 'word', it.k, Object.assign({}, it.body, { ko: kin.value })); }, 600);
        kin.addEventListener('input', sv);
        var st = h('button', { class: 'star' + (it.body.star ? ' on' : ''), text: '★', onclick: function () { Store.put('*', 'word', it.k, Object.assign({}, it.body, { star: !it.body.star })); } });
        listBox.appendChild(h('div', { class: 'wd' }, [
          h('span', { class: 'en', text: it.body.en, title: '누르면 발음', onclick: function () { speak(it.body.en); } }), kin, st,
          h('button', { class: 'del', text: '×', onclick: function () { Store.remove('*', 'word', it.k); } })
        ]));
        if (focusWord === it.k) { setTimeout(function () { kin.focus(); }, 30); focusWord = null; }
      });
    }
    renderList();
  }
  function speak(t) { try { var u = new SpeechSynthesisUtterance(t); u.lang = 'en-US'; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) { } }

  var acctEmail = '', acctStep = 0, acctMsg = '', acctMode = 'pw';
  var STXT = { local: '이 기기에만 저장 중 (서버 미설정)', out: '로그인하면 서버에 동기화됩니다', idle: '대기', busy: '동기화 중…', ok: '동기화됨', err: '동기화 오류', offline: '오프라인 (연결되면 자동 동기화)' };
  function drawAcct(box) {
    var pend = Object.keys(dirty).length;
    box.appendChild(h('div', { class: 'stat' }, [
      h('span', { class: 'pill', text: STXT[state.s] || state.s }),
      h('div', { text: state.msg || '' }),
      h('div', { text: state.at ? '마지막 동기화 ' + fmtTime(state.at) : '' }),
      h('div', { text: '서버에 올리지 못한 항목 ' + pend + '개' }),
      Auth.email() ? h('div', { text: '계정: ' + Auth.email() }) : null
    ]));
    if (!REMOTE) { box.appendChild(h('div', { class: 'hint', text: 'data-supabase-url / data-supabase-key를 설정하면 서버 동기화가 켜집니다.' })); return; }
    if (sess) {
      box.appendChild(h('div', { class: 'row' }, [
        h('button', { class: 'btn pri', text: '지금 동기화', onclick: function () { Sync.run(); } }),
        h('button', { class: 'btn', text: '로그아웃', onclick: function () { Auth.logout(); drawTab(); } })
      ])); return;
    }
    var em = h('input', { type: 'email', placeholder: '이메일', value: acctEmail, 'data-keep': 1 });
    var pw = h('input', { type: 'password', placeholder: '비밀번호', 'data-keep': 1 });
    var cd = h('input', { placeholder: '이메일로 받은 6자리 코드', inputmode: 'numeric', 'data-keep': 1 });
    var msg = h('div', { class: 'hint', text: acctMsg });
    var doPw = function () {
      acctEmail = em.value.trim(); if (!acctEmail || !pw.value) { msg.textContent = '이메일과 비밀번호를 입력하세요'; return; }
      msg.textContent = '확인 중…';
      Auth.password(acctEmail, pw.value).then(function () { acctMsg = ''; drawTab(true); }).catch(function (e) { msg.textContent = '실패: ' + e.message; });
    };
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') doPw(); });
    if (acctMode === 'pw') {
      box.appendChild(h('div', { class: 'row' }, [em])); box.appendChild(h('div', { class: 'row' }, [pw, h('button', { class: 'btn pri sm', text: '로그인', onclick: doPw })]));
      box.appendChild(h('div', { class: 'row' }, [h('button', { class: 'btn sm', text: '이메일 코드로 로그인', onclick: function () { acctEmail = em.value.trim(); acctMode = 'code'; acctStep = 0; acctMsg = ''; drawTab(true); } })]));
    } else if (acctStep === 0) {
      box.appendChild(h('div', { class: 'row' }, [em, h('button', { class: 'btn pri sm', text: '코드 받기', onclick: function () {
        acctEmail = em.value.trim(); if (!acctEmail) return; msg.textContent = '보내는 중…';
        Auth.sendCode(acctEmail).then(function () { acctStep = 1; acctMsg = '메일로 코드를 보냈습니다.'; drawTab(true); }).catch(function (e) { msg.textContent = '실패: ' + e.message; });
      } })]));
      box.appendChild(h('div', { class: 'row' }, [h('button', { class: 'btn sm', text: '비밀번호로 로그인', onclick: function () { acctMode = 'pw'; acctMsg = ''; drawTab(true); } })]));
    } else {
      box.appendChild(h('div', { class: 'row' }, [cd, h('button', { class: 'btn pri sm', text: '로그인', onclick: function () {
        msg.textContent = '확인 중…';
        Auth.verify(acctEmail, cd.value).then(function () { acctStep = 0; acctMsg = ''; drawTab(true); }).catch(function (e) { msg.textContent = '실패: ' + e.message; });
      } })]));
      box.appendChild(h('div', { class: 'row' }, [h('button', { class: 'btn sm', text: '이메일 다시 입력', onclick: function () { acctStep = 0; acctMsg = ''; drawTab(true); } })]));
    }
    box.appendChild(msg);
  }

  /* ───────── 선택 → 구문/단어 담기 ───────── */
  function onSelect() {
    var s = window.getSelection(), t = s ? s.toString().trim() : '';
    if (!t || t.length > 600 || s.rangeCount === 0) { ui.sel.classList.remove('on'); return; }
    var n = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement);
    if (n && n.closest && (n.closest('#ion-tools-host') || n.closest('textarea,input'))) { ui.sel.classList.remove('on'); return; }
    var r = s.getRangeAt(0).getBoundingClientRect();
    var words = t.split(/\s+/).length;
    ui.selWord.style.display = words <= 3 && /[A-Za-z]/.test(t) ? '' : 'none';
    ui.sel.style.left = Math.min(innerWidth - 170, Math.max(8, r.left + r.width / 2 - 70)) + 'px';
    ui.sel.style.top = Math.max(8, r.top - 44) + 'px';
    ui.sel.classList.add('on'); ui.selText = t;
  }
  function ctxOf(t) {
    var s = window.getSelection(); if (!s.rangeCount) return '';
    var idx = textIndex(), rg = s.getRangeAt(0), p = -1;
    for (var i = 0; i < idx.nodes.length; i++) if (idx.nodes[i].n === rg.startContainer) { p = idx.nodes[i].s + rg.startOffset; break; }
    if (p < 0) return '';
    return idx.full.slice(Math.max(0, p - 60), p + t.length + 60);
  }
  function savePhrase() {
    var t = ui.selText.replace(/\s+/g, ' ').trim(); if (!t) return;
    var ctx = ctxOf(ui.selText);
    var k = hash(CFG.doc + '|' + t), old = Store.get('*', 'phrase', k);
    Store.put('*', 'phrase', k, { text: t, ctx: ctx, memo: old ? old.memo : '', src: CFG.doc });
    window.getSelection().removeAllRanges(); ui.sel.classList.remove('on'); paintHL(); openPanel('phrase');
  }
  function saveWord() {
    var t = ui.selText.replace(/[^A-Za-z'\- ]/g, '').trim(); if (!t) return;
    var k = t.toLowerCase();
    if (!Store.get('*', 'word', k)) Store.put('*', 'word', k, { en: t, ko: '', star: false, src: CFG.doc });
    focusWord = k; window.getSelection().removeAllRanges(); ui.sel.classList.remove('on'); openPanel('word');
  }

  /* ───────── 조립 ───────── */
  function build() {
    host = h('div', { id: 'ion-tools-host' });
    host.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483000';
    root = host.attachShadow({ mode: 'open' });
    root.appendChild(h('style', { text: CSS_TEXT }));
    ui.layer = h('div', { class: 'layer' });
    ui.dt = h('span', { class: 'dt local' });
    ui.dock = h('button', { class: 'dock', title: 'ION 도구', onclick: function () { ui.drawer.classList.contains('on') ? closePanel() : openPanel(curTab || CFG.tabs[0]); } }, ['ION', ui.dt]);
    ui.tabs = h('div', { class: 'tabs' }, CFG.tabs.concat(['acct']).map(function (t) { return h('button', { 'data-t': t, text: TABNAME[t] || t, onclick: function () { showTab(t); } }); }));
    ui.body = h('div', { class: 'body' });
    ui.drawer = h('div', { class: 'drawer' }, [
      h('div', { class: 'hd' }, [h('b', { text: CFG.doc }), h('button', { class: 'x', text: '×', onclick: closePanel })]), ui.tabs, ui.body]);
    ui.selWord = h('button', { text: '단어 담기', onclick: saveWord });
    ui.sel = h('div', { class: 'sel' }, [h('button', { text: '구문 담기', onclick: savePhrase }), ui.selWord]);
    ui.sel.addEventListener('mousedown', function (e) { e.preventDefault(); });
    ui.toast = h('div', { class: 'toast' }, [h('span', { text: '다른 기기에서 바뀐 데이터가 있어요' }), h('button', { text: '새로고침', onclick: function () { location.reload(); } }), h('button', { text: '×', onclick: function () { ui.toast.classList.remove('on'); } })]);
    root.appendChild(ui.toast); root.appendChild(ui.layer); root.appendChild(ui.dock); root.appendChild(ui.drawer); root.appendChild(ui.sel);
    document.body.appendChild(host);

    var st = document.createElement('style');
    st.textContent = '::highlight(ion-phrase){background:#fde58a;color:inherit}::highlight(ion-flash){background:#ffb347;color:inherit}html.ion-placing,html.ion-placing *{cursor:crosshair!important}';
    document.head.appendChild(st);

    curTab = CFG.tabs[0];
    showTab(curTab);
    document.addEventListener('mouseup', function () { setTimeout(onSelect, 10); });
    document.addEventListener('keyup', function (e) { if (e.shiftKey || e.key.indexOf('Arrow') === 0) setTimeout(onSelect, 10); });
    document.addEventListener('selectionchange', debounce(function () { if (!window.getSelection().toString().trim()) ui.sel.classList.remove('on'); else if ('ontouchstart' in window) onSelect(); }, 250));
    window.addEventListener('resize', relayout);
    if (window.ResizeObserver) new ResizeObserver(relayout).observe(document.body);
    window.addEventListener('load', function () { relayout(); paintHL(); });
    window.addEventListener('beforeunload', flushLocal);
    window.addEventListener('online', function () { Sync.run(); });
    window.addEventListener('offline', function () { setState('offline'); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) Sync.run(); });
    setInterval(function () { if (!document.hidden) Sync.run(); }, 60000);
    renderStickies(); paintHL();
  }

  listeners.push(function (ev) {
    if (!host) return;
    if (ev.type === 'state') { ui.dt.className = 'dt ' + (state.s === 'idle' ? 'ok' : state.s); if (curTab === 'acct') { ui.body.textContent = ''; drawAcct(ui.body); } return; }
    if (ev.kind === '*' && bridgeApply()) ui.toast.classList.add('on');
    renderStickies(); paintHL(); drawTab();
  });

  window.IonTools = {
    config: CFG, store: Store, auth: Auth, sync: function () { return Sync.run(); },
    state: function () { return { state: state.s, msg: state.msg, pending: Object.keys(dirty).length, email: Auth.email() }; },
    open: openPanel, close: closePanel, on: function (f) { listeners.push(f); },
    importLocal: function (map) {          // 기존 앱의 localStorage 값을 한 번에 올릴 때 사용: {키: 값}
      Object.keys(map).forEach(function (k) { Store.put('*', 'kv', k, map[k]); });
    }
  };

  function boot() { build(); bridgeScan(); if (REMOTE && sess) { setState('idle'); Sync.run(); } else emit({ type: 'state' }); }
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
