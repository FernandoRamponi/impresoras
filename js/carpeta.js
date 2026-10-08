/* Datos en la carpeta de la web: la página lee y reescribe su propio datos.json (File System Access API,
   disponible en Edge y Chrome). Con doble clic (file://) el navegador no deja leer un .json de otra forma: por eso
   hay que conectar la carpeta una vez, y mientras no se autorice se muestra la última copia leída (ver Almacen).
   Además, cada 30 s (y al volver a la pestaña) se relee datos.json para traer cambios hechos desde otra PC. */
(function () {
  'use strict';
  var App = window.App;
  var A = App.Almacen, UI = App.UI, esc = UI.esc;

  var celu = A.modoCelu();        // en el celu no hay carpeta: los datos llegan de la PC (sync.js / celu.js)
  var soportado = !celu && typeof window.showDirectoryPicker === 'function';
  var dir = null;                 // FileSystemDirectoryHandle de la carpeta de la web
  var estado = celu ? 'celu' : soportado ? 'local' : 'no-soportado';
  // 'celu' | 'no-soportado' | 'local' (sin conectar) | 'conectada' | 'permiso' (reautorizar) | 'guardando' | 'error'
  var detalle = '';
  var escuchas = [];
  var timer = null, enCurso = null, pendiente = false, ultimaRevision = 0;
  var alDia = false;              // ya se leyó datos.json en esta sesión (lo que se ve es lo último de la carpeta)
  var ARCHIVO = 'datos.json';
  var MAX_RESPALDOS = 30;

  function cambiar(e, d) {
    estado = e;
    if (d !== undefined) detalle = d;
    escuchas.forEach(function (fn) { try { fn(estado, detalle); } catch (x) { console.error(x); } });
  }

  /* ---------- Recordar la carpeta elegida (IndexedDB guarda el "handle") ---------- */
  // Una clave por copia de la web: con file:// todas las páginas comparten IndexedDB y, con una sola clave, una copia
  // vieja (ej. la del escritorio, ya borrada) le pasaba su carpeta a la de H: y al guardar no encontraba sus datos.
  var CLAVE = 'carpeta:' + decodeURIComponent(location.host + location.pathname).replace(/[^/]*$/, '').toLowerCase();

  function idb(modo, accion) {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('impresoras', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('handles'); };
      req.onerror = function () { reject(req.error); };
      req.onsuccess = function () {
        var db = req.result, tx = db.transaction('handles', modo);
        var r = accion(tx.objectStore('handles'));
        tx.oncomplete = function () { db.close(); resolve(r && r.result); };
        tx.onerror = tx.onabort = function () { db.close(); reject(tx.error); };
      };
    });
  }
  function recordar(h) { return idb('readwrite', function (s) { return s.put(h, CLAVE); }); }
  function recordada() { return idb('readonly', function (s) { return s.get(CLAVE); }); }
  function olvidar() { return idb('readwrite', function (s) { return s.delete(CLAVE); }); }
  function olvidarClaveVieja() { return idb('readwrite', function (s) { return s.delete('carpeta'); }); }   // la única clave de antes

  /* ---------- Archivos ---------- */
  async function permiso(h, pedir) {
    var op = { mode: 'readwrite' };
    if ((await h.queryPermission(op)) === 'granted') return true;
    return pedir ? (await h.requestPermission(op)) === 'granted' : false;
  }

  async function leerTexto(h, nombre) {
    var archivo = await (await h.getFileHandle(nombre)).getFile();
    return archivo.text();
  }

  async function escribirTexto(h, nombre, txt) {
    var w = await (await h.getFileHandle(nombre, { create: true })).createWritable();
    await w.write(txt);
    await w.close();      // el navegador reemplaza el archivo recién acá (no queda a medio escribir)
  }

  function sello() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds());
  }

  // Copia del datos.json anterior en respaldos/ (se conservan los últimos 30; los .js son de antes del cambio a .json).
  async function respaldar(txtAnterior) {
    var r = await dir.getDirectoryHandle('respaldos', { create: true });
    await escribirTexto(r, 'datos_' + sello() + '.json', txtAnterior);
    var nombres = [];
    for await (var entrada of r.values()) {
      if (entrada.kind === 'file' && /^datos_.*\.(js|json)$/.test(entrada.name)) nombres.push(entrada.name);
    }
    nombres.sort();
    while (nombres.length > MAX_RESPALDOS) await r.removeEntry(nombres.shift());
  }

  // Tras un NotFoundError: 'carpeta' si la carpeta ya no está (se movió, se borró o se renombró),
  // 'datos' si solo falta datos.json y '' si están las dos (falló otro paso del guardado).
  async function queFalta(h) {
    try { await h.getFileHandle(ARCHIVO); return ''; }
    catch (e) { if (!e || e.name !== 'NotFoundError') return ''; }
    try { await h.getFileHandle('index.html'); return 'datos'; }
    catch (e) { return e && e.name === 'NotFoundError' ? 'carpeta' : ''; }
  }

  function mensajeError(e, falta) {
    var n = e && e.name;
    if (n === 'NotFoundError') {
      return falta === 'datos' ? 'No encuentro datos.json en la carpeta conectada (¿se movió o se borró?). Si se borró, recuperalo de la carpeta respaldos.'
        : 'Un archivo desapareció durante el guardado (¿otro programa lo movió o lo borró?).';
    }
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'El navegador no dio permiso para usar la carpeta.';
    if (n === 'NoModificationAllowedError' || n === 'InvalidModificationError') return 'No se puede escribir en esa carpeta (¿es de solo lectura o no tenés permiso?).';
    return (e && e.message) || 'Error desconocido al guardar.';
  }

  /* ---------- Guardar ---------- */
  // Lee el datos.json actual y, si hay cambios de este navegador, se los aplica y lo escribe.
  async function guardarAhora() {
    if (!dir) return false;
    if (enCurso) { pendiente = true; return enCurso; }
    enCurso = (async function () {
      cambiar('guardando');
      try {
        if (!(await permiso(dir, true))) {
          cambiar('permiso', 'Hay que autorizar de nuevo la carpeta.');
          return false;
        }
        var anterior = await leerTexto(dir, ARCHIVO);
        var leido = A.parsearArchivo(anterior);
        if (!A.cambiosLocales()) {        // nada que guardar: solo traer lo que haya, sin reescribir el archivo
          if (A.firma(leido) !== A.firmaBase()) A.reemplazarBase(leido);
        } else {
          var nuevo = A.fusionar(leido);
          var txt = A.serializar(nuevo);
          if (txt !== anterior) {
            await respaldar(anterior);
            await escribirTexto(dir, ARCHIVO, txt);
          }
          A.reemplazarBase(nuevo);        // lo guardado sale de "cambios locales"; lo nuevo de otros entra
        }
        alDia = true;
        cambiar('conectada', dir.name);
        return true;
      } catch (e) {
        console.error(e);
        var falta = e && e.name === 'NotFoundError' ? await queFalta(dir) : '';
        if (falta === 'carpeta') { carpetaPerdida(); return false; }
        cambiar('error', mensajeError(e, falta));
        UI.toast('No se pudo usar la carpeta: ' + esc(mensajeError(e, falta)), { tipo: 'error', duracion: 8000 });
        return false;
      }
    })();
    try {
      return await enCurso;
    } finally {
      enCurso = null;
      if (pendiente) { pendiente = false; programar(); }
    }
  }

  function programar() {
    clearTimeout(timer);
    timer = setTimeout(guardarAhora, 400);
  }

  /* ---------- Conectar / reconectar / desconectar ---------- */
  // Ruta completa de la carpeta de la página cuando se abre con doble clic (ej: H:\web-impresoras).
  function rutaDeLaPagina() {
    if (location.protocol !== 'file:') return '';
    var p = decodeURIComponent(location.pathname).replace(/\/[^/]*$/, '');
    if (location.host) return '\\\\' + location.host + p.replace(/\//g, '\\');      // ruta de red \\servidor\...
    return p.replace(/^\//, '').replace(/\//g, '\\');
  }

  function carpetaDeLaPagina() {
    if (location.protocol !== 'file:') return '';
    var partes = decodeURIComponent(location.pathname).split('/').filter(Boolean);
    return partes.length >= 2 ? partes[partes.length - 2] : '';
  }

  async function validar(h) {
    try { await h.getFileHandle('index.html'); }
    catch (e) { throw new Error('Esa carpeta no tiene index.html. Elegí la carpeta de la web (la que tiene index.html y datos.json).'); }
    var txt;
    try { txt = await leerTexto(h, ARCHIVO); }
    catch (e) { throw new Error('Esa carpeta no tiene datos.json. Elegí la carpeta de la web (la que tiene index.html y datos.json).'); }
    A.parsearArchivo(txt);
  }

  // Usa una carpeta ya elegida (también lo usan las pruebas).
  async function usarCarpeta(h) {
    await validar(h);
    if (!(await permiso(h, true))) throw new Error('Sin permiso no se pueden leer ni guardar los datos de la carpeta.');
    dir = h;
    try { await recordar(h); } catch (e) { /* si no se puede recordar, igual funciona en esta sesión */ }
    return guardarAhora();          // trae lo de datos.json y sube lo pendiente
  }

  async function conectar() {
    if (!soportado) {
      UI.toast('Este navegador no permite leer ni guardar en carpetas. Usá Edge o Chrome.', { tipo: 'error', duracion: 8000 });
      return false;
    }
    var ruta = rutaDeLaPagina();
    var si = await UI.confirmar({
      titulo: 'Conectar la carpeta de la web',
      texto: 'Se va a abrir una ventana para elegir la carpeta de la web. Tiene que ser la misma desde la que la abriste' +
        (ruta ? ': <b>' + esc(ruta) + '</b>' : ' (la que tiene <b>index.html</b> y <b>datos.json</b>)') +
        '. Después tocá <b>Permitir</b> para que la web pueda leer y guardar los datos ahí.',
      ok: 'Elegir carpeta',
      peligro: false
    });
    if (!si) return false;
    var h;
    try {
      h = await window.showDirectoryPicker({ id: 'web-impresoras', mode: 'readwrite' });
    } catch (e) {
      if (e && e.name !== 'AbortError') UI.toast(esc(mensajeError(e)), { tipo: 'error' });
      return false;
    }
    try { await validar(h); }       // primero lo que falta (sin index.html o datos.json no es la carpeta de la web)
    catch (e) {
      UI.toast(esc(e.message || mensajeError(e)), { tipo: 'error', duracion: 8000 });
      return false;
    }
    // ¿Es la carpeta desde la que se abrió la web? (si no, los datos irían a otra copia)
    var esperado = carpetaDeLaPagina();
    if (esperado && h.name !== esperado) {
      var seguro = await UI.confirmar({
        titulo: '¿Es la carpeta correcta?',
        texto: 'La carpeta <b>' + esc(h.name) + '</b> no parece ser desde la que abriste la web (puede ser otra copia).' +
          (ruta ? ' La correcta es <b>' + esc(ruta) + '</b>.' : '') + ' Si usás otra, los datos van a quedar en esa copia.',
        ok: 'Usar igual',
        peligro: false
      });
      if (!seguro) return false;
    }
    try {
      var ok = await usarCarpeta(h);
      if (ok) UI.toast('Listo: los datos se leen y cada cambio se guarda en <b>datos.json</b> de «' + esc(h.name) + '».');
      return ok;
    } catch (e) {
      UI.toast(esc(e.message || mensajeError(e)), { tipo: 'error', duracion: 8000 });
      return false;
    }
  }

  async function reconectar() {
    if (!dir) return conectar();
    try {
      if (await permiso(dir, true)) {
        if ((await queFalta(dir)) === 'carpeta') { carpetaPerdida(); return false; }
        cambiar('conectada', dir.name);
        return guardarAhora();
      }
      cambiar('permiso', 'No se autorizó la carpeta.');
    } catch (e) {
      cambiar('error', mensajeError(e));
    }
    return false;
  }

  async function desconectar() {
    dir = null;
    alDia = false;
    try { await olvidar(); } catch (e) { /* nada */ }
    cambiar('local', '');
  }

  // La carpeta conectada ya no existe: se olvida (si no, al reabrir el navegador pediría permiso para una carpeta
  // que no está y volvería a fallar) y se ofrece conectar la buena. Los cambios siguen guardados en este navegador.
  function carpetaPerdida() {
    if (!dir) return;
    dir = null;
    alDia = false;
    olvidar().catch(function () { /* nada */ });
    cambiar('local', '');
    var ruta = rutaDeLaPagina();
    UI.toast('La carpeta conectada ya no está (se movió, se borró o le cambiaron el nombre). ' +
      (A.cambiosLocales() ? 'Tus cambios siguen guardados en este navegador. ' : '') +
      'Conectá la carpeta de la web' + (ruta ? ': <b>' + esc(ruta) + '</b>' : '') + '.',
      { tipo: 'error', duracion: 12000, accion: { texto: 'Conectar carpeta', fn: conectar } });
  }

  /* ---------- Traer cambios hechos desde otra PC ---------- */
  async function revisarCambiosAjenos() {
    if (!dir || estado !== 'conectada' || document.visibilityState !== 'visible' || enCurso || Date.now() - ultimaRevision < 5000) return;
    ultimaRevision = Date.now();
    try {
      var d = A.parsearArchivo(await leerTexto(dir, ARCHIVO));
      var primera = !alDia;
      alDia = true;
      if (A.firma(d) !== A.firmaBase()) {
        A.reemplazarBase(d);
        // Al abrir la web es normal que haya algo más nuevo que la copia de este navegador: no hace falta avisar.
        if (!primera) UI.toast('Se actualizaron los datos con cambios hechos desde otra PC.', { tipo: 'info' });
      }
      if (primera) cambiar('conectada', dir.name);    // avisa que ya está al día (lo usa Sync para subir la copia del celu)
    } catch (e) { /* sin acceso momentáneo: se reintenta en la próxima revisión */ }
  }

  /* ---------- Inicio ---------- */
  async function init() {
    if (celu) { cambiar('celu'); return; }      // el celu no tiene carpeta: sus datos llegan de la PC
    A.alCambiar(function () {
      if (!A.cambiosLocales()) return;
      if (estado === 'conectada') programar();
      // Si hay que reautorizar, se pide ya: el cambio viene de un clic del usuario y el navegador lo permite.
      else if (estado === 'permiso') reconectar();
    });
    setInterval(revisarCambiosAjenos, 30000);
    document.addEventListener('visibilitychange', revisarCambiosAjenos);
    window.addEventListener('focus', revisarCambiosAjenos);

    if (!soportado) { cambiar('no-soportado'); return; }
    try { await olvidarClaveVieja(); } catch (e) { /* sin IndexedDB */ }
    var h = null;
    try { h = await recordada(); } catch (e) { /* sin IndexedDB */ }
    var esperado = carpetaDeLaPagina();
    if (!h || (esperado && h.name !== esperado)) { cambiar('local', ''); return; }   // nunca conectada, o es de otra copia
    dir = h;
    try {
      if (await permiso(h, false)) {
        if ((await queFalta(h)) === 'carpeta') { carpetaPerdida(); return; }
        cambiar('conectada', h.name);
        if (A.cambiosLocales() > 0) programar();
        else revisarCambiosAjenos();      // traer ya lo último del archivo
      } else {
        cambiar('permiso', 'Tocá para autorizar la carpeta y traer lo último de datos.json.');
      }
    } catch (e) {
      cambiar('error', mensajeError(e));
    }
  }

  App.Carpeta = {
    init: init,
    conectar: conectar,
    reconectar: reconectar,
    desconectar: desconectar,
    guardarAhora: guardarAhora,
    usarCarpeta: usarCarpeta,
    revisarCambiosAjenos: function () { ultimaRevision = 0; return revisarCambiosAjenos(); },
    soportado: function () { return soportado; },
    estado: function () { return estado; },
    detalle: function () { return detalle; },
    nombre: function () { return dir ? dir.name : ''; },
    alDia: function () { return alDia && !!dir; },     // lo que se ve salió de datos.json en esta sesión
    alCambiar: function (fn) { escuchas.push(fn); }
  };
})();
