/* Holy · rastreamento do site (com consentimento, LGPD)
   - Guarda a origem da visita (utm_*, gclid do Google Ads, fbclid da Meta)
   - Com "Aceitar": cria um id anônimo do visitante e registra quais imóveis/empreendimentos ele viu
   - Carrega Google Analytics 4 / Google Ads / Meta Pixel (IDs configurados no CRM) e marca conversões
   Uso no site: holyTrack('ver', {kind, id, nome}) · holyConv('lead'|'whatsapp') · holyCtx() */
(function () {
  var LS = window.localStorage, SS = window.sessionStorage;
  function lg(k) { try { return LS.getItem(k); } catch (e) { return null; } }
  function ls(k, v) { try { LS.setItem(k, v); } catch (e) { } }
  var q = new URLSearchParams(location.search), utm = {};
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'gbraid', 'wbraid', 'fbclid'].forEach(function (k) { if (q.get(k)) utm[k] = q.get(k).slice(0, 120); });
  if (!utm.utm_source && document.referrer && !/holyimoveis\.com|vercel\.app/.test(document.referrer)) { try { utm.ref = new URL(document.referrer).hostname; } catch (e) { } }
  if (Object.keys(utm).length) { utm.em = new Date().toISOString(); try { SS.setItem('hutm', JSON.stringify(utm)); } catch (e) { } if (!lg('hutm1')) ls('hutm1', JSON.stringify(utm)); }
  var hl = q.get('hl'); if (hl) try { SS.setItem('hhl', hl); } catch (e) { }
  function utmAtual() { try { return JSON.parse(SS.getItem('hutm') || lg('hutm1') || 'null'); } catch (e) { return null; } }
  var consent = lg('hcons');
  function vid() { if (consent !== 'sim') return null; var v = lg('hvid'); if (!v) { v = 'v' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); ls('hvid', v); } return v; }
  function envia(d) {
    var b = JSON.stringify(d);
    try { if (navigator.sendBeacon && navigator.sendBeacon('/api/leads', new Blob([b], { type: 'application/json' }))) return; } catch (e) { }
    fetch('/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b, keepalive: true }).catch(function () { });
  }
  var vistos = {};
  window.holyTrack = function (evento, d) {
    var v = vid(); if (!v) return; d = d || {};
    var chave = evento + ':' + (d.id || location.pathname); if (vistos[chave]) return; vistos[chave] = 1;
    var hhl = null; try { hhl = SS.getItem('hhl'); } catch (e) { }
    envia({ tipo: 'evento', visitante: v, evento: evento, kind: d.kind || '', item_id: d.id || '', item_nome: d.nome || '', pagina: location.pathname + location.hash, utm: utmAtual(), hl: hhl });
  };
  window.holyCtx = function () { return { visitante: vid(), utm: utmAtual() }; };
  // ── Google / Meta ──
  var cfg = null;
  function carregaTags() {
    if (!cfg || consent !== 'sim' || window._holyTags) return; window._holyTags = 1;
    var gid = cfg.ga4 || cfg.ads;
    if (gid) {
      var s = document.createElement('script'); s.async = 1; s.src = 'https://www.googletagmanager.com/gtag/js?id=' + gid; document.head.appendChild(s);
      window.dataLayer = window.dataLayer || []; window.gtag = function () { dataLayer.push(arguments); };
      gtag('js', new Date()); if (cfg.ga4) gtag('config', cfg.ga4); if (cfg.ads) gtag('config', cfg.ads);
    }
    if (cfg.pixel) {
      !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
      fbq('init', cfg.pixel); fbq('track', 'PageView');
    }
  }
  window.holyConv = function (tipo) {
    try {
      if (window.gtag) {
        gtag('event', tipo === 'lead' ? 'generate_lead' : 'contact', { method: tipo });
        var lab = cfg && cfg.ads && (tipo === 'lead' ? cfg.adsLead : cfg.adsWhats);
        if (lab) gtag('event', 'conversion', { send_to: cfg.ads + '/' + lab });
      }
      if (window.fbq) fbq('track', tipo === 'lead' ? 'Lead' : 'Contact');
    } catch (e) { }
  };
  fetch('/api/site').then(function (r) { return r.json(); }).then(function (d) { cfg = (d && d.rastreamento) || {}; carregaTags(); }).catch(function () { });
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href*="wa.me/"],[data-holy-conv]');
    if (a) window.holyConv(a.getAttribute('data-holy-conv') || 'whatsapp');
  }, true);
  // ── Aviso de cookies ──
  function banner() {
    if (consent) return;
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;max-width:560px;margin:0 auto;background:#1a1c18;color:#f5f3ee;border-radius:12px;padding:14px 16px;font:13px/1.5 Inter,Arial,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.35);display:flex;gap:12px;align-items:center;flex-wrap:wrap';
    d.innerHTML = '<div style="flex:1;min-width:220px">Usamos cookies para entender quais imóveis interessam a você e mostrar opções melhores. <a href="/privacidade.html" style="color:#d4b86a">Saiba mais</a></div>' +
      '<button data-c="nao" style="background:none;border:1px solid #7a7d72;color:#f5f3ee;border-radius:6px;padding:8px 12px;cursor:pointer">Recusar</button>' +
      '<button data-c="sim" style="background:#b8993a;border:none;color:#1a1c18;font-weight:600;border-radius:6px;padding:8px 14px;cursor:pointer">Aceitar</button>';
    d.addEventListener('click', function (e) {
      var c = e.target.getAttribute && e.target.getAttribute('data-c'); if (!c) return;
      consent = c; ls('hcons', c); d.remove();
      if (c === 'sim') { carregaTags(); if (window.HOLY_ITEM) window.holyTrack('ver', window.HOLY_ITEM); else window.holyTrack('visita', {}); }
    });
    (document.body ? Promise.resolve() : new Promise(function (r) { document.addEventListener('DOMContentLoaded', r); })).then(function () { document.body.appendChild(d); });
  }
  banner();
  function inicio() { if (window.HOLY_ITEM) window.holyTrack('ver', window.HOLY_ITEM); else window.holyTrack('visita', {}); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inicio); else inicio();
})();
