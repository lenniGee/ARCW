/**
 * Ruder-Training – Server für die Trainings-App
 * ------------------------------------------------
 * Läuft als Google-Apps-Script im Trainingsplan-Sheet (Erweiterungen → Apps Script).
 * Bereitstellen als Web-App: „Ausführen als: Ich“, „Zugriff: Jeder“.
 * Die App spricht nur mit dieser Web-App; niemand braucht ein Google-Konto.
 */

const SH = {
  PLAN: 'Plan', KRAFT: 'Kraftplan', WOCHEN: 'Wochen', SPORTLER: 'Sportler',
  PROT: 'Protokoll', KPROT: 'Kraft-Protokoll', SET: 'Einstellungen'
};
const C2 = {
  AUTH: 'https://log.concept2.com/oauth/authorize',
  TOKEN: 'https://log.concept2.com/oauth/access_token',
  API: 'https://log.concept2.com/api',
  SCOPE: 'results:read'
};

/* ============================== Einstieg ============================== */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.code && p.state) return c2Callback_(p);
  if (p.error && p.state) return htmlPage_('Concept2', 'Verbindung abgebrochen: ' + p.error);
  return handle_(p.action, p);
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { /* leer */ }
  return handle_(body.action, body);
}

function handle_(action, p) {
  try {
    if (!action) return json_({ ok: true, data: { app: 'Ruder-Training', version: 1 } });
    checkTeamCode_(p.team);
    let data;
    switch (action) {
      case 'init': data = apiInit_(); break;
      case 'plan': data = apiPlan_(p.athlete, p.from, p.to); break;
      case 'log': data = apiLog_(p); break;
      case 'team': data = apiTeam_(p.from, p.to); break;
      case 'c2status': data = { connected: !!getC2Token_(p.athlete, true), configured: c2Configured_() }; break;
      case 'c2url': data = { url: c2AuthUrl_(p.athlete) }; break;
      case 'c2results': data = apiC2Results_(p.athlete, p.date); break;
      case 'c2disconnect': PropertiesService.getScriptProperties().deleteProperty(c2Key_(p.athlete)); data = {}; break;
      default: throw new Error('Unbekannte Aktion: ' + action);
    }
    return json_({ ok: true, data: data });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/* ============================== API ============================== */

function apiInit_() {
  const sportler = readTable_(SH.SPORTLER).rows
    .filter(r => r['Name'] && String(r['Aktiv'] || 'ja').toLowerCase() !== 'nein')
    .map(r => ({ name: String(r['Name']).trim(), gruppe: r['Gruppe'] || '', plan: r['Trainingsplan'] || '', kraftplan: r['Kraftplan'] || '' }));
  return { athletes: sportler, today: fmtDate_(new Date()), c2: c2Configured_() };
}

function apiPlan_(athlete, from, to) {
  const a = findAthlete_(athlete);
  const plan = readTable_(SH.PLAN);
  ensureIds_(plan);
  const units = plan.rows
    .filter(r => r['Plan'] === a.plan && r['Datum'] instanceof Date)
    .map(r => ({
      id: String(r['ID']), datum: fmtDate_(r['Datum']), woche: r['Woche'], phase: r['Phase'] || '',
      zeit: r['Zeit / Ort'] || '', einheit: r['Einheit'] || '', art: r['Art'] || 'Sonstiges', zone: r['Zone'] || '',
      warm: r['Aufwärmen'] || '', haupt: r['Hauptteil'] || '', cool: r['Ausfahren'] || '',
      intervalle: r['Intervalle (Kurzform)'] || '', dauer: num_(r['Dauer (min)']),
      kraft: r['Kraft-Einheit'] || '', altArt: r['Alternative: Art'] || '', alt: r['Alternative: Ablauf'] || '',
      hinweis: r['Hinweis'] || ''
    }))
    .filter(u => (!from || u.datum >= from) && (!to || u.datum <= to));

  // Kraftübungen + letzte Gewichte
  const kraftRows = readTable_(SH.KRAFT).rows.filter(r => r['Kraftplan'] === a.kraftplan);
  const last = {};
  readTable_(SH.KPROT).rows.forEach(r => {
    if (r['Sportler'] !== a.name || !r['Übung']) return;
    const k = String(r['Übung']);
    const d = r['Datum'] instanceof Date ? fmtDate_(r['Datum']) : String(r['Datum']);
    if (!last[k] || d > last[k].datum) last[k] = { datum: d, saetze: [] };
    if (last[k].datum === d) last[k].saetze.push({ wdh: r['Wdh'], kg: r['Gewicht (kg)'] });
  });
  units.forEach(u => {
    if (!u.kraft) return;
    u.uebungen = kraftRows.filter(k => String(k['Einheit']) === String(u.kraft))
      .sort((x, y) => num_(x['Nr']) - num_(y['Nr']))
      .map(k => ({
        uebung: String(k['Übung']), saetze: num_(k['Sätze']) || 1, wdh: String(k['Wdh'] || ''),
        vorgabe: String(k['Vorgabe (kg / %)'] || ''), pause: String(k['Pause'] || ''), hinweis: String(k['Hinweis'] || ''),
        letztes: last[String(k['Übung'])] || null
      }));
  });

  const wochen = readTable_(SH.WOCHEN).rows
    .filter(r => r['Plan'] === a.plan && r['Von'] instanceof Date)
    .map(r => ({ woche: r['Woche'], von: fmtDate_(r['Von']), bis: fmtDate_(r['Bis']), thema: r['Thema'] || '', hinweis: r['Hinweis'] || '' }));

  const logs = readTable_(SH.PROT).rows
    .filter(r => r['Sportler'] === a.name)
    .map(r => ({
      eintrag: String(r['Eintrag-ID']), planId: String(r['Plan-ID'] || ''), datum: r['Datum'] instanceof Date ? fmtDate_(r['Datum']) : String(r['Datum']),
      einheit: r['Einheit'], art: r['Art'], variante: r['Variante'], dauer: num_(r['Dauer (min)'])
    }))
    .filter(l => (!from || l.datum >= from) && (!to || l.datum <= to));

  return { athlete: a, units: units, wochen: wochen, logs: logs };
}

function apiLog_(p) {
  const a = findAthlete_(p.athlete);
  const e = p.entry || {};
  if (!e.id) throw new Error('Eintrag-ID fehlt');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.datum || '')) throw new Error('Datum fehlt');
  if (!(num_(e.dauer) > 0)) throw new Error('Dauer fehlt');

  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const ss = SpreadsheetApp.getActive();
    const prot = ss.getSheetByName(SH.PROT);
    const existing = readTable_(SH.PROT);
    if (existing.rows.some(r => String(r['Eintrag-ID']) === String(e.id))) return { duplicate: true };

    // Ersetzen: alter Eintrag zur selben Plan-Einheit wird gelöscht
    if (p.replace && e.planId) {
      const old = existing.rows.filter(r => r['Sportler'] === a.name && String(r['Plan-ID']) === String(e.planId));
      const oldIds = old.map(r => String(r['Eintrag-ID']));
      deleteRowsWhere_(SH.PROT, r => oldIds.indexOf(String(r['Eintrag-ID'])) >= 0);
      deleteRowsWhere_(SH.KPROT, r => oldIds.indexOf(String(r['Eintrag-ID'])) >= 0);
    }

    let fotoUrl = '';
    if (p.photo && p.photo.data) {
      const folder = getPhotoFolder_();
      const ext = (p.photo.mime || 'image/jpeg').split('/')[1].replace('jpeg', 'jpg');
      const name = [e.datum, a.name, (e.einheit || 'Einheit')].join(' – ').replace(/[\\/:*?"<>|]/g, '') + '.' + ext;
      const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(p.photo.data), p.photo.mime || 'image/jpeg', name));
      fotoUrl = file.getUrl();
    }

    const z = e.zonen || [];
    const row = {
      'Eintrag-ID': e.id, 'Zeitstempel': new Date(), 'Datum': parseDate_(e.datum), 'Sportler': a.name, 'Plan': a.plan,
      'Plan-ID': e.planId || '', 'Einheit': e.einheit || '', 'Art': e.art || '', 'Variante': e.variante || 'Plan',
      'Dauer (min)': num_(e.dauer), 'Distanz (m)': numOrEmpty_(e.distanz), 'HF Ø': numOrEmpty_(e.hfAvg), 'HF max': numOrEmpty_(e.hfMax),
      'Z1 (min)': numOrEmpty_(z[0]), 'Z2 (min)': numOrEmpty_(z[1]), 'Z3 (min)': numOrEmpty_(z[2]),
      'Z4 (min)': numOrEmpty_(z[3]), 'Z5 (min)': numOrEmpty_(z[4]), 'Z6 (min)': numOrEmpty_(z[5]),
      'Split Ø (/500m)': e.split || '', 'Watt Ø': numOrEmpty_(e.watt), 'SF Ø': numOrEmpty_(e.sf), 'RPE': numOrEmpty_(e.rpe),
      'Intervalle': intervalsText_(e.intervalle), 'Foto': fotoUrl, 'Notiz': e.notiz || '', 'Quelle': e.quelle || 'App'
    };
    appendByHeaders_(prot, row);

    const kp = ss.getSheetByName(SH.KPROT);
    (p.kraft || []).forEach(k => {
      if (k.wdh === '' && k.kg === '') return;
      appendByHeaders_(kp, {
        'Eintrag-ID': e.id, 'Zeitstempel': new Date(), 'Datum': parseDate_(e.datum), 'Sportler': a.name, 'Plan-ID': e.planId || '',
        'Kraftplan': a.kraftplan, 'Kraft-Einheit': e.kraftEinheit || '', 'Übung': k.uebung, 'Satz': num_(k.satz),
        'Wdh': numOrText_(k.wdh), 'Gewicht (kg)': numOrEmpty_(k.kg), 'Notiz': k.notiz || ''
      });
    });
    return { saved: true, foto: fotoUrl };
  } finally {
    lock.releaseLock();
  }
}

