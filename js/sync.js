/* Celu al día sin pasar archivos: la PC sube una copia CIFRADA de los datos a GitHub (el repositorio de la app del
   celu, rama "datos") cada vez que cambian, y la app del celu la baja sola al abrirse.
   - Cifrado AES-GCM con una clave que sale de un código al azar que genera la PC (PBKDF2). El código no se sube:
     se escribe una vez en el celu. Sin él, el archivo publicado no se puede leer.
   - Para subir, la PC necesita un token de GitHub con permiso de escritura SOLO en ese repositorio (lo pega el
     usuario una vez; queda en este navegador). El celu solo lee: no necesita token.
   - La PC sube solo lo que leyó de datos.json en esta sesión (Carpeta.alDia), así una PC con una copia vieja no
     pisa lo último. Los cambios hechos en el celu siguen volviendo a la PC por archivo (celu.js). */
(function () {
  'use strict';
  var App = window.App;
  var A = App.Almacen, UI = App.UI, esc = UI.esc;

  var REPO = 'FernandoRamponi/impresoras', RAMA = 'datos', RUTA = 'datos.cifrado.json';
  var API = 'https://api.github.com/repos/' + REPO;
  var RAW = 'https://raw.githubusercontent.com/' + REPO + '/' + RAMA + '/' + RUTA;
  var URL_TOKEN = 'https://github.com/settings/personal-access-tokens/new?name=Impresoras%20celu' +
    '&description=Sube%20los%20datos%20cifrados%20para%20la%20app%20del%20celu&contents=write';
  var CLAVE = 'impresoras.sync.v1';
  var TIPO = 'impresoras-cifrado';
  var ALFABETO = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   // sin 0/O ni 1/I: no se confunden al escribirlo
  var LARGO = 20;                                     // 20 caracteres de 32 posibles = 100 bits al azar
  var ITER = 150000;

  var celu = A.modoCelu();
  var escuchas = [];
  var estado = '';          // '' | 'subiendo' | 'bajando' | 'ok' | 'error'
  var timer = null, enCurso = null, pendiente = false, ultimaBajada = 0;
  var dlg = null, vista = '';

  function avisar() { escuchas.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } }); }

  /* ---------- Configuración (en este navegador) ---------- */
  // PC: { token, codigo, sal, subido (firma de lo último subido), fecha, error }
  // Celu: { codigo, iv (de la última copia bajada), fecha (cuándo la subió la PC), error }
  function leer() {
    try { return JSON.parse(localStorage.getItem(CLAVE) || 'null') || {}; } catch (e) { return {}; }
  }
  function guardar(c) {
    try {
      if (c && Object.keys(c).length) localStorage.setItem(CLAVE, JSON.stringify(c));
      else localStorage.removeItem(CLAVE);
    } catch (e) { /* sin lugar: se pierde al cerrar */ }
    avisar();
  }
  function activo() { var c = leer(); return celu ? !!c.codigo : !!(c.token && c.codigo); }

  /* ---------- Código y cifrado ---------- */
  function nuevoCodigo() {
    var r = crypto.getRandomValues(new Uint8Array(LARGO)), c = '';
    for (var i = 0; i < LARGO; i++) c += ALFABETO.charAt(r[i] & 31);
    return c;
  }
  function limpiarCodigo(t) { return String(t || '').toUpperCase().replace(/[^0-9A-Z]/g, ''); }
  function codigoValido(c) {
    if (c.length !== LARGO) return false;
    for (var i = 0; i < c.length; i++) if (ALFABETO.indexOf(c.charAt(i)) === -1) return false;
    return true;
  }
  function mostrarCodigo(c) { return (c.match(/.{1,5}/g) || []).join('-'); }

  function aB64(bytes) {
    bytes = new Uint8Array(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function deB64(t) {
    var s = atob(t), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  var claves = {};
  function claveDe(codigo, sal, iter) {
    var k = codigo + '|' + sal + '|' + iter;
    if (!claves[k]) {
      claves[k] = crypto.subtle.importKey('raw', new TextEncoder().encode(codigo), 'PBKDF2', false, ['deriveKey'])
        .then(function (base) {
          return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: deB64(sal), iterations: iter, hash: 'SHA-256' },
            base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        });
      claves[k].catch(function () { delete claves[k]; });
    }
    return claves[k];
  }

  function cifrar(datos, codigo, sal) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return claveDe(codigo, sal, ITER).then(function (k) {
      return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, k, new TextEncoder().encode(JSON.stringify(datos)));
    }).then(function (ct) {
      return { tipo: TIPO, v: 1, kdf: { alg: 'PBKDF2-SHA256', iter: ITER, sal: sal }, iv: aB64(iv), datos: aB64(ct) };
    });
  }

  function errorCodigo() { var e = new Error('El código no coincide con el de la PC. Revisalo (menú ⋮ → "Ver en el celu" en la PC).'); e.codigo = true; return e; }

  function descifrar(obj, codigo) {
    if (!obj || obj.tipo !== TIPO || !obj.kdf || !obj.iv || !obj.datos) return Promise.reject(new Error('La copia de la PC no tiene el formato esperado.'));
    return claveDe(codigo, obj.kdf.sal, obj.kdf.iter || ITER).then(function (k) {
      return crypto.subtle.decrypt({ name: 'AES-GCM', iv: deB64(obj.iv) }, k, deB64(obj.datos));
    }).then(function (txt) {
      return JSON.parse(new TextDecoder().decode(txt));
    }, function () { throw errorCodigo(); });
  }

  /* ---------- GitHub ---------- */
  function gh(token, metodo, ruta, cuerpo) {
    var h = { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token };
    if (cuerpo) h['Content-Type'] = 'application/json';
    return fetch(API + ruta, { method: metodo, headers: h, body: cuerpo ? JSON.stringify(cuerpo) : undefined, cache: 'no-store' })
      .then(function (r) {
        return r.text().then(function (t) {
          var j = null;
          try { j = t ? JSON.parse(t) : null; } catch (e) { /* nada */ }
          return { status: r.status, json: j };
        });
      }, function () { throw new Error('No hay conexión con GitHub (¿sin internet o lo bloquea la red?).'); });
  }

  function errorGH(r) {
    var m = (r.json && r.json.message) || '';
    if (r.status === 401) return new Error('GitHub no aceptó el token (venció, se borró o está mal copiado). Tocá "Cambiar token".');
    if (r.status === 403 && /rate limit/i.test(m)) return new Error('GitHub pide esperar un rato (demasiados pedidos). Se reintenta solo.');
    if (r.status === 403) return new Error('El token no tiene permiso para escribir en el repositorio impresoras (Contents: Read and write).');
    if (r.status === 404) return new Error('El token no tiene acceso al repositorio impresoras (al crearlo, elegí ese repositorio).');
    return new Error('GitHub respondió ' + r.status + (m ? ': ' + m : '') + '.');
  }

  async function shaActual(token) {
    var r = await gh(token, 'GET', '/contents/' + RUTA + '?ref=' + RAMA);
    if (r.status === 200 && r.json) return r.json.sha;
    if (r.status === 404) return null;
    throw errorGH(r);
  }

  // La rama "datos" se crea la primera vez (desde main), aparte de la de la app: publicar-celu.ps1 reescribe main.
  async function asegurarRama(token) {
    var r = await gh(token, 'GET', '/branches/' + RAMA);
    if (r.status === 200) return;
    if (r.status !== 404) throw errorGH(r);
    var main = await gh(token, 'GET', '/git/ref/heads/main');
    if (main.status !== 200) throw errorGH(main);
    var c = await gh(token, 'POST', '/git/refs', { ref: 'refs/heads/' + RAMA, sha: main.json.object.sha });
    if (c.status !== 201 && c.status !== 422) throw errorGH(c);     // 422: ya la creó otro pedido
  }

  async function subirArchivo(token, txt) {
    for (var intento = 0; intento < 2; intento++) {
      var sha = await shaActual(token);
      if (!sha) await asegurarRama(token);
      var cuerpo = { message: 'Datos cifrados para el celu', content: btoa(txt), branch: RAMA };
      if (sha) cuerpo.sha = sha;
      var r = await gh(token, 'PUT', '/contents/' + RUTA, cuerpo);
      if (r.status === 200 || r.status === 201) return;
      if (intento === 0 && (r.status === 409 || r.status === 422)) continue;    // cambió en el medio: otra vez con el sha nuevo
      throw errorGH(r);
    }
  }

  async function borrarArchivo(token) {
    var sha = await shaActual(token);
    if (!sha) return;
    var r = await gh(token, 'DELETE', '/contents/' + RUTA, { message: 'Dejar de compartir con el celu', sha: sha, branch: RAMA });
    if (r.status !== 200) throw errorGH(r);
  }

  // Celu: la copia cifrada (primero la API, que está al instante; si falla, raw, que puede tardar unos minutos).
  async function bajarArchivo() {
    try {
      var r = await fetch(API + '/contents/' + RUTA + '?ref=' + RAMA, { headers: { Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' });
      if (r.ok) return r.text();
      if (r.status === 404) throw Object.assign(new Error('La PC todavía no subió los datos. En la PC: menú ⋮ → "Ver en el celu".'), { final: true });
    } catch (e) {
      if (e.final) throw e;
    }
    var r2;
    try { r2 = await fetch(RAW + '?t=' + Date.now(), { cache: 'no-store' }); }
    catch (e) { throw new Error('No hay conexión: se muestran los últimos datos que bajó el celu.'); }
    if (r2.status === 404) throw new Error('La PC todavía no subió los datos. En la PC: menú ⋮ → "Ver en el celu".');
    if (!r2.ok) throw new Error('No se pudieron bajar los datos (GitHub respondió ' + r2.status + ').');
    return r2.text();
  }

  /* ---------- PC: subir cuando cambian los datos ---------- */
  function programarSubida() {
    if (celu || !activo() || !App.Carpeta.alDia()) return;
    clearTimeout(timer);
    timer = setTimeout(function () { subir(false); }, 2500);
  }

  async function subir(manual) {
    var c = leer();
    if (!c.token || !c.codigo) return false;
    if (!App.Carpeta.alDia()) {
      if (manual) UI.toast('Primero autorizá la carpeta (botón de arriba): así se sube lo último de datos.json.', { tipo: 'info', duracion: 8000 });
      return false;
    }
    if (enCurso) { pendiente = true; return enCurso; }
    enCurso = (async function () {
      var d = A.exportar(), firma = A.firma(d);
      if (!manual && firma === c.subido && !c.error) return true;
      estado = 'subiendo'; avisar();
      try {
        var obj = await cifrar({ fecha: new Date().toISOString(), actualizado: d.actualizado, oficinas: d.oficinas }, c.codigo, c.sal);
        await subirArchivo(c.token, JSON.stringify(obj));
        c = leer();
        c.subido = firma; c.fecha = new Date().toISOString(); c.oficinas = d.oficinas.length; delete c.error;
        estado = 'ok';
        guardar(c);
        if (manual) UI.toast('Listo: el celu va a ver estos datos la próxima vez que abras la app.');
        return true;
      } catch (e) {
        c = leer();
        c.error = e.message || 'No se pudo subir.';
        estado = 'error';
        guardar(c);
        if (manual || dlg && dlg.open) UI.toast(esc(c.error), { tipo: 'error', duracion: 9000 });
        return false;
      }
    })();
    try { return await enCurso; }
    finally {
      enCurso = null;
      if (pendiente) { pendiente = false; programarSubida(); }
    }
  }

  async function activar(token) {
    token = String(token || '').trim();
    if (!token) throw new Error('Pegá el token de GitHub.');
    var r = await gh(token, 'GET', '');
    if (r.status !== 200) throw errorGH(r);
    var c = leer();
    if (!c.codigo || !c.sal) {
      c.codigo = nuevoCodigo();
      c.sal = aB64(crypto.getRandomValues(new Uint8Array(16)));
      delete c.subido;
    }
    c.token = token;
    delete c.error;
    guardar(c);
    if (App.Carpeta.alDia()) await subir(false);
  }

  async function desactivar() {
    var c = leer(), err = null;
    if (c.token) { try { await borrarArchivo(c.token); } catch (e) { err = e; } }
    guardar({});
    estado = '';
    return err;
  }

  /* ---------- Celu: bajar los datos de la PC ---------- */
  function plural(n, uno, varios) { return n + ' ' + (n === 1 ? uno : varios); }

  // op.codigo: código nuevo (al conectar); op.manual: lo pidió el usuario (avisar aunque no haya nada nuevo).
  async function bajar(op) {
    op = op || {};
    var c = leer(), codigo = op.codigo || c.codigo;
    if (!codigo) return false;
    if (enCurso) {
      if (!op.codigo) return enCurso;
      try { await enCurso; } catch (e) { /* nada */ }     // termina la revisión de fondo y prueba el código nuevo
    }
    ultimaBajada = Date.now();
    enCurso = (async function () {
      estado = 'bajando'; avisar();
      try {
        var obj;
        try { obj = JSON.parse(await bajarArchivo()); } catch (e) { if (e instanceof SyntaxError) throw new Error('La copia de la PC está dañada: volvé a subirla desde la PC.'); throw e; }
        if (!op.codigo && obj.iv === c.iv && A.hayDatos()) {
          estado = 'ok'; avisar();
          if (op.manual) UI.toast('Ya tenés lo último de la PC.', { tipo: 'info' });
          return true;
        }
        var d = await descifrar(obj, codigo);
        var habia = A.hayDatos();
        var r = A.recibirDatos(d);
        c = leer();
        c.codigo = codigo; c.iv = obj.iv; c.fecha = d.fecha || ''; delete c.error;
        estado = 'ok';
        guardar(c);
        UI.toast((habia ? 'Datos actualizados desde la PC: ' : 'Conectado con la PC: ') + '<b>' + plural(r.oficinas, 'oficina', 'oficinas') + '</b>.');
        if (r.choques.length) {
          UI.toast('También cambiaste en la PC: <b>' + r.choques.map(esc).join(', ') + '</b>. En el celu queda lo tuyo; cuando lo pases, la PC te va a avisar.', { tipo: 'info', duracion: 12000 });
        }
        return true;
      } catch (e) {
        estado = 'error';
        if (op.codigo) { avisar(); throw e; }           // al conectar, el error se muestra junto al campo
        c = leer();
        c.error = e.message;
        guardar(c);
        if (op.manual || e.codigo) UI.toast(esc(e.message), { tipo: 'error', duracion: 9000 });
        return false;
      }
    })();
    try { return await enCurso; } finally { enCurso = null; }
  }

  function bajarSiToca() {
    if (!celu || !activo() || document.visibilityState !== 'visible' || Date.now() - ultimaBajada < 60000) return;
    bajar({});
  }

  function desconectarCelu() {
    guardar({});
    estado = '';
    UI.toast('El celu dejó de bajar los datos de la PC. Los que ya tenía siguen ahí.', { tipo: 'info' });
  }

  /* ---------- Ventana "Ver en el celu" (PC) y "Conectar con la PC" (celu) ---------- */
  function fechaHora(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return '';
    var p = function (n) { return String(n).padStart(2, '0'); };
    var hoy = new Date(), mismoDia = d.toDateString() === hoy.toDateString();
    return (mismoDia ? 'hoy' : p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear()) + ' a las ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function estadoPC() {
    var c = leer(), C = App.Carpeta;
    if (estado === 'subiendo') return { cls: '', txt: 'Subiendo los datos…' };
    if (c.error) return { cls: 'mal', txt: c.error };
    if (!C.alDia()) return { cls: 'warn', txt: 'Esperando la carpeta: autorizala (botón de arriba) para subir lo último de datos.json.' };
    if (c.fecha) return { cls: 'ok', txt: 'Al día: se subió ' + fechaHora(c.fecha) + (c.oficinas != null ? ' (' + plural(c.oficinas, 'oficina', 'oficinas') + ')' : '') + '. Cada cambio se sube solo.' };
    return { cls: '', txt: 'Todavía no se subió nada.' };
  }

  function htmlCodigo() {
    var ic = UI.icono;
    return '<form class="form-codigo" data-form="codigo-celu" novalidate>' +
      '<input class="input-codigo" name="codigo" type="text" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" ' +
      'maxlength="29" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" aria-label="Código de la PC">' +
      '<button class="btn btn-primary" type="submit">' + ic('plug') + 'Conectar</button>' +
      '<p class="error" data-error hidden></p>' +
      '</form>';
  }

  function render() {
    if (!dlg) return;
    var c = leer(), ic = UI.icono, h = '';
    var cerrar = '<button class="icon-btn" type="button" data-cerrar aria-label="Cerrar">' + ic('x') + '</button>';
    if (celu) {
      vista = 'celu';
      h = '<header class="modal-head"><span class="modal-ico">' + ic('smartphone') + '</span><div><h2 id="syncTitulo">Conectar con la PC</h2>' +
        '<p>Así el celu baja solo los datos que cargás en la PC.</p></div>' + cerrar + '</header>' +
        '<div class="modal-body">' +
        '<ol class="pasos"><li>En la PC, abrí el Buscador y tocá menú ⋮ → <b>Ver en el celu</b>.</li><li>Escribí acá el código que aparece:</li></ol>' +
        htmlCodigo() + '</div>';
    } else if (!activo() || vista === 'token') {
      var cambiando = activo();
      vista = cambiando ? 'token' : 'nuevo';
      h = '<header class="modal-head"><span class="modal-ico">' + ic('smartphone') + '</span><div><h2 id="syncTitulo">Ver las impresoras en el celu</h2>' +
        '<p>La app del celu baja sola lo que cargás acá.</p></div>' + cerrar + '</header>' +
        '<form class="contenido" data-form="token" novalidate><div class="modal-body">' +
        (cambiando ? '' : '<p class="sync-explica">Cada vez que cambian los datos, la PC sube una copia <b>cifrada</b> a tu GitHub (repositorio ' +
          '<b>impresoras</b>) y la app del celu la baja al abrirse. Sin el código que te va a dar la PC, nadie puede leerla.</p>') +
        '<ol class="pasos">' +
        '<li><a href="' + URL_TOKEN + '" target="_blank" rel="noopener">Creá un token de GitHub</a>. En <b>Repository access</b> elegí ' +
        '<b>Only select repositories</b> → <b>impresoras</b>; en <b>Permissions</b> → <b>Contents</b>, <b>Read and write</b>; en <b>Expiration</b>, la más larga. ' +
        'Tocá <b>Generate token</b> y copialo.</li>' +
        '<li>Pegalo acá:</li></ol>' +
        '<div class="field"><label for="syncToken">Token de GitHub</label>' +
        '<input id="syncToken" name="token" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…">' +
        '<p class="error" data-error hidden></p>' +
        '<p class="nota">Queda guardado solo en este navegador. Sirve únicamente para subir la copia cifrada a ese repositorio.</p></div></div>' +
        '<footer class="modal-foot sync-pie">' +
        (cambiando ? '<button class="btn btn-ghost" type="button" data-sync="volver">Volver</button>' : '<button class="btn btn-ghost" type="button" data-cerrar>Cancelar</button>') +
        '<button class="btn btn-primary" type="submit">' + (cambiando ? 'Guardar token' : 'Activar') + '</button></footer>' +
        '</form>';
    } else {
      vista = 'activo';
      var e = estadoPC();
      h = '<header class="modal-head"><span class="modal-ico">' + ic('smartphone') + '</span><div><h2 id="syncTitulo">Ver las impresoras en el celu</h2>' +
        '<p>Activado: la app del celu baja sola lo que cargás acá.</p></div>' + cerrar + '</header>' +
        '<div class="modal-body">' +
        '<p class="sync-estado ' + e.cls + '">' + ic(e.cls === 'ok' ? 'check' : e.cls === 'mal' ? 'alert' : 'info') + '<span>' + esc(e.txt) + '</span></p>' +
        '<p>En el celu abrí la app <b>Impresoras</b>, tocá <b>Conectar con la PC</b> y escribí este código:</p>' +
        '<div class="sync-codigo"><code>' + esc(mostrarCodigo(c.codigo)) + '</code>' +
        '<button class="btn btn-ghost" type="button" data-sync="copiar">' + ic('copy') + 'Copiar</button></div>' +
        '<p class="nota">Se escribe una sola vez. Guardalo por si cambiás de celu (si lo perdés: Dejar de compartir y volver a activar, y cambia el código).</p>' +
        '<p class="sync-links"><button class="link-btn" type="button" data-sync="token">Cambiar token</button> · ' +
        '<button class="link-btn peligro" type="button" data-sync="desactivar">Dejar de compartir</button></p>' +
        '</div>' +
        '<footer class="modal-foot sync-pie">' +
        '<button class="btn btn-ghost" type="button" data-sync="subir"' + (estado === 'subiendo' ? ' disabled' : '') + '>' + ic('upload') + 'Subir ahora</button>' +
        '<button class="btn btn-primary" type="button" data-cerrar>Listo</button></footer>';
    }
    var card = dlg.querySelector('.modal-card');
    if (card._html === h) return;
    var foco = document.activeElement && card.contains(document.activeElement) ? document.activeElement.name : '';
    var valores = {};
    card.querySelectorAll('input[name]').forEach(function (i) { valores[i.name] = i.value; });
    card.innerHTML = h;
    card._html = h;
    card.querySelectorAll('input[name]').forEach(function (i) { if (valores[i.name]) i.value = valores[i.name]; });
    if (foco && card.querySelector('[name="' + foco + '"]')) card.querySelector('[name="' + foco + '"]').focus();
  }

  function abrir() {
    if (!dlg) return;
    vista = '';
    dlg.querySelector('.modal-card')._html = '';
    render();
    UI.abrirModal(dlg);
    var campo = dlg.querySelector('input[name]');
    if (campo) setTimeout(function () { campo.focus(); }, 40);
  }

  function mostrarError(form, msg) {
    var p = form.querySelector('[data-error]');
    if (!p) { UI.toast(esc(msg), { tipo: 'error', duracion: 9000 }); return; }
    p.textContent = msg;
    p.hidden = !msg;
  }

  async function enviarForm(form) {
    var tipo = form.getAttribute('data-form');
    var boton = form.querySelector('[type="submit"]');
    mostrarError(form, '');
    if (tipo === 'codigo-celu') {
      var codigo = limpiarCodigo(form.codigo.value);
      if (!codigoValido(codigo)) { mostrarError(form, 'El código tiene ' + LARGO + ' letras y números (los guiones no importan). Revisalo.'); return; }
      boton.disabled = true;
      try {
        await bajar({ codigo: codigo });
        if (dlg && dlg.open) UI.cerrarModal(dlg);
      } catch (e) {
        mostrarError(form, e.message);
      } finally { boton.disabled = false; }
    } else if (tipo === 'token') {
      boton.disabled = true;
      try {
        await activar(form.token.value);
        vista = '';
        render();
      } catch (e) {
        mostrarError(form, e.message);
      } finally { boton.disabled = false; }
    }
  }

  async function accion(a) {
    if (a === 'copiar') {
      var ok = await UI.copiar(mostrarCodigo(leer().codigo || ''));
      UI.toast(ok ? 'Código copiado.' : 'No se pudo copiar: escribilo a mano.', { tipo: ok ? 'ok' : 'error' });
    } else if (a === 'subir') {
      subir(true);
    } else if (a === 'token') {
      vista = 'token'; render();
    } else if (a === 'volver') {
      vista = ''; render();
    } else if (a === 'desactivar') {
      var si = await UI.confirmar({
        titulo: '¿Dejar de compartir con el celu?',
        texto: 'Se borra la copia cifrada de GitHub y la PC deja de subir cambios. El celu se queda con los datos que ya tenía.',
        ok: 'Dejar de compartir'
      });
      if (!si) return;
      var err = await desactivar();
      UI.toast(err ? 'Se dejó de compartir, pero no se pudo borrar la copia de GitHub: ' + esc(err.message) : 'Listo: la PC dejó de compartir con el celu.', { tipo: err ? 'error' : 'info', duracion: err ? 10000 : 5000 });
      if (dlg.open) UI.cerrarModal(dlg);
    }
  }

  /* ---------- Inicio ---------- */
  function init() {
    dlg = document.getElementById('modalSync');
    if (dlg) {
      UI.prepararModal(dlg);
      dlg.addEventListener('click', function (ev) {
        if (ev.target.closest('[data-cerrar]')) { UI.cerrarModal(dlg); return; }
        var b = ev.target.closest('[data-sync]');
        if (b) accion(b.getAttribute('data-sync'));
      });
    }
    // Formularios de esta ventana y el de la bienvenida del celu (está en #empty).
    document.addEventListener('submit', function (ev) {
      var f = ev.target.closest && ev.target.closest('form[data-form="codigo-celu"], form[data-form="token"]');
      if (!f) return;
      ev.preventDefault();
      enviarForm(f);
    });
    escuchas.push(render);
    if (celu) {
      document.addEventListener('visibilitychange', bajarSiToca);
      setInterval(bajarSiToca, 5 * 60000);
      bajarSiToca();
    } else {
      A.alCambiar(programarSubida);
      App.Carpeta.alCambiar(function () { programarSubida(); render(); });
    }
  }

  App.Sync = {
    init: init,
    abrir: abrir,
    activo: activo,
    estado: function () { return estado; },
    info: leer,
    fechaHora: fechaHora,
    htmlCodigo: htmlCodigo,
    bajar: bajar,
    subir: subir,
    desconectarCelu: desconectarCelu,
    alCambiar: function (fn) { escuchas.push(fn); },
    // para las pruebas (Node)
    _cifrar: cifrar, _descifrar: descifrar, _nuevoCodigo: nuevoCodigo, _limpiarCodigo: limpiarCodigo, _codigoValido: codigoValido
  };
})();
