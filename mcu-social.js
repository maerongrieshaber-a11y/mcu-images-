/* MCU Timeline - module social (comptes, amis, progression synchronisee) - v5 2026-11-04 (RGPD : donnees minimales, export et suppression de compte)
   La configuration Supabase (URL + cle publique) reste dans le bloc de code Odoo : window.MCU_SOCIAL_CONFIG */
(function(){
  var CFG = window.MCU_SOCIAL_CONFIG || {};
  var SUPABASE_URL = CFG.url || '', SUPABASE_ANON_KEY = CFG.key || '';

  var CONFIGURED = !!SUPABASE_URL && !!SUPABASE_ANON_KEY && SUPABASE_URL.indexOf('VOTRE-PROJET') === -1 && SUPABASE_ANON_KEY.indexOf('VOTRE_') === -1;
  var SB_LIB = 'https://maerongrieshaber-a11y.github.io/mcu-images-/vendor/supabase-2.45.4.min.js';   // auto-hebergee : aucun appel a un CDN tiers

  var sb = null, me = null, myProfile = null;
  var community = {};                 // item_id -> {avg, votes, viewers}
  var friends = [];                   // [{id, username, display_name, avatar_url, friendship_id}]
  var incoming = [], outgoing = [];   // demandes en attente
  var friendData = {};                // item_id -> [{name, rating, watched}]
  var synced = { watched:{}, ratings:{} }; // ce que le serveur connait deja
  var syncing = false, pushTimer = null;
  var panelTab = 'feed', panelMsg = '';

  function MCU(){ return window.MCU || null; }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function titleOf(id){ var m = MCU(); var it = m && m.itemById(id); return it ? (it.title || it.name || id) : id; }
  function nameOf(p){ return p.display_name || p.username; }
  function avatarHtml(p){
    var u = p && p.avatar_url;
    if (safeImg(u)) return '<div class="mcs-av"><img src="'+esc(u)+'" alt=""></div>';
    return '<div class="mcs-av">'+esc((nameOf(p||{username:'?'})||'?').charAt(0).toUpperCase())+'</div>';
  }
  function safeImg(u){ return !!u && (/^https:\/\//.test(u) || /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(u)); }
  function miniAv(p){ return '<span class="mcs-mini">'+(safeImg(p.av) ? '<img src="'+esc(p.av)+'" alt="">' : esc((p.name||'?').charAt(0).toUpperCase()))+'</span>'; }
  function stars(r){ return r ? '★ '+(r % 1 ? r.toFixed(1) : r) : ''; }
  function ago(d){
    var s = (Date.now() - new Date(d).getTime())/1000;
    if (s < 3600) return 'il y a '+Math.max(1, Math.round(s/60))+' min';
    if (s < 86400) return 'il y a '+Math.round(s/3600)+' h';
    return 'il y a '+Math.round(s/86400)+' j';
  }

  /* ---------------- chargement de la librairie ---------------- */
  function loadLib(cb){
    if (window.supabase && window.supabase.createClient) return cb();
    var s = document.createElement('script'); s.src = SB_LIB; s.async = true;
    s.onload = cb; s.onerror = function(){ console.warn('[mcu-social] librairie Supabase introuvable'); };
    document.head.appendChild(s);
  }

  /* ---------------- note collective (visible par tous) ---------------- */
  function loadCommunity(){
    return sb.rpc('community_ratings').then(function(res){
      if (res.error) { console.warn('[mcu-social]', res.error.message); return; }
      community = {};
      (res.data || []).forEach(function(r){ community[r.item_id] = { avg: r.avg_rating ? Number(r.avg_rating) : null, votes: Number(r.votes), viewers: Number(r.viewers) }; });
      decorateModal(true);
    });
  }

  /* ---------------- amis ---------------- */
  function loadFriends(){
    if (!me) return Promise.resolve();
    return sb.from('friendships').select('id,requester,addressee,status').then(function(res){
      if (res.error) throw res.error;
      var rows = res.data || [], ids = {};
      rows.forEach(function(f){ ids[f.requester] = 1; ids[f.addressee] = 1; });
      var list = Object.keys(ids);
      return sb.from('profiles').select('id,username,display_name,avatar_url').in('id', list.length ? list : ['00000000-0000-0000-0000-000000000000']).then(function(pr){
        var map = {}; (pr.data || []).forEach(function(p){ map[p.id] = p; });
        myProfile = map[me.id] || myProfile;
        friends = []; incoming = []; outgoing = [];
        rows.forEach(function(f){
          var otherId = f.requester === me.id ? f.addressee : f.requester;
          var p = Object.assign({ friendship_id: f.id }, map[otherId] || { id: otherId, username: '?' });
          if (f.status === 'accepted') friends.push(p);
          else if (f.addressee === me.id) incoming.push(p);
          else outgoing.push(p);
        });
        updateNavBadge();
        return loadFriendData();
      });
    });
  }
  function loadFriendData(){
    friendData = {};
    if (!friends.length) { decorateModal(true); return Promise.resolve(); }
    var ids = friends.map(function(f){ return f.id; }), byId = {};
    friends.forEach(function(f){ byId[f.id] = f; });
    return Promise.all([
      sb.from('watches').select('user_id,item_id').in('user_id', ids).limit(10000),
      sb.from('ratings').select('user_id,item_id,rating').in('user_id', ids).limit(10000)
    ]).then(function(r){
      var tmp = {};
      function slot(u, i){ var k = u+'|'+i; if (!tmp[k]) { tmp[k] = { item:i, uid:u, name:nameOf(byId[u]||{username:'?'}), av:(byId[u]||{}).avatar_url, rating:null, watched:false }; } return tmp[k]; }
      (r[0].data || []).forEach(function(w){ slot(w.user_id, w.item_id).watched = true; });
      (r[1].data || []).forEach(function(x){ slot(x.user_id, x.item_id).rating = Number(x.rating); });
      Object.keys(tmp).forEach(function(k){ var e = tmp[k]; (friendData[e.item] = friendData[e.item] || []).push(e); });
      decorateModal(true);
    });
  }

  /* ---------------- synchronisation de TES vus / notes ---------------- */
  /* ---- progression complete : le compte est la reference, partagee entre tous tes appareils ---- */
  var LOCAL_ONLY = ['soundOn','musicOn','musicVol','voiceOn','tourSeen','onboardingSeen'];
  var META_KEY = 'mcu_sync_meta_v1', applying = false, syncReady = false, progTimer = null;
  function meta(){ try { return JSON.parse(localStorage.getItem(META_KEY)) || {}; } catch(e){ return {}; } }
  function setMeta(m){ try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch(e){} }
  function syncable(st){ var o = {}; Object.keys(st || {}).forEach(function(k){ if (LOCAL_ONLY.indexOf(k) === -1) o[k] = st[k]; }); return JSON.parse(JSON.stringify(o)); }
  function applyServerState(srv){
    var m = MCU(); if (!m || !m.replaceState || !srv) return;
    var cur = m.state || {}, merged = JSON.parse(JSON.stringify(srv));
    LOCAL_ONLY.forEach(function(k){ if (cur[k] !== undefined) merged[k] = cur[k]; });
    applying = true; try { m.replaceState(merged); } finally { applying = false; }
  }
  function pushProgress(){
    var m = MCU(); if (!m || !me) return Promise.resolve();
    return sb.from('user_progress').upsert({ user_id: me.id, state: syncable(m.state) }, { onConflict: 'user_id' }).select('updated_at').single().then(function(r){
      if (r.error) { console.warn('[mcu-social] progression', r.error.message); return; }
      setMeta({ uid: me.id, at: r.data.updated_at, dirty: false }); return 'up';
    });
  }
  // mode : 'up' = cet appareil devient la reference, 'down' = on recupere le compte, sinon automatique
  function pullOrPush(mode){
    var m = MCU(); if (!m || !me) return Promise.resolve();
    return sb.from('user_progress').select('state,updated_at').eq('user_id', me.id).maybeSingle().then(function(r){
      if (r.error) { console.warn('[mcu-social] progression', r.error.message); return; }
      var row = r.data, mt = meta(), same = mt.uid === me.id;
      if (mode === 'up' || (!row && mode !== 'down')) return pushProgress();
      if (!row) return;
      var newer = !same || !mt.at || new Date(row.updated_at) > new Date(mt.at);
      if (mode === 'down' || (newer && !(same && mt.dirty))) { applyServerState(row.state); setMeta({ uid: me.id, at: row.updated_at, dirty: false }); return 'down'; }
      if (same && mt.dirty) return pushProgress();
    });
  }
  function onLocalSave(){
    if (applying || !me || !syncReady) return;
    var mt = meta(); mt.uid = me.id; mt.dirty = true; setMeta(mt);
    clearTimeout(progTimer); progTimer = setTimeout(pushProgress, 1500);
  }
  function loadTables(){
    return Promise.all([
      sb.from('watches').select('item_id').eq('user_id', me.id).limit(10000),
      sb.from('ratings').select('item_id,rating').eq('user_id', me.id).limit(10000)
    ]).then(function(r){
      var rw = {}, rr = {};
      (r[0].data || []).forEach(function(x){ rw[x.item_id] = true; });
      (r[1].data || []).forEach(function(x){ rr[x.item_id] = Number(x.rating); });
      synced = { watched: rw, ratings: rr };
    });
  }
  function initialSync(){
    var m = MCU(); if (!m || !me) return Promise.resolve();
    syncReady = false;
    return pullOrPush().then(function(res){
      if (res === 'down') miniToast('Progression de ton compte chargée sur cet appareil');
      return loadTables();
    }).then(function(){ syncReady = true; return pushDiff(); })
      .catch(function(e){ syncReady = true; console.warn('[mcu-social] sync', e); });
  }
  function miniToast(t){
    var d = document.createElement('div'); d.className = 'mcs-toast'; d.textContent = t; document.body.appendChild(d);
    setTimeout(function(){ d.classList.add('out'); setTimeout(function(){ d.remove(); }, 500); }, 3200);
  }
  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState === 'visible' && me && syncReady) { pullOrPush().then(function(res){ if (res === 'down') { miniToast('Progression mise à jour depuis ton autre appareil'); return loadTables(); } }); }
  });
  function schedulePush(){ if (!me || !syncReady) return; clearTimeout(pushTimer); pushTimer = setTimeout(pushDiff, 800); }
  function pushDiff(){
    var m = MCU(); if (!m || !me) return Promise.resolve();
    var st = m.state, ops = [];
    var addW = [], delW = [], upR = [], delR = [];
    Object.keys(st.watched || {}).forEach(function(id){ if (st.watched[id] && !synced.watched[id]) addW.push(id); });
    Object.keys(synced.watched).forEach(function(id){ if (!st.watched[id]) delW.push(id); });
    Object.keys(st.ratings || {}).forEach(function(id){ var v = Number(st.ratings[id]); if (v >= 0.5 && v <= 5 && synced.ratings[id] !== v) upR.push({ user_id: me.id, item_id: id, rating: v, updated_at: new Date().toISOString() }); });
    Object.keys(synced.ratings).forEach(function(id){ if (st.ratings[id] == null) delR.push(id); });
    if (addW.length) ops.push(sb.from('watches').upsert(addW.map(function(id){ return { user_id: me.id, item_id: id }; }), { onConflict: 'user_id,item_id', ignoreDuplicates: true }).then(function(r){ if (!r.error) addW.forEach(function(id){ synced.watched[id] = true; }); return r; }));
    if (delW.length) ops.push(sb.from('watches').delete().eq('user_id', me.id).in('item_id', delW).then(function(r){ if (!r.error) delW.forEach(function(id){ delete synced.watched[id]; }); return r; }));
    if (upR.length)  ops.push(sb.from('ratings').upsert(upR, { onConflict: 'user_id,item_id' }).then(function(r){ if (!r.error) upR.forEach(function(x){ synced.ratings[x.item_id] = x.rating; }); return r; }));
    if (delR.length) ops.push(sb.from('ratings').delete().eq('user_id', me.id).in('item_id', delR).then(function(r){ if (!r.error) delR.forEach(function(id){ delete synced.ratings[id]; }); return r; }));
    if (!ops.length) return Promise.resolve();
    return Promise.all(ops).then(function(res){
      res.forEach(function(r){ if (r && r.error) console.warn('[mcu-social] push', r.error.message); });
      return loadCommunity();
    });
  }

  /* ---------------- bouton "Amis" dans la barre de navigation ---------------- */
  function injectNavButton(){
    var tabs = document.querySelector('#mcu-nav-root .navtabs');
    if (!tabs || tabs.querySelector('.mcs-navbtn')) return;
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'mcs-navbtn'; b.textContent = '👥 Amis';
    b.onclick = function(){ openPanel(incoming.length ? 'friends' : 'feed'); };
    var prof = tabs.querySelector('.mcu-nav-profile');
    tabs.insertBefore(b, prof || null);
    updateNavBadge();
  }
  function updateNavBadge(){
    var b = document.querySelector('#mcu-nav-root .mcs-navbtn'); if (!b) return;
    var d = b.querySelector('.mcs-dot');
    if (incoming.length) { if (!d) { d = document.createElement('span'); d.className = 'mcs-dot'; b.appendChild(d); } d.textContent = incoming.length; }
    else if (d) d.remove();
  }

  /* ---------------- fiche d'un film : note communaute (rouge), amis qui ont vu, notes des amis ---------------- */
  function decorateModal(force){
    var m = MCU(); var id = m && m.currentItemId;
    var box = document.querySelector('#mcu-modal-root .modal-box');
    if (!box || !id) return;
    if (!force && box.getAttribute('data-mcs') === id) return;
    box.setAttribute('data-mcs', id);
    Array.prototype.forEach.call(box.querySelectorAll('.mcs-comm,.mcs-fr'), function(n){ n.remove(); });
    var c = community[id], fr = friendData[id] || [];
    // 1. note de la communaute, en rouge, a cote de la note officielle
    var official = Array.prototype.filter.call(box.querySelectorAll('span'), function(s){ return /^★\s*[\d.,]+$/.test(s.textContent.trim()) && /232,\s*196,\s*104|E8C468/i.test(s.getAttribute('style')||''); })[0];
    if (c && c.avg) {
      var sp = document.createElement('span'); sp.className = 'mcs-comm';
      sp.textContent = '★ ' + (c.avg * 2).toFixed(1);
      sp.title = 'Note de la communauté : ' + c.avg.toFixed(1) + '/5 (' + c.votes + ' vote' + (c.votes > 1 ? 's' : '') + '), ramenée sur 10 pour la comparer à la note officielle';
      if (official) official.parentNode.insertBefore(sp, official.nextSibling);
    }
    // 2. avatar(s) des amis qui ont vu, a cote du bouton Vu
    var seen = fr.filter(function(f){ return f.watched; });
    var watchBtn = box.querySelector('button[onclick^="mcuToggleWatched"]');
    if (seen.length && watchBtn) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'mcs-fr';
      b.title = seen.length === 1 ? seen[0].name + ' l\'a vu' : seen.length + ' amis l\'ont vu';
      b.innerHTML = seen.slice(0, 3).map(miniAv).join('') + (seen.length > 1 ? '<span class="mcs-count">' + seen.length + '</span>' : '');
      b.onclick = function(e){ e.stopPropagation(); showPop('Amis qui ont vu', seen, false); };
      watchBtn.parentNode.insertBefore(b, watchBtn.nextSibling);
    }
    // 3. petite icone a cote de MA note : ouvre les notes de mes amis
    var rated = fr.filter(function(f){ return f.rating; });
    var rateBtn = box.querySelector('button[onclick^="mcuRate"]');
    if (rated.length && rateBtn) {
      var r = document.createElement('button'); r.type = 'button'; r.className = 'mcs-fr';
      r.title = 'Notes de tes amis';
      r.innerHTML = '<span class="mcs-mini" style="font-size:13px">👥</span><span class="mcs-count">' + rated.length + '</span>';
      r.onclick = function(e){ e.stopPropagation(); showPop('Notes de tes amis', rated, true); };
      rateBtn.parentNode.appendChild(r);
    }
  }
  function showPop(title, list, withRating){
    closePop();
    var o = document.createElement('div'); o.id = 'mcs-pop';
    o.onclick = function(e){ if (e.target === o) closePop(); };
    o.innerHTML = '<div class="mcs-pbox"><h3>' + esc(title) + '</h3>' + list.map(function(f){
      return '<div class="mcs-prow" data-uid="' + esc(f.uid) + '">' + (safeImg(f.av) ? '<div class="mcs-av"><img src="' + esc(f.av) + '" alt=""></div>' : '<div class="mcs-av">' + esc((f.name || '?').charAt(0).toUpperCase()) + '</div>')
        + '<div style="flex:1"><strong>' + esc(f.name) + '</strong></div>'
        + (f.rating ? '<span style="color:#E8C468;font-weight:700">' + stars(f.rating) + '</span>' : '<span style="color:#9AA0AA;font-size:12px">✓ vu</span>') + '</div>';
    }).join('') + '<div style="color:#9AA0AA;font-size:12px;margin-top:8px">Touche un ami pour voir son profil.</div></div>';
    o.addEventListener('click', function(e){ var row = e.target.closest('.mcs-prow'); if (row) { closePop(); openFriendProfile(row.getAttribute('data-uid')); } });
    document.body.appendChild(o);
  }
  function closePop(){ var o = document.getElementById('mcs-pop'); if (o) o.remove(); }

  /* ---------------- profil : ton profil du site = ton profil ami ---------------- */
  var profTimer = null, lastProfSig = '';
  function scheduleProfilePush(){ if (!me) return; clearTimeout(profTimer); profTimer = setTimeout(pushProfile, 1500); }
  function pushProfile(){
    var m = MCU(); if (!m || !me || !m.profilePayload) return Promise.resolve();
    var p = m.profilePayload(), st = m.state.profile || {};
    var av = safeImg(st.avatar) ? st.avatar : null;
    var vals = { display_name: (st.name || '').trim() || (myProfile && myProfile.username) || null, avatar_url: av, profile_data: p };
    var sig = JSON.stringify(vals); if (sig === lastProfSig) return Promise.resolve();
    return sb.from('profiles').update(vals).eq('id', me.id).select().single().then(function(r){
      if (r.error) { console.warn('[mcu-social] profil', r.error.message); return; }
      lastProfSig = sig; myProfile = r.data;
    });
  }
  function openFriendProfile(uid){
    if (!uid) return;
    sb.from('profiles').select('id,username,display_name,avatar_url,profile_data').eq('id', uid).single().then(function(r){
      if (r.error || !r.data) return;
      var d = r.data, p = Object.assign({ n: nameOf(d), lvl: 1, lvlName: '', xp: 0, ach: 0, achTotal: 0, top: [] }, d.profile_data || {});
      p.n = nameOf(d); p.a = safeImg(d.avatar_url) ? d.avatar_url : '';
      closePanel(); closePop();
      MCU().showProfile(p);
      setTimeout(function(){ friendProfileExtras(d); }, 50);
    });
  }
  function friendProfileExtras(d){
    var root = document.getElementById('mcu-view-root'); if (!root) return;
    var label = Array.prototype.filter.call(root.querySelectorAll('.mono'), function(n){ return /PROFIL PARTAG/i.test(n.textContent); })[0];
    if (label) label.textContent = 'PROFIL DE TON AMI · @' + d.username;
    var list = []; Object.keys(friendData).forEach(function(item){ friendData[item].forEach(function(e){ if (e.uid === d.id) list.push(e); }); });
    var mine = MCU().state.watched || {}, seen = list.filter(function(e){ return e.watched; });
    var common = seen.filter(function(e){ return mine[e.item]; }).length;
    var h1 = root.querySelector('.mcu-profile-hero h1'); if (!h1) return;
    var s = document.createElement('div'); s.className = 'mcs-friend-stats';
    s.innerHTML = '<strong style="color:#E8C468">' + seen.length + '</strong> contenu' + (seen.length > 1 ? 's' : '') + ' vu' + (seen.length > 1 ? 's' : '') + ' · <strong style="color:#E8C468">' + common + '</strong> en commun avec toi';
    h1.parentNode.insertBefore(s, h1.nextSibling);
  }

  /* ---------------- panneau Amis ---------------- */
  function openPanel(tab){ panelTab = tab || panelTab; panelMsg = ''; renderPanel(); }
  function closePanel(){ var o = document.getElementById('mcs-overlay'); if (o) o.remove(); }
  function setMsg(t){ panelMsg = t; renderPanel(); }
  function renderPanel(){
    var o = document.getElementById('mcs-overlay');
    if (!o) { o = document.createElement('div'); o.id = 'mcs-overlay'; o.onclick = function(e){ if (e.target === o) closePanel(); }; document.body.appendChild(o); }
    var h = '<div class="mcs-box"><button class="mcs-close" data-a="close" aria-label="Fermer">✕</button>';
    if (!CONFIGURED) {
      h += '<h2>Espace <span class="gold">amis</span></h2><div class="mcs-msg">Le module n\'est pas encore configuré (SUPABASE_URL / SUPABASE_ANON_KEY).</div>';
    } else if (!me) {
      h += renderAuth();
    } else {
      h += '<h2>Salut <span class="gold">'+esc(myProfile ? nameOf(myProfile) : '')+'</span></h2>';
      h += '<div class="mcs-tabs">'
        + [['feed','Fil d\'actu'],['rank','🏆 Classement'],['friends','Mes amis'+(incoming.length?' · '+incoming.length+' demande'+(incoming.length>1?'s':''):'')],['add','Ajouter'],['account','Mon compte']].map(function(t){ return '<button data-a="tab" data-v="'+t[0]+'" class="'+(panelTab===t[0]?'on':'')+'">'+t[1]+'</button>'; }).join('')
        + '</div>';
      if (panelMsg) h += '<div class="mcs-msg">'+panelMsg+'</div>';
      h += '<div id="mcs-body">'+(panelTab==='feed' ? '<div class="mcs-muted">Chargement…</div>' : panelTab==='friends' ? renderFriends() : panelTab==='add' ? renderAdd() : (panelTab==='friend' || panelTab==='compare' || panelTab==='rank') ? '<div class="mcs-muted">Chargement…</div>' : renderAccount())+'</div>';
    }
    o.innerHTML = h + '</div>';
    if (me && panelTab === 'feed') renderFeed();
    if (me && panelTab === 'friend') renderFriendProfile();
    if (me && panelTab === 'compare') renderCompare();
    if (me && panelTab === 'rank') renderRanking();
  }
  function renderAuth(){
    return '<h2>Rejoins la <span class="gold">communauté</span></h2>'
      + '<p class="mcs-muted">Crée un compte pour sauvegarder ta progression sur tous tes appareils, ajouter tes amis et voir ce qu\'ils regardent.</p>'
      + (panelMsg ? '<div class="mcs-msg">'+panelMsg+'</div>' : '')
      + '<label for="mcs-email">E-mail</label><input id="mcs-email" type="email" autocomplete="email">'
      + '<label for="mcs-pass">Mot de passe (8 caractères min.)</label><input id="mcs-pass" type="password" autocomplete="current-password">'
      + '<label for="mcs-user">Pseudo (seulement pour l\'inscription : 3-24 lettres, chiffres, . _ -)</label><input id="mcs-user" type="text" autocomplete="nickname">'
      + '<div class="mcs-consent"><label class="mcs-check"><input id="mcs-cgu" type="checkbox"> <span>Pour créer un compte : j\'accepte les <a href="/conditions-utilisation" target="_blank" rel="noopener">conditions d\'utilisation</a> et j\'ai lu la <a href="/confidentialite" target="_blank" rel="noopener">politique de confidentialité</a>.</span></label>'
      + '<label class="mcs-check"><input id="mcs-age" type="checkbox"> <span>J\'ai 15 ans ou plus, ou un parent est d\'accord pour que je crée ce compte.</span></label></div>'
      + '<p class="mcs-muted" style="margin:0 4px 12px">Le compte est facultatif : tout le site fonctionne sans. Il sert seulement à retrouver ta progression sur plusieurs appareils et à jouer avec tes amis.</p>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="mcs-btn pri" data-a="login">Se connecter</button><button class="mcs-btn" data-a="signup">Créer un compte</button><button class="mcs-link" data-a="reset">Mot de passe oublié ?</button></div>';
  }
  function renderFriends(){
    var h = '';
    if (incoming.length) {
      h += '<h3 style="margin:4px 0">Demandes reçues</h3>';
      incoming.forEach(function(p){ h += '<div class="mcs-row">'+avatarHtml(p)+'<div style="flex:1"><strong>'+esc(nameOf(p))+'</strong> <span class="mcs-muted">@'+esc(p.username)+'</span></div><button class="mcs-btn pri" data-a="accept" data-v="'+p.friendship_id+'">Accepter</button><button class="mcs-btn danger" data-a="remove" data-v="'+p.friendship_id+'">Refuser</button></div>'; });
    }
    h += '<h3 style="margin:14px 0 4px">Mes amis ('+friends.length+')</h3>';
    if (!friends.length) h += '<div class="mcs-muted">Pas encore d\'amis. Va dans l\'onglet « Ajouter ».</div>';
    friends.forEach(function(p){ h += '<div class="mcs-row">'+avatarHtml(p)+'<div style="flex:1"><button class="mcs-link" data-a="seefriend" data-v="'+p.id+'">'+esc(nameOf(p))+'</button> <span class="mcs-muted">@'+esc(p.username)+'</span></div><button class="mcs-btn pri" data-a="compare" data-v="'+p.id+'">⚔️ Comparer</button><button class="mcs-btn danger" data-a="remove" data-v="'+p.friendship_id+'">Retirer</button></div>'; });
    if (outgoing.length) {
      h += '<h3 style="margin:14px 0 4px">Demandes envoyées</h3>';
      outgoing.forEach(function(p){ h += '<div class="mcs-row">'+avatarHtml(p)+'<div style="flex:1">'+esc(nameOf(p))+' <span class="mcs-muted">en attente</span></div><button class="mcs-btn" data-a="remove" data-v="'+p.friendship_id+'">Annuler</button></div>'; });
    }
    return h;
  }
  function renderAdd(){
    return '<div class="mcs-invite"><strong>Invite tes amis en un clic</strong><p class="mcs-muted">Envoie ton lien : quand ton ami l\'ouvre et se connecte, vous êtes ajoutés automatiquement en amis.</p><button class="mcs-btn pri" data-a="share">📤 Partager mon lien d\'invitation</button></div>'
      + '<label>Pseudo de ton ami</label><input id="mcs-search" type="text" placeholder="ex : tony_stark">'
      + '<button class="mcs-btn pri" data-a="search">Rechercher</button>'
      + '<p class="mcs-muted" style="margin-top:12px">Ton pseudo à partager : <strong style="color:#E8C468">@'+esc(myProfile ? myProfile.username : '')+'</strong></p>'
      + '<div id="mcs-results"></div>';
  }
  /* ---- lien d'invitation : ouvrir le lien = devenir amis ---- */
  var INV_KEY = 'mcu_invite', inviteCode = null, invitePrompted = false;
  function pendingInvite(){ try { return JSON.parse(localStorage.getItem(INV_KEY) || 'null'); } catch(e){ return null; } }
  function clearInvite(){ try { localStorage.removeItem(INV_KEY); } catch(e){} }
  function captureInvite(){
    var qs = new URLSearchParams(location.search), u = qs.get('ami');
    if (!u) return;
    try { localStorage.setItem(INV_KEY, JSON.stringify({ u: u.replace(/^@/, ''), c: qs.get('c') || '' })); } catch(e){}
    qs.delete('ami'); qs.delete('c');
    try { history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs.toString() : '') + location.hash); } catch(e){}
  }
  function inviteLink(){
    var base = location.origin + '/?ami=' + encodeURIComponent((myProfile && myProfile.username) || '');
    if (inviteCode) return Promise.resolve(base + '&c=' + inviteCode);
    return sb.rpc('my_invite_code').then(function(r){ if (!r.error && r.data) inviteCode = r.data; return base + (inviteCode ? '&c=' + inviteCode : ''); }, function(){ return base; });
  }
  function copyText(t){
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
    return new Promise(function(ok){ var a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); try { document.execCommand('copy'); } catch(e){} a.remove(); ok(); });
  }
  function shareInvite(){
    return inviteLink().then(function(link){
      var txt = 'Rejoins-moi sur MCU Timeline : on suit nos films et séries Marvel et on se compare !';
      if (navigator.share) return navigator.share({ title: 'MCU Timeline', text: txt, url: link }).catch(function(){});
      return copyText(link).then(function(){ setMsg('Lien copié ✔ Colle-le dans un message à ton ami.<br><span class="mcs-muted">' + esc(link) + '</span>'); });
    });
  }
  function processInvite(){
    var inv = pendingInvite(); if (!inv || !me) return;
    var uname = String(inv.u || '');
    if (!uname || (myProfile && uname.toLowerCase() === String(myProfile.username).toLowerCase())) { clearInvite(); return; }
    function done(msg){ clearInvite(); return loadFriends().then(function(){ miniToast(msg); panelMsg = msg; panelTab = 'friends'; if (!document.getElementById('mcs-overlay')) { var o = document.createElement('div'); o.id = 'mcs-overlay'; o.onclick = function(e){ if (e.target === o) closePanel(); }; document.body.appendChild(o); } renderPanel(); }); }
    var viaCode = inv.c ? sb.rpc('accept_invite', { p_code: inv.c }) : Promise.resolve({ error: { message: 'no code' } });
    return viaCode.then(function(r){
      if (!r.error && r.data) { if (r.data.self) { clearInvite(); return; } return done('🤝 Vous êtes maintenant amis avec ' + (r.data.name || uname) + ' !'); }
      return sb.from('profiles').select('id,username,display_name').eq('username', uname).limit(1).then(function(p){
        var t = (p.data || [])[0]; if (!t || t.id === me.id) { clearInvite(); return; }
        var isF = friends.some(function(f){ return f.id === t.id; }), inc = incoming.filter(function(f){ return f.id === t.id; })[0], out = outgoing.some(function(f){ return f.id === t.id; });
        if (isF) { clearInvite(); miniToast('Tu es déjà ami avec ' + nameOf(t) + ' 🤝'); return; }
        if (inc) return sb.from('friendships').update({ status: 'accepted' }).eq('id', inc.friendship_id).then(function(){ return done('🤝 Vous êtes maintenant amis avec ' + nameOf(t) + ' !'); });
        if (out) { clearInvite(); miniToast('Demande déjà envoyée à ' + nameOf(t)); return; }
        return sb.from('friendships').insert({ requester: me.id, addressee: t.id }).then(function(){ return done('Demande d\'ami envoyée à ' + nameOf(t) + ' ✔'); });
      });
    }).catch(function(e){ console.warn('[mcu-social] invitation', e); });
  }
  function renderAccount(){
    var p = myProfile || {};
    return '<label>Pseudo</label><input id="mcs-acc-user" value="'+esc(p.username||'')+'">'
      + '<p class="mcs-muted">Ton nom, ta photo et ta bio viennent de ta page <strong>Profil</strong> du site : modifie-les l\u00E0-bas, tes amis voient la m\u00EAme chose.</p>'
      + '<label><input id="mcs-acc-public" type="checkbox" style="width:auto;margin-right:6px"'+(p.is_public?' checked':'')+'>Profil public (tout membre connecté peut voir mes vus et mes notes)</label><br><br>'
      + '<button class="mcs-btn pri" data-a="saveacc">Enregistrer</button> <button class="mcs-btn danger" data-a="logout">Se déconnecter</button>'
      + '<h3>Progression</h3><p class="mcs-muted">Ta progression (vus, notes, quiz, cartes, XP, secrets, profil) est enregistrée sur ton compte et partagée entre tous tes appareils.</p>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="mcs-btn" data-a="syncdown">Récupérer la progression du compte</button><button class="mcs-btn" data-a="syncup">Remplacer par celle de cet appareil</button></div>'
      + '<h3>Mes données</h3><p class="mcs-muted">Tu peux télécharger tout ce que le site garde sur toi, ou supprimer définitivement ton compte (profil, amis, vus, notes et progression en ligne). <a class="mcs-link" href="/confidentialite" target="_blank" rel="noopener">En savoir plus</a></p>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="mcs-btn" data-a="export">Télécharger mes données</button><button class="mcs-btn danger" data-a="delacc">Supprimer mon compte</button></div>'
      + '<p class="mcs-muted" style="margin-top:14px">Connecté avec '+esc(me.email||'')+'</p>';
  }
  /* ---- classement entre amis ---- */
  var rankSort = 'xp', rankProfiles = null, rankAt = 0;
  function renderRanking(){
    var b = document.getElementById('mcs-body'), m = MCU(); if (!b || !m) return;
    if (!rankProfiles || Date.now() - rankAt > 60000) {
      var ids = friends.map(function(f){ return f.id; });
      if (!ids.length) { rankProfiles = []; rankAt = Date.now(); return drawRanking(); }
      return sb.from('profiles').select('id,username,display_name,avatar_url,profile_data').in('id', ids).then(function(r){
        rankProfiles = r.data || []; rankAt = Date.now(); drawRanking();
      });
    }
    drawRanking();
  }
  function drawRanking(){
    var b = document.getElementById('mcs-body'), m = MCU(); if (!b || !m || panelTab !== 'rank') return;
    var items = m.mcuItems ? m.mcuItems() : [], total = items.length, mineP = m.profilePayload ? m.profilePayload() : {}, mw = m.state.watched || {};
    var seenBy = {}; Object.keys(friendData).forEach(function(it){ friendData[it].forEach(function(e){ if (e.watched) { (seenBy[e.uid] = seenBy[e.uid] || {})[it] = true; } }); });
    function cnt(w){ return items.filter(function(i){ return w && w[i.id]; }).length; }
    var rows = [{ me: true, p: myProfile || { username: 'Toi' }, lvl: mineP.lvl || 1, lvlName: mineP.lvlName || '', xp: mineP.xp || 0, ach: mineP.ach || 0, seen: cnt(mw) }];
    (rankProfiles || []).forEach(function(p){ var d = p.profile_data || {}; rows.push({ p: p, lvl: d.lvl || 1, lvlName: d.lvlName || '', xp: d.xp || 0, ach: d.ach || 0, seen: cnt(seenBy[p.id]) }); });
    var key = rankSort === 'seen' ? 'seen' : rankSort === 'ach' ? 'ach' : 'xp';
    rows.sort(function(a, c){ return (c[key] - a[key]) || (c.xp - a.xp) || (c.seen - a.seen); });
    var myRank = 0; rows.forEach(function(x, i){ if (x.me) myRank = i; });
    var unit = { xp: 'XP', seen: 'vus', ach: 'trophées' }[key];
    var lead;
    if (rows.length < 2) lead = 'Ajoute des amis pour lancer le classement !';
    else if (myRank === 0) { var gap = rows[0][key] - rows[1][key]; lead = gap ? 'Tu es <strong>1er</strong> avec <strong>' + gap + ' ' + unit + '</strong> d\'avance sur ' + esc(nameOf(rows[1].p)) + '.' : 'Tu es <strong>1er</strong>, à égalité avec ' + esc(nameOf(rows[1].p)) + ' !'; }
    else { var up = rows[myRank - 1], g2 = up[key] - rows[myRank][key]; lead = 'Tu es <strong>' + (myRank + 1) + 'e sur ' + rows.length + '</strong>. ' + (g2 ? 'Encore <strong>' + g2 + ' ' + unit + '</strong> pour dépasser ' + esc(nameOf(up.p)) + '.' : 'Égalité avec ' + esc(nameOf(up.p)) + ' : un dernier effort !'); }
    var h = '<div class="mcs-rk-sort">' + [['xp', 'XP'], ['seen', 'Contenus vus'], ['ach', 'Trophées']].map(function(s){ return '<button data-a="rksort" data-v="' + s[0] + '" class="' + (key === s[0] ? 'on' : '') + '">' + s[1] + '</button>'; }).join('') + '</div>'
      + '<div class="mcs-msg">' + lead + '</div><ol class="mcs-rk">';
    var medals = ['🥇', '🥈', '🥉'];
    rows.forEach(function(x, i){
      var val = key === 'seen' ? x.seen + '<small>/' + total + '</small>' : key === 'ach' ? x.ach + '<small> 🏆</small>' : x.xp + '<small> XP</small>';
      h += '<li class="' + (x.me ? 'me' : '') + (i < 3 ? ' top' : '') + '"><span class="mcs-rk-n">' + (medals[i] || (i + 1)) + '</span>' + avatarHtml(x.p)
        + '<div class="mcs-rk-who">' + (x.me ? '<strong>Toi</strong>' : '<button class="mcs-link" data-a="compare" data-v="' + esc(x.p.id) + '"><strong>' + esc(nameOf(x.p)) + '</strong></button>')
        + '<div class="mcs-muted">Niv. ' + x.lvl + (x.lvlName ? ' · ' + esc(x.lvlName) : '') + ' · ' + x.seen + '/' + total + ' vus</div></div>'
        + '<div class="mcs-rk-v">' + val + '</div></li>';
    });
    h += '</ol><p class="mcs-muted" style="margin-top:10px">Touche le nom d\'un ami pour lancer un défi. Le niveau et l\'XP de tes amis se mettent à jour quand ils utilisent le site.</p>';
    b.innerHTML = h;
  }
  var currentFriend = null, currentCompare = null;
  /* ---- défi : compare ta progression avec un ami ---- */
  function renderCompare(){
    var b = document.getElementById('mcs-body'), m = MCU(); if (!b || !m || !currentCompare) return;
    var f = friends.filter(function(x){ return x.id === currentCompare.id; })[0] || { id: currentCompare.id, username: '?' };
    var pd = (currentCompare.prof && currentCompare.prof.profile_data) || {}, mineP = m.profilePayload ? m.profilePayload() : {};
    var fw = {}; Object.keys(friendData).forEach(function(item){ friendData[item].forEach(function(e){ if (e.uid === f.id && e.watched) fw[item] = true; }); });
    var mw = m.state.watched || {}, items = m.mcuItems ? m.mcuItems() : [];
    var mineN = items.filter(function(i){ return mw[i.id]; }).length, hisN = items.filter(function(i){ return fw[i.id]; }).length;
    var ddM = m.doomsday ? m.doomsday(mw) : null, ddF = m.doomsday ? m.doomsday(fw) : null;
    var onlyHim = items.filter(function(i){ return fw[i.id] && !mw[i.id]; }), onlyMe = items.filter(function(i){ return mw[i.id] && !fw[i.id]; });
    function row(label, a, c, max){
      var w = function(x){ return max ? Math.round(x / max * 100) : 0; };
      return '<div class="mcs-cmp"><div class="mcs-cmp-l">'+label+'</div><div class="mcs-cmp-v"><span'+(a>c?' class="win"':'')+'>'+a+'</span><span class="mcs-muted">vs</span><span'+(c>a?' class="win"':'')+'>'+c+'</span></div>'
        + (max ? '<div class="mcs-cmp-bars"><i style="width:'+w(a)+'%"></i><i class="f" style="width:'+w(c)+'%"></i></div>' : '') + '</div>';
    }
    var lead = mineN === hisN ? 'Égalité parfaite ! À qui le prochain film ?' : (mineN > hisN ? 'Tu mènes de <strong>'+(mineN-hisN)+'</strong> contenu'+(mineN-hisN>1?'s':'')+'. Ne le laisse pas revenir !' : '<strong>'+esc(nameOf(f))+'</strong> mène de <strong>'+(hisN-mineN)+'</strong> contenu'+(hisN-mineN>1?'s':'')+'. À toi de rattraper ton retard !');
    var h = '<button class="mcs-link" data-a="tab" data-v="friends">← Retour</button>'
      + '<div class="mcs-row" style="justify-content:space-between"><div><strong>Toi</strong></div><div class="mcs-muted">⚔️ DÉFI</div><div style="text-align:right"><strong>'+esc(nameOf(f))+'</strong></div></div>'
      + '<div class="mcs-msg">'+lead+'</div>'
      + row('Contenus MCU vus', mineN, hisN, items.length)
      + (ddM ? row('Avant Doomsday (sur '+ddM.total+')', ddM.seen, ddF.seen, ddM.total) : '')
      + row('Niveau', mineP.lvl || 1, pd.lvl || 1, 0)
      + row('XP', mineP.xp || 0, pd.xp || 0, 0)
      + row('Trophées', mineP.ach || 0, pd.ach || 0, 0);
    if (!currentCompare.prof) h += '<div class="mcs-muted">Chargement du niveau de ton ami…</div>';
    if (onlyHim.length) { h += '<h3>Vu par '+esc(nameOf(f))+', pas encore par toi ('+onlyHim.length+')</h3>'; onlyHim.slice(0, 12).forEach(function(i){ h += '<div class="mcs-row"><button class="mcs-link" data-a="openitem" data-v="'+esc(i.id)+'">'+esc(i.title)+'</button></div>'; }); }
    if (onlyMe.length) h += '<p class="mcs-muted" style="margin-top:10px">Et toi, tu as vu <strong>'+onlyMe.length+'</strong> contenu'+(onlyMe.length>1?'s':'')+' que '+esc(nameOf(f))+' n\'a pas encore vu'+(onlyMe.length>1?'s':'')+'.</p>';
    h += '<p class="mcs-muted" style="margin-top:10px">Seuls les contenus que ton ami a marqués comme vus avec son compte sont comptés.</p>';
    b.innerHTML = h;
  }
  function renderFriendProfile(){
    var p = currentFriend; if (!p) return;
    var list = [];
    Object.keys(friendData).forEach(function(item){ friendData[item].forEach(function(e){ if (e.uid === p.id) list.push(e); }); });
    list.sort(function(a,b){ return (b.rating||0)-(a.rating||0); });
    var mine = (MCU() && MCU().state.watched) || {}, common = list.filter(function(e){ return e.watched && mine[e.item]; }).length;
    var h = '<button class="mcs-link" data-a="tab" data-v="friends">← Retour</button><div class="mcs-row">'+avatarHtml(p)+'<div><strong>'+esc(nameOf(p))+'</strong><div class="mcs-muted">'+(function(n){ return n+' contenu'+(n>1?'s':'')+' vu'+(n>1?'s':''); })(list.filter(function(e){return e.watched;}).length)+' · '+common+' en commun avec toi</div></div></div>';
    list.forEach(function(e){ h += '<div class="mcs-row"><div style="flex:1"><button class="mcs-link" data-a="openitem" data-v="'+esc(e.item)+'">'+esc(titleOf(e.item))+'</button></div><span style="color:#E8C468">'+stars(e.rating)+'</span>'+(mine[e.item]?'<span class="mcs-muted">✓ vu aussi</span>':'')+'</div>'; });
    var b = document.getElementById('mcs-body'); if (b) b.innerHTML = h;
  }
  function renderFeed(){
    sb.rpc('friends_feed', { p_limit: 120 }).then(function(res){
      var b = document.getElementById('mcs-body'); if (!b) return;
      if (res.error) { b.innerHTML = '<div class="mcs-msg">'+esc(res.error.message)+'</div>'; return; }
      var rows = res.data || [];
      if (!rows.length) { b.innerHTML = '<div class="mcs-muted">Rien pour l\'instant. Ajoute des amis pour voir ce qu\'ils regardent et comment ils notent.</div>'; return; }
      // regroupe les actions d'un meme ami a moins de 15 min d'ecart (evite 40 lignes quand quelqu'un coche tout d'un coup)
      var groups = [];
      rows.forEach(function(r){
        var g = groups[groups.length-1], t = new Date(r.happened_at).getTime();
        if (g && g.user_id === r.user_id && g.kind === r.kind && Math.abs(g.t - t) < 15*60*1000) { g.items.push(r); }
        else groups.push({ user_id: r.user_id, kind: r.kind, t: t, p: r, items: [r] });
      });
      b.innerHTML = groups.slice(0, 60).map(function(g){
        var it = g.items, first = it.slice(0, 3).map(function(r){ return '<button class="mcs-link" data-a="openitem" data-v="'+esc(r.item_id)+'">'+esc(titleOf(r.item_id))+'</button>'+(g.kind==='rating' ? ' <span style="color:#E8C468">'+stars(Number(r.rating))+'</span>' : ''); }).join(', ');
        var more = it.length > 3 ? ' et '+(it.length-3)+' autre'+(it.length>4?'s':'') : '';
        return '<div class="mcs-row">'+avatarHtml(g.p)+'<div style="flex:1"><button class="mcs-link" data-a="seefriend" data-v="'+esc(g.user_id)+'"><strong>'+esc(nameOf(g.p))+'</strong></button> '+(g.kind==='rating'?'a noté ':'a vu ')+first+more+'<div class="mcs-muted">'+ago(g.p.happened_at)+'</div></div></div>';
      }).join('');
    });
  }

  /* ---------------- actions ---------------- */
  function val(id){ var e = document.getElementById(id); return e ? e.value.trim() : ''; }
  function act(a, v){
    if (a === 'close') return closePanel();
    if (a === 'tab') { panelTab = v; panelMsg = ''; if (v === 'rank') rankProfiles = null; return renderPanel(); }
    if (a === 'rksort') { rankSort = v; return drawRanking(); }
    if (a === 'openitem') { closePanel(); var m = MCU(); if (m) m.openItem(v); return; }
    if (a === 'seefriend') { return openFriendProfile(v); }
    if (a === 'compare') {
      currentCompare = { id: v, prof: null }; panelTab = 'compare'; panelMsg = ''; renderPanel();
      return sb.from('profiles').select('id,username,display_name,avatar_url,profile_data').eq('id', v).single().then(function(r){
        if (currentCompare && currentCompare.id === v) { currentCompare.prof = (r && r.data) || {}; renderCompare(); }
      });
    }
    if (a === 'login') {
      return sb.auth.signInWithPassword({ email: val('mcs-email'), password: val('mcs-pass') }).then(function(r){ if (r.error) setMsg(esc(traduire(r.error.message))); });
    }
    if (a === 'signup') {
      var u = val('mcs-user');
      if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(u)) return setMsg('Choisis un pseudo de 3 à 24 caractères (lettres, chiffres, . _ -).');
      if (!(document.getElementById('mcs-cgu') || {}).checked) return setMsg('Coche la case d\'acceptation des conditions d\'utilisation pour créer un compte.');
      if (!(document.getElementById('mcs-age') || {}).checked) return setMsg('Pour créer un compte, il faut avoir 15 ans ou l\'accord d\'un parent.');
      return sb.auth.signUp({ email: val('mcs-email'), password: val('mcs-pass'), options: { data: { username: u, display_name: u, cgu_version: '2026-11-04', cgu_accepted_at: new Date().toISOString() }, emailRedirectTo: location.origin + location.pathname } })
        .then(function(r){ if (r.error) return setMsg(esc(traduire(r.error.message))); if (!r.data.session) setMsg('📧 Compte créé ! Clique sur le lien reçu par e-mail pour l\'activer, puis reviens te connecter.'); });
    }
    if (a === 'reset') {
      if (!val('mcs-email')) return setMsg('Indique ton e-mail ci-dessus.');
      return sb.auth.resetPasswordForEmail(val('mcs-email'), { redirectTo: location.origin + location.pathname }).then(function(){ setMsg('Si ce compte existe, un e-mail de réinitialisation vient d\'être envoyé.'); });
    }
    if (a === 'syncdown') { if (v !== 'ok') return setMsg('Remplacer la progression de cet appareil par celle de ton compte ? <button class="mcs-btn pri" data-a="syncdown" data-v="ok">Confirmer</button>'); return pullOrPush('down').then(function(){ return loadTables(); }).then(function(){ setMsg('\u2714 Progression du compte chargée sur cet appareil.'); }); }
    if (a === 'syncup') { if (v !== 'ok') return setMsg('Remplacer la progression du compte par celle de cet appareil ? Tes autres appareils la récupéreront. <button class="mcs-btn pri" data-a="syncup" data-v="ok">Confirmer</button>'); return pullOrPush('up').then(function(){ return loadTables(); }).then(function(){ return pushDiff(); }).then(function(){ setMsg('\u2714 Cet appareil est maintenant la référence de ton compte.'); }); }
    if (a === 'logout') { return sb.auth.signOut().then(function(){ closePanel(); }); }
    if (a === 'export') { return exportMyData(); }
    if (a === 'delacc') {
      if (v !== 'ok') return setMsg('Supprimer définitivement ton compte ? Ton profil, tes amis, tes vus, tes notes et ta progression en ligne seront effacés. Ta progression reste sur cet appareil tant que tu ne vides pas les données du navigateur. <button class="mcs-btn danger" data-a="delacc" data-v="ok">Oui, supprimer mon compte</button>');
      return sb.rpc('delete_my_account').then(function(r){
        if (r.error) return setMsg('La suppression n\'a pas abouti (' + esc(r.error.message) + '). Écris-nous et nous la ferons pour toi.');
        try { localStorage.removeItem(META_KEY); } catch(e){}
        return sb.auth.signOut().then(function(){ panelMsg = ''; closePanel(); miniToast('Ton compte a été supprimé.'); });
      });
    }
    if (a === 'share') { return shareInvite(); }
    if (a === 'search') {
      var q = val('mcs-search').replace(/^@/, '').replace(/[%_]/g, '');
      if (q.length < 2) return;
      return sb.from('profiles').select('id,username,display_name,avatar_url').ilike('username', q + '%').neq('id', me.id).limit(10).then(function(r){
        var box = document.getElementById('mcs-results'); if (!box) return;
        var known = {}; friends.concat(incoming, outgoing).forEach(function(f){ known[f.id] = 1; });
        box.innerHTML = (r.data || []).length ? r.data.map(function(p){ return '<div class="mcs-row">'+avatarHtml(p)+'<div style="flex:1"><strong>'+esc(nameOf(p))+'</strong> <span class="mcs-muted">@'+esc(p.username)+'</span></div>'+(known[p.id] ? '<span class="mcs-muted">déjà lié</span>' : '<button class="mcs-btn pri" data-a="request" data-v="'+p.id+'">Ajouter</button>')+'</div>'; }).join('') : '<div class="mcs-muted">Aucun membre trouvé.</div>';
      });
    }
    if (a === 'request') {
      return sb.from('friendships').insert({ requester: me.id, addressee: v }).then(function(r){
        if (r.error) return setMsg(r.error.code === '23505' ? 'Une demande existe déjà entre vous.' : esc(r.error.message));
        return loadFriends().then(function(){ panelTab = 'friends'; setMsg('Demande envoyée ✔'); });
      });
    }
    if (a === 'accept') { return sb.from('friendships').update({ status: 'accepted' }).eq('id', v).then(function(){ return loadFriends(); }).then(function(){ setMsg('Vous êtes maintenant amis 🤝'); }); }
    if (a === 'remove') { return sb.from('friendships').delete().eq('id', v).then(function(){ return loadFriends(); }).then(function(){ renderPanel(); }); }
    if (a === 'saveacc') {
      var nu = val('mcs-acc-user'), pub = !!(document.getElementById('mcs-acc-public') || {}).checked;
      if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(nu)) return setMsg('Pseudo invalide.');
      return sb.from('profiles').update({ username: nu, is_public: pub }).eq('id', me.id).select().single().then(function(r){
        if (r.error) return setMsg(r.error.code === '23505' ? 'Ce pseudo est déjà pris.' : esc(r.error.message));
        myProfile = r.data; lastProfSig = ''; pushProfile(); setMsg('Profil enregistré ✔');
      });
    }
  }
  function exportMyData(){
    if (!me) return;
    var q = function(p){ return p.then(function(r){ return r.error ? { erreur: r.error.message } : r.data; }); };
    return Promise.all([
      q(sb.from('profiles').select('*').eq('id', me.id)),
      q(sb.from('friendships').select('*')),
      q(sb.from('watches').select('*').eq('user_id', me.id)),
      q(sb.from('ratings').select('*').eq('user_id', me.id)),
      q(sb.from('user_progress').select('*').eq('user_id', me.id))
    ]).then(function(r){
      var data = { exporte_le: new Date().toISOString(), site: location.origin, compte: { id: me.id, email: me.email, cree_le: me.created_at, derniere_connexion: me.last_sign_in_at }, profil: r[0], amities: r[1], vus: r[2], notes: r[3], progression_en_ligne: r[4], progression_sur_cet_appareil: (MCU() && MCU().state) || null };
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'mcu-timeline-mes-donnees.json'; document.body.appendChild(a); a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      setMsg('✔ Fichier téléchargé : mcu-timeline-mes-donnees.json');
    });
  }
  function traduire(m){
    if (/Invalid login/i.test(m)) return 'E-mail ou mot de passe incorrect.';
    if (/Email not confirmed/i.test(m)) return 'Confirme d\'abord ton e-mail (lien reçu à l\'inscription).';
    if (/already registered/i.test(m)) return 'Un compte existe déjà avec cet e-mail.';
    if (/at least/i.test(m)) return 'Mot de passe trop court (8 caractères minimum).';
    return m;
  }
  document.addEventListener('click', function(e){
    var t = e.target.closest && e.target.closest('#mcs-overlay [data-a]');
    if (t) { e.preventDefault(); act(t.getAttribute('data-a'), t.getAttribute('data-v')); }
  });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape') { closePanel(); closePop(); }
    if (e.key === 'Enter' && e.target && e.target.id === 'mcs-search') act('search');
  });

  /* ---------------- demarrage ---------------- */
  function onSession(session){
    var u = session ? session.user : null;
    if ((u && u.id) === (me && me.id)) return;
    me = u;
    if (!me) { syncReady = false; friends = []; incoming = []; outgoing = []; friendData = {}; myProfile = null; synced = { watched:{}, ratings:{} }; updateNavBadge(); decorateModal(true);
      if (pendingInvite() && !invitePrompted) { invitePrompted = true; setTimeout(function(){ panelTab = 'feed'; panelMsg = '👋 Un ami t\'a invité ! Crée ton compte ou connecte-toi : vous serez ajoutés automatiquement en amis.'; renderPanel(); }, 900); }
      return; }
    sb.from('profiles').select('*').eq('id', me.id).single().then(function(r){ myProfile = r.data; if (document.getElementById('mcs-overlay')) { panelTab = 'feed'; renderPanel(); } });
    initialSync().then(loadFriends).then(function(){ var p = myProfile ? Promise.resolve() : sb.from('profiles').select('*').eq('id', me.id).single().then(function(r){ myProfile = myProfile || r.data; }); return p.then(processInvite); }).then(pushProfile).catch(function(e){ console.warn('[mcu-social]', e); });
  }
  function start(){
    if (!MCU()) { console.warn('[mcu-social] window.MCU absent : as-tu bien fait les 2 modifications du tuto ?'); return; }
    // observe la barre de nav et la fiche (elles sont reconstruites a chaque rendu)
    var nav = document.getElementById('mcu-nav-root'), modal = document.getElementById('mcu-modal-root');
    if (nav) new MutationObserver(injectNavButton).observe(nav, { childList: true });
    if (modal) new MutationObserver(function(){ decorateModal(false); }).observe(modal, { childList: true });
    injectNavButton();
    // lien direct depuis une page film : /ordre-chronologique-marvel?film=iron-man ouvre la fiche
    captureInvite();
    var deep = new URLSearchParams(location.search).get('film');
    if (deep && MCU().itemById(deep)) setTimeout(function(){ MCU().openItem(deep); }, 300);
    window.addEventListener('mcu:saved', schedulePush);
    window.addEventListener('mcu:saved', scheduleProfilePush);
    window.addEventListener('mcu:saved', onLocalSave);
    if (!CONFIGURED) return;
    loadLib(function(){
      sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      loadCommunity();
      sb.auth.getSession().then(function(r){ onSession(r.data.session); });
      sb.auth.onAuthStateChange(function(_evt, session){ setTimeout(function(){ onSession(session); }, 0); });
    });
  }
  (window.__mcuReady || Promise.resolve()).then(function(){ if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start(); });
})();