/** Nur Minuten – keine weiteren Daten anderer Sportler. */
function apiTeam_(from, to) {
  const names = apiInit_().athletes.map(a => a.name);
  const per = {};
  names.forEach(n => per[n] = {});
  readTable_(SH.PROT).rows.forEach(r => {
    if (!(r['Datum'] instanceof Date) || !per[r['Sportler']]) return;
    const d = fmtDate_(r['Datum']);
    if ((from && d < from) || (to && d > to)) return;
    per[r['Sportler']][d] = (per[r['Sportler']][d] || 0) + num_(r['Dauer (min)']);
  });
  return { athletes: names, minutes: per };
}

/* ============================== Concept2 ============================== */

function c2Configured_() {
  const s = settings_();
  return !!(s['Concept2 Client-ID'] && s['Concept2 Client-Secret']);
}
function c2Key_(athlete) { return 'c2:' + String(athlete || '').trim(); }

function c2AuthUrl_(athlete) {
  const a = findAthlete_(athlete);
  if (!c2Configured_()) throw new Error('Concept2 ist noch nicht eingerichtet (Blatt Einstellungen).');
  const nonce = Utilities.getUuid();
  CacheService.getScriptCache().put('c2state:' + nonce, a.name, 1800);
  const s = settings_();
  return C2.AUTH + '?' + qs_({
    client_id: s['Concept2 Client-ID'], scope: C2.SCOPE, response_type: 'code',
    redirect_uri: ScriptApp.getService().getUrl(), state: nonce
  });
}

