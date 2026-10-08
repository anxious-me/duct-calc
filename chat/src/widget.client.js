/* Silicon Valley Comfort website chat bubble.
 * Embed: <script src="https://YOUR-WORKER/widget.js" defer></script>
 * Optional attributes on the script tag:
 *   data-color="#0b5fff"            accent color (any CSS color)
 *   data-hide-on="/contact,/book"   path prefixes where the bubble stays hidden
 */
(function () {
  if (window.__svcChatLoaded) return
  window.__svcChatLoaded = true

  var API = '__CHAT_API__'
  var PHONE = '408-691-5940'
  var STORE_KEY = 'svc-chat-v1'
  var OPEN_KEY = 'svc-chat-open'
  var MAX_TEXT = 1000
  var STALE_MS = 14 * 24 * 60 * 60 * 1000
  var script = document.currentScript
  var accent = (script && script.getAttribute('data-color')) || '#0f62fe'
  var hideOn = ((script && script.getAttribute('data-hide-on')) || '')
    .split(',')
    .map(function (s) { return s.trim().toLowerCase().replace(/\/+$/, '') || (s.trim() ? '/' : '') })
    .filter(Boolean)
  var here = location.pathname.toLowerCase().replace(/\/+$/, '') || '/'
  if (hideOn.some(function (p) { return p === '/' ? here === '/' : here === p || here.indexOf(p + '/') === 0 })) return

  var state = load() || fresh()
  var open = false
  var pollTimer = null
  var polling = false
  var sending = false
  var rendered = 0
  var scrollWas = null

  function fresh() { return { id: null, last: 0, messages: [], unread: 0, lastActivity: 0 } }
  function wide() { return window.matchMedia('(min-width: 601px)').matches }

  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY))
      if (!s || typeof s !== 'object' || !Array.isArray(s.messages) || typeof s.last !== 'number') return null
      if (s.id !== null && typeof s.id !== 'string') return null
      s.unread = +s.unread || 0
      s.lastActivity = +s.lastActivity || 0
      return s
    } catch (e) { return null }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)) } catch (e) { /* private mode */ }
  }

  // ---------- DOM ----------
  var host = document.createElement('div')
  host.style.cssText = 'position:fixed;z-index:2147483000;right:0;bottom:0;'
  host.style.setProperty('--svc-accent', accent)
  var root = host.attachShadow({ mode: 'open' })
  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}' +
    '.bubble{position:fixed;right:20px;bottom:20px;width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;background:var(--svc-accent,#0f62fe);color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;transition:transform .15s}' +
    '.bubble:hover{transform:scale(1.06)}' +
    '.bubble svg{width:28px;height:28px}' +
    '.badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#e5484d;color:#fff;font-size:12px;font-weight:700;line-height:20px;text-align:center;display:none}' +
    '.teaser{position:fixed;right:90px;bottom:32px;background:#fff;color:#1b1f24;padding:10px 14px;border-radius:14px;box-shadow:0 4px 16px rgba(0,0,0,.18);font-size:14px;max-width:230px;cursor:pointer;display:none}' +
    '.panel{position:fixed;right:20px;bottom:92px;width:370px;height:560px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.3);display:none;flex-direction:column;overflow:hidden;color:#1b1f24;overscroll-behavior:contain}' +
    '.panel.open{display:flex}' +
    '.head{background:var(--svc-accent,#0f62fe);color:#fff;padding:10px 8px 10px 14px;display:flex;align-items:center;gap:8px}' +
    '.avatar{width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex:none}' +
    '.title{font-weight:700;font-size:15px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.sub{font-size:12px;opacity:.9;margin-top:2px;white-space:nowrap}' +
    '.head .grow{flex:1;min-width:0}' +
    '.icon{background:none;border:0;color:#fff;cursor:pointer;padding:5px;border-radius:8px;display:flex;align-items:center;justify-content:center;min-width:32px;min-height:32px;text-decoration:none;flex:none;margin-left:-4px}' +
    '.icon:hover{background:rgba(255,255,255,.15)}' +
    '.icon svg{width:20px;height:20px}' +
    '.newchat{display:none}' +
    '.list{flex:1;overflow-y:auto;padding:16px;background:#f5f7fa;display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain}' +
    '.row{display:flex;flex-direction:column;max-width:85%}' +
    '.row.me{align-self:flex-end;align-items:flex-end}' +
    '.who{font-size:12px;color:#5b6472;margin:0 6px 3px}' +
    '.msg{padding:10px 13px;border-radius:16px;font-size:15px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}' +
    '.row.them .msg{background:#fff;border:1px solid #e3e7ec;border-bottom-left-radius:4px}' +
    '.row.me .msg{background:var(--svc-accent,#0f62fe);color:#fff;border-bottom-right-radius:4px}' +
    '.msg a{color:inherit;font-weight:600;text-decoration:underline}' +
    '.row.note .msg{background:#fff4e5;border-color:#f5c98a;color:#5a3d00}' +
    '.typing{font-size:12.5px;color:#5b6472;padding:0 16px 6px;background:#f5f7fa;min-height:22px;visibility:hidden}' +
    '.typing.on{visibility:visible}' +
    '.form{display:flex;gap:8px;padding:10px;border-top:1px solid #e3e7ec;background:#fff}' +
    'textarea{flex:1;resize:none;border:1px solid #d5dbe2;border-radius:12px;padding:10px 12px;font-size:16px;line-height:1.35;max-height:120px;outline:none;color:#1b1f24;background:#fff}' +
    'textarea:focus{border-color:var(--svc-accent,#0f62fe)}' +
    '.send{border:0;background:var(--svc-accent,#0f62fe);color:#fff;border-radius:12px;width:46px;cursor:pointer;display:flex;align-items:center;justify-content:center}' +
    '.send:disabled{opacity:.5;cursor:default}' +
    '.send svg{width:20px;height:20px}' +
    '.bubble:focus-visible,.icon:focus-visible,.send:focus-visible,.teaser:focus-visible{outline:3px solid #ffbf47;outline-offset:2px}' +
    '@media (max-width:600px){' +
    '.panel{right:0;bottom:0;left:0;width:100%;height:100%;height:100dvh;max-height:none;border-radius:0}' +
    '.panel.open ~ .bubble{display:none}' +
    '.icon{min-width:44px;min-height:44px;margin-left:-6px}' +
    '.head{padding-right:6px}' +
    '.form{padding-bottom:calc(10px + env(safe-area-inset-bottom))}' +
    '.bubble{right:16px;bottom:calc(16px + env(safe-area-inset-bottom))}' +
    '.teaser{right:84px;bottom:calc(26px + env(safe-area-inset-bottom))}' +
    '}' +
    '@media print{:host{display:none!important}}' +
    '@media (prefers-reduced-motion:reduce){.bubble{transition:none}.bubble:hover{transform:none}}' +
    '</style>' +
    '<div class="panel" id="svc-chat-panel" role="dialog" aria-label="Chat with Silicon Valley Comfort">' +
    '  <div class="head">' +
    '    <div class="avatar" aria-hidden="true">SVC</div>' +
    '    <div class="grow"><div class="title">Silicon Valley Comfort</div><div class="sub">AI assistant (bot)</div></div>' +
    '    <button class="icon newchat" type="button" aria-label="Start a new chat" title="New chat">' + svgNew() + '</button>' +
    '    <a class="icon" href="tel:' + PHONE.replace(/-/g, '') + '" aria-label="Call ' + PHONE + '" title="Call ' + PHONE + '">' + svgPhone() + '</a>' +
    '    <button class="icon close" type="button" aria-label="Close chat" title="Close">' + svgClose() + '</button>' +
    '  </div>' +
    '  <div class="list" role="log" aria-label="Messages"></div>' +
    '  <div class="typing" role="status" aria-live="polite"></div>' +
    '  <form class="form"><textarea rows="1" placeholder="Type a message..." aria-label="Message" enterkeyhint="send"></textarea><button class="send" type="submit" aria-label="Send">' + svgSend() + '</button></form>' +
    '</div>' +
    '<div class="teaser" role="button" tabindex="0">Questions? Ask our AI assistant.</div>' +
    '<button class="bubble" type="button" aria-label="Open chat" aria-expanded="false" aria-controls="svc-chat-panel">' + svgChat() + '<span class="badge" aria-hidden="true"></span></button>'

  var $ = function (sel) { return root.querySelector(sel) }
  var panel = $('.panel')
  var list = $('.list')
  var bubble = $('.bubble')
  var badge = $('.badge')
  var teaser = $('.teaser')
  var input = $('textarea')
  var sendBtn = $('.send')
  var typing = $('.typing')
  var newBtn = $('.newchat')

  bubble.addEventListener('click', function () { setOpen(!open) })
  teaser.addEventListener('click', function () { setOpen(true) })
  teaser.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true) }
  })
  var closeBtn = $('.close')
  closeBtn.addEventListener('click', function () { setOpen(false) })
  newBtn.addEventListener('click', function () {
    if (sending) return
    resetChat()
    notice('New chat started.')
    if (wide()) input.focus()
  })
  $('.form').addEventListener('submit', function (e) { e.preventDefault(); send() })
  panel.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); setOpen(false) }
  })
  input.addEventListener('keydown', function (e) {
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  })
  input.addEventListener('input', function () {
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 120) + 'px'
  })
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) clearTimeout(pollTimer)
    else pollNow()
  })
  window.addEventListener('online', pollNow)
  window.addEventListener('pageshow', function (e) { if (e.persisted) pollNow() })

  function mount() {
    document.body.appendChild(host)
    if (state.id && !state.lastActivity) { state.lastActivity = Date.now(); save() }
    var restore = false
    try { restore = !!sessionStorage.getItem(OPEN_KEY) } catch (e) { /* ignore */ }
    if (restore && state.id && wide()) setOpen(true, true)
    else { render(false); pollNow() }
    if (state.id) checkStale()
    else setTimeout(function () { if (!open && !state.id) teaser.style.display = 'block' }, 8000)
  }
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount)

  // restoring: reopened after a page load, so leave the visitor's focus where it is.
  function setOpen(value, restoring) {
    open = value
    panel.classList.toggle('open', open)
    bubble.setAttribute('aria-expanded', String(open))
    teaser.style.display = 'none'
    try { sessionStorage.setItem(OPEN_KEY, open ? '1' : '') } catch (e) { /* ignore */ }
    lockScroll(open && !wide())
    if (open) {
      state.unread = 0
      save()
      render(true)
      // On a phone the bubble hides behind the full-screen panel, so focus moves to the
      // close button instead of falling to the page (and no keyboard pops up).
      if (!restoring) setTimeout(function () { (wide() ? input : closeBtn).focus() }, 50)
      pollNow()
    } else {
      bubble.focus()
      schedulePoll()
    }
  }

  // Keeps the page behind a full-screen mobile panel from scrolling.
  function lockScroll(lock) {
    var style = document.documentElement.style
    if (lock && scrollWas === null) { scrollWas = style.overflow; style.overflow = 'hidden' }
    else if (!lock && scrollWas !== null) { style.overflow = scrollWas; scrollWas = null }
  }

  // ---------- rendering ----------
  // Rows are appended, never rebuilt, so screen readers only hear what is new.
  function render(force) {
    updateBadge()
    newBtn.style.display = state.id ? 'flex' : 'none'
    if (!open) return
    var atBottom = force || list.scrollHeight - list.scrollTop - list.clientHeight < 40
    if (!list.children.length || rendered > state.messages.length) {
      list.innerHTML = ''
      addRow('them', '', greeting(), 0)
      rendered = 0
      atBottom = true
    }
    var added = state.messages.slice(rendered)
    added.forEach(function (m) {
      if (m.from === 'customer') addRow('me', '', m.text, m.ts)
      else if (m.from === 'john') addRow('them', 'John (live reply)', m.text, m.ts)
      else addRow('them', 'AI assistant (bot)', m.text, m.ts)
    })
    rendered = state.messages.length
    var last = added[added.length - 1]
    if (atBottom || (last && last.from === 'customer')) list.scrollTop = list.scrollHeight
  }

  function updateBadge() {
    var n = state.unread
    badge.textContent = n
    badge.style.display = n && !open ? 'block' : 'none'
    bubble.setAttribute('aria-label', n && !open ? 'Open chat, ' + n + ' new message' + (n > 1 ? 's' : '') : 'Open chat')
  }

  function greeting() {
    return 'Hi, I am the Silicon Valley Comfort AI assistant, not John. Ask me anything about heating and cooling. Want John himself? Just ask and I will ring his phone. Need service right now? Call John at ' + PHONE + '.'
  }

  function addRow(kind, who, text, ts) {
    var row = document.createElement('div')
    row.className = 'row ' + kind
    if (who) {
      var w = document.createElement('div')
      w.className = 'who'
      w.textContent = who
      row.appendChild(w)
    }
    var msg = document.createElement('div')
    msg.className = 'msg'
    if (kind === 'me') msg.textContent = text
    else fillText(msg, text)
    if (ts && kind !== 'me') msg.title = formatTime(ts)
    row.appendChild(msg)
    list.appendChild(row)
  }

  // Phone numbers become tap-to-call links, so "call John" is one tap on a phone.
  // The regex lives inside: rows can render during mount, before later var lines have run.
  function fillText(el, text) {
    var phone = /\(?\b\d{3}\)?[-. ]?\d{3}[-. ]\d{4}\b/g
    var last = 0
    var m
    while ((m = phone.exec(text))) {
      if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)))
      var a = document.createElement('a')
      a.href = 'tel:+1' + m[0].replace(/\D/g, '')
      a.textContent = m[0]
      el.appendChild(a)
      last = m.index + m[0].length
    }
    if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)))
  }

  // A one-off line in the chat (errors, chat ended). Not stored.
  function notice(text) {
    if (!open) return
    addRow('them note', '', text, 0)
    list.scrollTop = list.scrollHeight
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    } catch (e) { return '' }
  }

  function setTyping(on) {
    if (typing.classList.contains('on') === on) return
    typing.classList.toggle('on', on)
    typing.textContent = on ? 'AI assistant is typing...' : ''
  }

  function resetChat() {
    state = fresh()
    rendered = 0
    save()
    clearTimeout(pollTimer)
    setTyping(false)
    list.innerHTML = ''
    render(true)
  }

  // ---------- network ----------
  function api(path, options) {
    return fetch(API + path, options).then(function (r) {
      var type = r.headers.get('content-type') || ''
      var parsed = type.indexOf('application/json') === 0 ? r.json() : Promise.resolve({})
      return parsed.then(function (body) {
        if (!r.ok) {
          var err = new Error(body.error || 'Something went wrong. Please try again, or call ' + PHONE + '.')
          err.status = r.status
          throw err
        }
        return body
      })
    })
  }

  function ensureChat() {
    if (state.id) return Promise.resolve(state.id)
    return api('/api/chats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: location.pathname }),
    }).then(function (res) {
      state = fresh()
      state.id = res.id
      state.lastActivity = Date.now()
      rendered = 0
      save()
      render(false)
      return res.id
    })
  }

  function send() {
    var text = input.value.trim()
    if (!text || sending) return
    if (text.length > MAX_TEXT) {
      notice('Messages are limited to ' + MAX_TEXT + ' characters. Please shorten it or send it in two parts.')
      return
    }
    sending = true
    sendBtn.disabled = true
    clearTimeout(pollTimer)
    ensureChat()
      .then(function (id) {
        return api('/api/chats/' + id + '/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: text }),
        })
      })
      .then(function () {
        input.value = ''
        input.style.height = 'auto'
        state.lastActivity = Date.now()
        save()
        return poll()
      })
      .catch(function (err) {
        if (err.status === 404) {
          resetChat()
          notice('That chat had ended, so this message did not send. Send it again to start a new chat.')
        } else {
          notice(err.status === 429 ? err.message : 'That did not send. Try again, or call ' + PHONE + '.')
        }
      })
      .then(function () {
        sending = false
        sendBtn.disabled = false
        schedulePoll()
      })
  }

  function poll() {
    if (!state.id) return Promise.resolve()
    var id = state.id
    return api('/api/chats/' + id + '?after=' + state.last)
      .then(function (res) {
        if (state.id !== id) return false
        setTyping(!!res.typing)
        if (!res.messages || !res.messages.length) return true
        var added = false
        res.messages.forEach(function (m) {
          if (typeof m.n !== 'number' || m.n <= state.last) return
          state.messages.push({ from: m.from, text: m.text, ts: m.ts || Date.now() })
          state.last = m.n
          if (m.ts && m.ts > state.lastActivity) state.lastActivity = m.ts
          if (m.from !== 'customer' && !open) state.unread++
          added = true
        })
        if (added) { save(); render(false) }
        return true
      })
      .catch(function (err) {
        if (err.status === 404 && state.id === id) {
          resetChat()
          notice('Your previous chat has ended. Start a new one below.')
        }
        return false
      })
  }

  // One poll at a time; timers and tab focus both funnel through here.
  function pollNow() {
    clearTimeout(pollTimer)
    if (polling) return
    polling = true
    var done = function () { polling = false; schedulePoll() }
    poll().then(done, done)
  }

  function schedulePoll() {
    clearTimeout(pollTimer)
    if (!state.id || document.hidden) return
    pollTimer = setTimeout(pollNow, open ? 3000 : 20000)
  }

  // A chat nobody has touched in two weeks starts over. A fresh poll runs first so
  // a late reply from John is never thrown away.
  function checkStale() {
    if (Date.now() - state.lastActivity < STALE_MS) return
    // Only a poll that worked can prove the chat really went quiet.
    poll().then(function (ok) {
      if (ok && state.id && Date.now() - state.lastActivity >= STALE_MS) {
        resetChat()
        notice('Your previous chat has ended. Start a new one below.')
      }
    })
  }

  // ---------- icons ----------
  function svgChat() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
  }
  function svgClose() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>'
  }
  function svgSend() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/></svg>'
  }
  function svgPhone() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>'
  }
  function svgNew() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>'
  }
})()
