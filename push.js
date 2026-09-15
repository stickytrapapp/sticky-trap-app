/* The Sticky Trap - order-update PUSH notifications (2026-09-15, replaces Twilio texts).
   Firebase Cloud Messaging, project sticky-trap-fe078. Public config in /data/firebase.json; the secret sender key lives only
   in Chat.gs script properties. This file: permission + token on the phone, then tells the order desk which order/email the
   token belongs to (action push_sub). The service worker (/sw.js) shows the notification when one arrives.
   Usage:  STPush.state().then(function(s){...})   -> 'on' | 'off' | 'denied' | 'install' | 'unsupported'
           STPush.enable({code, order_token, email}) -> Promise<'on'|'denied'|...>
           STPush.disable() -> Promise
   iPhone: works only once the app is added to the Home Screen (iOS 16.4+), so 'install' means "add to Home Screen first". */
(function () {
  var API = 'https://script.google.com/macros/s/AKfycbzgctrnkyWjVnhzioE_B4x8J2pyi4WzRSJG2e00Y_Y5cz0vQx-q5jhvOhMWg2x-K9ciFw/exec';   // Chat.gs (orders/tracker)
  var SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';
  var cfg = null, msgP = null, KEY = 'st_push';

  function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
  function standalone() { return window.matchMedia && window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
  function supported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  function saved() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function save(v) { try { if (v) localStorage.setItem(KEY, JSON.stringify(v)); else localStorage.removeItem(KEY); } catch (e) {} }

  function script(src) { return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = function () { rej(new Error('sdk')); }; document.head.appendChild(s); }); }
  function config() { return cfg ? Promise.resolve(cfg) : fetch('/data/firebase.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) { cfg = j; return j; }); }
  function messaging() {
    if (msgP) return msgP;
    msgP = config().then(function (c) {
      return (window.firebase ? Promise.resolve() : script(SDK + 'firebase-app-compat.js').then(function () { return script(SDK + 'firebase-messaging-compat.js'); }))
        .then(function () { if (!firebase.apps.length) firebase.initializeApp(c); return firebase.messaging(); });
    });
    return msgP;
  }
  function reg() { return navigator.serviceWorker.getRegistration('/').then(function (r) { return r || navigator.serviceWorker.register('/sw.js'); }).then(function (r) { return navigator.serviceWorker.ready.then(function () { return r; }); }); }
  function post(body) { return fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); }); }

  function state() {
    if (!supported()) return Promise.resolve(isIOS() && !standalone() ? 'install' : 'unsupported');
    if (Notification.permission === 'denied') return Promise.resolve('denied');
    var s = saved(); return Promise.resolve(s && s.token && Notification.permission === 'granted' ? 'on' : 'off');
  }
  function enable(link) {   // link = { code, order_token, email }  (any of them; the desk matches pushes to orders by code first, then email)
    link = link || {};
    return state().then(function (s) {
      if (s === 'install' || s === 'unsupported' || s === 'denied') return s;
      return Notification.requestPermission().then(function (p) {
        if (p !== 'granted') return 'denied';
        return Promise.all([messaging(), reg(), config()]).then(function (a) {
          var m = a[0], r = a[1], c = a[2];
          return m.getToken({ vapidKey: c.vapidKey, serviceWorkerRegistration: r });
        }).then(function (tok) {
          if (!tok) throw new Error('no_token');
          return post({ action: 'push_sub', token: tok, code: link.code || '', order_token: link.order_token || '', email: link.email || '', ua: navigator.userAgent.slice(0, 120), standalone: standalone() })
            .then(function (j) { if (!(j && j.ok)) throw new Error((j && j.error) || 'sub_failed'); save({ token: tok, ts: Date.now(), code: link.code || '', email: link.email || '' }); return 'on'; });
        });
      });
    });
  }
  function disable() {
    var s = saved(); save(null);
    if (!s || !s.token) return Promise.resolve('off');
    return post({ action: 'push_unsub', token: s.token }).catch(function () {}).then(function () { return messaging().then(function (m) { return m.deleteToken(); }).catch(function () {}); }).then(function () { return 'off'; });
  }
  function attach(link) {   // an existing token on this phone gets linked to another order (e.g. the customer opens a second tracker page)
    var s = saved(); if (!s || !s.token || !link || !link.code) return Promise.resolve(false);
    return post({ action: 'push_sub', token: s.token, code: link.code, order_token: link.order_token || '', email: link.email || s.email || '', ua: navigator.userAgent.slice(0, 120), standalone: standalone() }).then(function (j) { return !!(j && j.ok); }).catch(function () { return false; });
  }
  window.STPush = { state: state, enable: enable, disable: disable, attach: attach, supported: supported, isIOS: isIOS, standalone: standalone };
})();