function c2Callback_(p) {
  const name = CacheService.getScriptCache().get('c2state:' + p.state);
  if (!name) return htmlPage_('Concept2', 'Der Link ist abgelaufen. Bitte in der App erneut „Concept2 verbinden“ tippen.');
  const s = settings_();
  const res = UrlFetchApp.fetch(C2.TOKEN, {
    method: 'post', muteHttpExceptions: true,
    payload: {
      client_id: s['Concept2 Client-ID'], client_secret: s['Concept2 Client-Secret'], grant_type: 'authorization_code',
      code: p.code, redirect_uri: ScriptApp.getService().getUrl(), scope: C2.SCOPE
    }
  });
  if (res.getResponseCode() !== 200) return htmlPage_('Concept2', 'Verbindung fehlgeschlagen (' + res.getResponseCode() + '). ' + res.getContentText().slice(0, 300));
  saveC2Token_(name, JSON.parse(res.getContentText()));
  return htmlPage_('Concept2 verbunden ✓', name + ', dein Concept2-Logbuch ist verbunden. Du kannst dieses Fenster schließen und zur App zurückkehren.');
}

function saveC2Token_(name, t) {
  PropertiesService.getScriptProperties().setProperty(c2Key_(name), JSON.stringify({
    access: t.access_token, refresh: t.refresh_token, exp: Date.now() + (num_(t.expires_in) || 3600) * 1000 - 60000
  }));
}

