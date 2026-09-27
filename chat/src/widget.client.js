/* Silicon Valley Comfort website chat bubble.
 * Embed: <script src="https://YOUR-WORKER/widget.js" defer></script>
 * Optional attributes on the script tag:
 *   data-color="#0b5fff"   accent color
 *   data-hide-on="/contact,/book"   paths where the bubble stays hidden
 */
(function () {
  if (window.__svcChatLoaded) return
  window.__svcChatLoaded = true

  var API = '__CHAT_API__'
  var PHONE = '408-691-5940'
  var STORE_KEY = 'svc-chat-v1'
  var script = document.currentScript
  var accent = (script && script.getAttribute('data-color')) || '#0f62fe'
  var hideOn = ((script && script.getAttribute('data-hide-on')) || '')
    .split(',')
    .map(function (s) { return s.trim() })
    .filter(Boolean)

  if (hideOn.some(function (p) { return location.pathname.indexOf(p) === 0 })) return

  var state = load() || { id: null, last: 0, messages: [], unread: 0 }
  var open = false
  var status = 'online'
  var pollTimer = null
  var sending = false

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) } catch (e) { return null }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)) } catch (e) { /* private mode */ }
  }

  // ---------- DOM ----------
  var host = document.createElement('div')
  host.style.cssText = 'position:fixed;z-index:2147483000;right:0;bottom:0;'
  var root = host.attachShadow({ mode: 'open' })
  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}' +
    '.bubble{position:fixed;right:20px;bottom:20px;width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;background:' + accent + ';color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;transition:transform .15s}' +
    '.bubble:hover{transform:scale(1.06)}' +
    '.bubble svg{width:28px;height:28px}' +
    '.badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#e5484d;color:#fff;font-size:12px;font-weight:700;line-height:20px;text-align:center;display:none}' +
    '.teaser{position:fixed;right:90px;bottom:32px;background:#fff;color:#1b1f24;padding:10px 14px;border-radius:14px;box-shadow:0 4px 16px rgba(0,0,0,.18);font-size:14px;max-width:230px;cursor:pointer;display:none}' +
    '.panel{position:fixed;right:20px;bottom:92px;width:370px;height:560px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.3);display:none;flex-direction:column;overflow:hidden;color:#1b1f24}' +
    '.panel.open{display:flex}' +
    '.head{background:' + accent + ';color:#fff;padding:14px 16px;display:flex;align-items:center;gap:12px}' +
    '.avatar{width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;flex:none}' +
    '.title{font-weight:700;font-size:16px;line-height:1.2}' +
    '.sub{font-size:12.5px;opacity:.9;margin-top:2px;display:flex;align-items:center;gap:6px}' +
    '.dot{width:8px;height:8px;border-radius:50%;background:#3ddc84}' +
    '.dot.away{background:#f5a524}' +
    '.head .grow{flex:1;min-width:0}' +
    '.icon{background:none;border:0;color:#fff;cursor:pointer;padding:6px;border-radius:8px;display:flex;text-decoration:none}' +
    '.icon:hover{background:rgba(255,255,255,.15)}' +
    '.icon svg{width:20px;height:20px}' +
    '.list{flex:1;overflow-y:auto;padding:16px;background:#f5f7fa;display:flex;flex-direction:column;gap:10px}' +
    '.row{display:flex;flex-direction:column;max-width:85%}' +
    '.row.me{align-self:flex-end;align-items:flex-end}' +
    '.who{font-size:11px;color:#6b7480;margin:0 6px 3px}' +
    '.msg{padding:10px 13px;border-radius:16px;font-size:15px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}' +
    '.row.them .msg{background:#fff;border:1px solid #e3e7ec;border-bottom-left-radius:4px}' +
    '.row.me .msg{background:' + accent + ';color:#fff;border-bottom-right-radius:4px}' +
    '.note{font-size:12.5px;color:#4a525c;background:#fff8e6;border:1px solid #f3dfa8;border-radius:10px;padding:10px 12px;line-height:1.4}' +
    '.note a{color:inherit;font-weight:700}' +
    '.typing{font-size:12.5px;color:#6b7480;padding:0 16px 6px;background:#f5f7fa;display:none}' +
    '.form{display:flex;gap:8px;padding:10px;border-top:1px solid #e3e7ec;background:#fff}' +
    'textarea{flex:1;resize:none;border:1px solid #d5dbe2;border-radius:12px;padding:10px 12px;font-size:16px;line-height:1.35;max-height:120px;outline:none;color:#1b1f24;background:#fff}' +
    'textarea:focus{border-color:' + accent + '}' +
    '.send{border:0;background:' + accent + ';color:#fff;border-radius:12px;width:46px;cursor:pointer;display:flex;align-items:center;justify-content:center}' +
    '.send:disabled{opacity:.5;cursor:default}' +
    '.send svg{width:20px;height:20px}' +
    '@media (max-width:600px){' +
    '.panel{right:0;bottom:0;width:100vw;height:100%;max-height:none;border-radius:0}' +
    '.panel.open ~ .bubble{display:none}' +
    '.bubble{right:16px;bottom:16px}' +
    '.teaser{right:84px;bottom:26px}' +
    '}' +
    '</style>' +
    '<div class="panel" role="dialog" aria-label="Chat with Silicon Valley Comfort">' +
    '  <div class="head">' +
    '    <div class="avatar">JT</div>' +
    '    <div class="grow"><div class="title">Text John</div><div class="sub"><span class="dot"></span><span class="status">Silicon Valley Comfort</span></div></div>' +
    '    <a class="icon" href="tel:' + PHONE.replace(/-/g, '') + '" aria-label="Call ' + PHONE + '" title="Call ' + PHONE + '">' + svgPhone() + '</a>' +
    '    <button class="icon close" aria-label="Close chat">' + svgClose() + '</button>' +
    '  </div>' +
    '  <div class="list" aria-live="polite"></div>' +
    '  <div class="typing">Typing...</div>' +
    '  <form class="form"><textarea rows="1" placeholder="Type a message..." aria-label="Message"></textarea><button class="send" type="submit" aria-label="Send">' + svgSend() + '</button></form>' +
    '</div>' +
    '<div class="teaser">Questions? Text the actual tech.</div>' +
    '<button class="bubble" aria-label="Open chat">' + svgChat() + '<span class="badge"></span></button>'

  var $ = function (sel) { return root.querySelector(sel) }
  var panel = $('.panel')
  var list = $('.list')
  var bubble = $('.bubble')
  var badge = $('.badge')
  var teaser = $('.teaser')
  var input = $('textarea')
  var sendBtn = $('.send')
  var typing = $('.typing')

  bubble.addEventListener('click', function () { setOpen(!open) })
  teaser.addEventListener('click', function () { setOpen(true) })
  $('.close').addEventListener('click', function () { setOpen(false) })
  $('.form').addEventListener('submit', function (e) { e.preventDefault(); send() })
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  })
  input.addEventListener('input', function () {
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 120) + 'px'
  })
  document.addEventListener('visibilitychange', schedulePoll)

  function mount() {
    document.body.appendChild(host)
    render()
    schedulePoll()
    if (!state.id) setTimeout(function () { if (!open) teaser.style.display = 'block' }, 8000)
  }
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount)

  function setOpen(value) {
    open = value
    panel.classList.toggle('open', open)
    teaser.style.display = 'none'
    if (open) {
      state.unread = 0
      save()
      render()
      setTimeout(function () { input.focus() }, 50)
    }
    schedulePoll()
  }

  // ---------- rendering ----------
  function render() {
    list.innerHTML = ''
    addRow('them', 'John', greeting())
    var note = document.createElement('div')
    note.className = 'note'
    note.innerHTML =
      'I read every message, but I might be under a house or asleep. If it can\'t wait, <a href="tel:' +
      PHONE.replace(/-/g, '') + '">call ' + PHONE + '</a>. No answer? Call again. And again. The phone wakes me up and I\'ll come help. ' +
      'Smell gas or hear a CO alarm? Get outside and call 911 or PG&amp;E first.'
    list.appendChild(note)
    state.messages.forEach(function (m) {
      if (m.from === 'customer') addRow('me', '', m.text)
      else if (m.from === 'john') addRow('them', 'John', m.text)
      else addRow('them', 'John\'s assistant (bot)', m.text)
    })
    list.scrollTop = list.scrollHeight
    badge.textContent = state.unread
    badge.style.display = state.unread && !open ? 'block' : 'none'
    $('.dot').classList.toggle('away', status === 'away')
    $('.status').textContent = status === 'away' ? 'After hours, bot will help' : 'Usually replies in minutes'
  }

  function greeting() {
    return 'Hey, this is John with Silicon Valley Comfort. You\'re texting the actual guy with the gauges, not a call center. What\'s your system doing?'
  }

  function addRow(kind, who, text) {
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
    msg.textContent = text
    row.appendChild(msg)
    list.appendChild(row)
  }

  // ---------- network ----------
  function api(path, options) {
    return fetch(API + path, options).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) {
          var err = new Error(body.error || 'Request failed')
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
      state.id = res.id
      state.last = 0
      state.messages = []
      status = res.status || 'online'
      save()
      return res.id
    })
  }

  function send() {
    var text = input.value.trim()
    if (!text || sending) return
    sending = true
    sendBtn.disabled = true
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
        return poll()
      })
      .catch(function (err) {
        if (err.status === 404) {
          // Chat expired on the server. Start fresh next time.
          state = { id: null, last: 0, messages: [], unread: 0 }
          save()
        }
        addRow('them', '', err.status === 429 ? err.message : 'That didn\'t send. Try again, or call ' + PHONE + '.')
        list.scrollTop = list.scrollHeight
      })
      .then(function () {
        sending = false
        sendBtn.disabled = false
        schedulePoll()
      })
  }

  function poll() {
    if (!state.id) return Promise.resolve()
    return api('/api/chats/' + state.id + '?after=' + state.last)
      .then(function (res) {
        typing.style.display = res.typing ? 'block' : 'none'
        if (!res.messages.length) return
        res.messages.forEach(function (m) {
          state.messages.push({ from: m.from, text: m.text })
          state.last = Math.max(state.last, m.n)
          if (m.from !== 'customer' && !open) state.unread++
        })
        save()
        render()
      })
      .catch(function (err) {
        if (err.status === 404) {
          state = { id: null, last: 0, messages: [], unread: 0 }
          save()
          render()
        }
      })
  }

  function schedulePoll() {
    clearTimeout(pollTimer)
    if (!state.id || document.hidden) return
    var delay = open ? 3000 : 20000
    pollTimer = setTimeout(function () { poll().then(schedulePoll) }, delay)
  }

  // ---------- icons ----------
  function svgChat() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
  }
  function svgClose() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'
  }
  function svgSend() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/></svg>'
  }
  function svgPhone() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>'
  }
})()