function getC2Token_(athlete, onlyCheck) {
  const raw = PropertiesService.getScriptProperties().getProperty(c2Key_(athlete));
  if (!raw) return null;
  const t = JSON.parse(raw);
  if (onlyCheck || Date.now() < t.exp) return t.access;
  const s = settings_();
  const res = UrlFetchApp.fetch(C2.TOKEN, {
    method: 'post', muteHttpExceptions: true,
    payload: {
      client_id: s['Concept2 Client-ID'], client_secret: s['Concept2 Client-Secret'],
      grant_type: 'refresh_token', refresh_token: t.refresh, scope: C2.SCOPE
    }
  });
  if (res.getResponseCode() !== 200) {
    PropertiesService.getScriptProperties().deleteProperty(c2Key_(athlete));
    return null;
  }
  const nt = JSON.parse(res.getContentText());
  saveC2Token_(athlete, nt);
  return nt.access_token;
}

function c2Get_(token, path) {
  const res = UrlFetchApp.fetch(C2.API + path, {
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.c2logbook.v1+json' }
  });
  if (res.getResponseCode() !== 200) throw new Error('Concept2 antwortet mit ' + res.getResponseCode());
  return JSON.parse(res.getContentText());
}

/** Ergebnisse eines Tages aus dem Concept2-Logbuch, umgerechnet in die Felder der App. */
function apiC2Results_(athlete, date) {
  const a = findAthlete_(athlete);
  const token = getC2Token_(a.name);
  if (!token) return { connected: false, results: [] };
  const list = c2Get_(token, '/users/me/results?' + qs_({ from: date + ' 00:00:00', to: date + ' 23:59:59', number: 50 })).data || [];
  const results = list.map(r => {
    let full = r;
    try { full = Object.assign({}, r, c2Get_(token, '/users/me/results/' + r.id).data || {}); } catch (err) { /* Liste reicht */ }
    return mapC2Result_(full);
  });
  return { connected: true, results: results };
}

function mapC2Result_(r) {
  const t = num_(r.time) / 10;              // Sekunden
  const dist = num_(r.distance);
  const hr = r.heart_rate || {};
  const w = r.workout || {};
  const parts = (w.intervals && w.intervals.length ? w.intervals : (w.splits || [])).map(s => {
    const st = num_(s.time) / 10, sd = num_(s.distance), sh = s.heart_rate || {};
    return {
      distanz: sd || '', zeit: fmtSec_(st), split: sd ? fmtSec_(st / sd * 500) : '',
      watt: sd ? Math.round(2.8 / Math.pow(st / sd, 3)) : '', sf: s.stroke_rate || '', hf: sh.average || sh.ending || '',
      pause: s.rest_time ? fmtSec_(num_(s.rest_time) / 10) : ''
    };
  });
  return {
    id: r.id, typ: r.type || '', workout: r.workout_type || '', uhrzeit: String(r.date || '').slice(11, 16),
    dauer: Math.round((t + num_(r.rest_time) / 10) / 60), distanz: dist,
    zeit: r.time_formatted || fmtSec_(t),
    split: dist ? fmtSec_(t / dist * 500) : '', watt: dist ? Math.round(2.8 / Math.pow(t / dist, 3)) : '',
    sf: r.stroke_rate || '', hfAvg: hr.average || '', hfMax: hr.max || '', intervalle: parts
  };
}

/* ============================== Tägliche Zusammenfassung ============================== */

function taeglicheZusammenfassung() {
  const today = fmtDate_(new Date());
  const monday = fmtDate_(mondayOf_(new Date()));
  const team = apiTeam_(monday, today);
  const sportler = readTable_(SH.SPORTLER).rows.filter(r => r['Name'] && String(r['Aktiv'] || 'ja').toLowerCase() !== 'nein');
  const plan = readTable_(SH.PLAN).rows.filter(r => r['Datum'] instanceof Date && fmtDate_(r['Datum']) === today);

  const zeilen = sportler.map(s => {
    const name = String(s['Name']).trim();
    const m = team.minutes[name] || {};
    const heute = m[today] || 0;
    const woche = Object.keys(m).reduce((x, k) => x + m[k], 0);
    const soll = plan.filter(p => p['Plan'] === s['Trainingsplan']).reduce((x, p) => x + num_(p['Dauer (min)']), 0);
    return { name: name, heute: heute, woche: woche, soll: soll };
  }).sort((x, y) => y.heute - x.heute || y.woche - x.woche);

  const empf = [];
  String(settings_()['Zusammenfassung an'] || '').split(/[,;\s]+/).forEach(x => x && empf.push(x));
  sportler.forEach(s => s['E-Mail (Zusammenfassung)'] && empf.push(String(s['E-Mail (Zusammenfassung)']).trim()));
  const uniq = empf.filter((x, i) => empf.indexOf(x) === i);
  if (!uniq.length) return;

  const dTxt = Utilities.formatDate(new Date(), tz_(), 'dd.MM.yyyy');
  const rows = zeilen.map(z => '<tr><td style="padding:4px 10px">' + esc_(z.name) + '</td>' +
    '<td style="padding:4px 10px;text-align:right;font-weight:600;color:' + (z.heute ? '#0f5132' : (z.soll ? '#b42318' : '#555')) + '">' +
    (z.heute ? z.heute + ' min' : (z.soll ? 'noch offen' : '–')) + '</td>' +
    '<td style="padding:4px 10px;text-align:right">' + z.woche + ' min</td></tr>').join('');
  const html = '<div style="font-family:Arial,sans-serif"><h2 style="margin:0 0 8px">Training heute – ' + dTxt + '</h2>' +
    '<table style="border-collapse:collapse"><tr style="background:#1f3a5f;color:#fff"><th style="padding:4px 10px;text-align:left">Sportler</th>' +
    '<th style="padding:4px 10px">Heute</th><th style="padding:4px 10px">Diese Woche</th></tr>' + rows + '</table>' +
    '<p style="color:#666;font-size:12px">„noch offen“ = heute stand eine Einheit im Plan, aber es ist noch nichts eingetragen.</p></div>';
  MailApp.sendEmail({ to: uniq.shift(), bcc: uniq.join(','), subject: 'Training heute – ' + dTxt, htmlBody: html });
}

/* ============================== Einrichtung & Menü ============================== */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Training')
    .addItem('Einrichten (einmalig)', 'einrichten')
    .addItem('Zusammenfassung jetzt senden', 'taeglicheZusammenfassung')
    .addItem('Fehlende Plan-IDs vergeben', 'idsVergeben')
    .addItem('Concept2-Verbindungen anzeigen', 'c2Uebersicht')
    .addToUi();
}

function einrichten() {
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone('Europe/Berlin');
  getPhotoFolder_();
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'taeglicheZusammenfassung')
    .forEach(t => ScriptApp.deleteTrigger(t));
  const hour = Math.max(0, Math.min(23, num_(settings_()['Zusammenfassung Uhrzeit']) || 21));
  ScriptApp.newTrigger('taeglicheZusammenfassung').timeBased().everyDays(1).atHour(hour).inTimezone('Europe/Berlin').create();
  idsVergeben();
  const url = ScriptApp.getService().getUrl();
  SpreadsheetApp.getUi().alert('Eingerichtet ✓\n\nFoto-Ordner angelegt, tägliche Zusammenfassung um ' + hour + ' Uhr.\n\n' +
    (url ? 'Web-App-URL (für die App und Concept2):\n' + url : 'Jetzt noch: Bereitstellen → Neue Bereitstellung → Web-App.'));
}

function idsVergeben() { ensureIds_(readTable_(SH.PLAN)); }

function c2Uebersicht() {
  const props = PropertiesService.getScriptProperties().getKeys().filter(k => k.indexOf('c2:') === 0).map(k => k.slice(3));
  SpreadsheetApp.getUi().alert('Mit Concept2 verbunden:\n\n' + (props.join('\n') || '(noch niemand)'));
}

/* ============================== Helfer ============================== */

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function htmlPage_(title, msg) {
  return HtmlService.createHtmlOutput('<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<div style="font-family:Arial,sans-serif;padding:24px;max-width:480px;margin:auto"><h2>' + esc_(title) + '</h2><p>' + esc_(msg) + '</p></div>')
    .setTitle(title);
}
function esc_(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function qs_(o) { return Object.keys(o).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&'); }
function tz_() { return SpreadsheetApp.getActive().getSpreadsheetTimeZone() || 'Europe/Berlin'; }
function fmtDate_(d) { return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd'); }
function parseDate_(s) { const p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
function mondayOf_(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
function num_(v) { const n = parseFloat(String(v === undefined || v === null ? '' : v).replace(',', '.')); return isNaN(n) ? 0 : n; }
function numOrEmpty_(v) { return v === '' || v === undefined || v === null || isNaN(parseFloat(String(v).replace(',', '.'))) ? '' : num_(v); }
function numOrText_(v) { return /^\s*\d+([.,]\d+)?\s*$/.test(String(v)) ? num_(v) : (v || ''); }
function fmtSec_(s) {
  if (!s) return '';
  const m = Math.floor(s / 60), r = s - m * 60;
  return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
}

function checkTeamCode_(code) {
  const soll = String(settings_()['Team-Code'] || '').trim().toLowerCase();
  if (!soll) throw new Error('Kein Team-Code im Blatt Einstellungen hinterlegt.');
  if (String(code || '').trim().toLowerCase() !== soll) throw new Error('TEAMCODE');
}

let SETTINGS_CACHE = null;
function settings_() {
  if (SETTINGS_CACHE) return SETTINGS_CACHE;
  const o = {};
  readTable_(SH.SET).rows.forEach(r => { if (r['Schlüssel']) o[String(r['Schlüssel']).trim()] = r['Wert']; });
  return (SETTINGS_CACHE = o);
}
function setSetting_(key, value) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SH.SET);
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][0]).trim() === key) { sh.getRange(i + 1, 2).setValue(value); SETTINGS_CACHE = null; return; }
  }
  sh.appendRow([key, value, '']);
  SETTINGS_CACHE = null;
}

function getPhotoFolder_() {
  const id = String(settings_()['Foto-Ordner-ID'] || '').trim();
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* neu anlegen */ } }
  const f = DriveApp.createFolder('Training – Beweisfotos');
  setSetting_('Foto-Ordner-ID', f.getId());
  return f;
}

function findAthlete_(name) {
  const n = String(name || '').trim();
  const a = apiInit_().athletes.filter(x => x.name === n)[0];
  if (!a) throw new Error('Sportler nicht gefunden: ' + n);
  return a;
}

const TABLE_CACHE = {};
function readTable_(name) {
  if (TABLE_CACHE[name]) return TABLE_CACHE[name];
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Blatt fehlt: ' + name);
  const vals = sh.getDataRange().getValues();
  const headers = (vals[0] || []).map(h => String(h).trim());
  const rows = [];
  for (let i = 1; i < vals.length; i++) {
    if (vals[i].every(v => v === '' || v === null)) continue;
    const o = { _row: i + 1 };
    headers.forEach((h, j) => { if (h) o[h] = vals[i][j]; });
    rows.push(o);
  }
  return (TABLE_CACHE[name] = { sheet: sh, headers: headers, rows: rows });
}

function appendByHeaders_(sheet, obj) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  sheet.appendRow(headers.map(h => (h in obj ? obj[h] : '')));
  delete TABLE_CACHE[sheet.getName()];
}

function deleteRowsWhere_(name, pred) {
  delete TABLE_CACHE[name];
  const t = readTable_(name);
  t.rows.filter(pred).map(r => r._row).sort((a, b) => b - a).forEach(r => t.sheet.deleteRow(r));
  delete TABLE_CACHE[name];
}

/** Vergibt IDs für neu angelegte Planzeilen (Spalte ID leer). */
function ensureIds_(table) {
  const col = table.headers.indexOf('ID') + 1;
  if (!col) return;
  const used = {};
  table.rows.forEach(r => { if (r['ID']) used[String(r['ID'])] = true; });
  table.rows.forEach(r => {
    if (r['ID'] || !(r['Datum'] instanceof Date) || !r['Plan']) return;
    const base = String(r['Plan']).replace(/[^A-Za-zÄÖÜäöü0-9]/g, '').slice(0, 4).toUpperCase() + '-' +
      Utilities.formatDate(r['Datum'], tz_(), 'yyyyMMdd') + '-';
    let n = 1;
    while (used[base + n]) n++;
    r['ID'] = base + n;
    used[r['ID']] = true;
    table.sheet.getRange(r._row, col).setValue(r['ID']);
  });
}

function intervalsText_(list) {
  if (!list || !list.length) return '';
  return list.map((iv, i) => {
    const p = [(i + 1) + '.'];
    if (iv.soll) p.push(iv.soll);
    if (iv.distanz) p.push(iv.distanz + ' m');
    if (iv.zeit) p.push(iv.zeit);
    if (iv.split) p.push(iv.split + '/500m');
    if (iv.watt) p.push(iv.watt + ' W');
    if (iv.sf) p.push('SF ' + iv.sf);
    if (iv.hf) p.push('HF ' + iv.hf);
    return p.join(' ');
  }).join('\n');
}
