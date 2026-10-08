/* Celular: la web instalada como app en el celu (PWA), con su propia copia de los datos.
   - En la PC (index.html con doble clic) todo sigue igual; el menú ⋮ suma "Ver en el celu" (sync.js),
     "Pasar datos al celu" (por archivo) y "Traer cambios del celu".
   - En el celu se abre la copia publicada (sin datos: <meta name="copia" content="celu">). Los datos llegan solos
     desde la PC (sync.js) o en un archivo que manda la PC, y quedan guardados en el celu; lo que se cambia ahí vuelve
     a la PC en otro archivo, que la PC aplica sin pisar lo demás (ver Almacen: paqueteCambios, analizarCambios, recibirDatos). */
(function () {
  'use strict';
  var App = window.App;
  var A = App.Almacen, UI = App.UI, esc = UI.esc;

  var celu = A.modoCelu();
  var alElegir = null;        // qué hacer con el archivo que se elija en #inputCelu
  var pedidoInstalar = null;  // evento beforeinstallprompt (Android/Chrome) para instalar con un botón propio

  function plural(n, uno, varios) { return n + ' ' + (n === 1 ? uno : varios); }

  function fecha(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  }

  function sello() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + '-' + p(d.getMinutes());
  }

  function elegirArchivo(fn) {
    var input = document.getElementById('inputCelu');
    alElegir = fn;
    input.value = '';
    input.click();
  }

  function errorArchivo(e) {
    UI.toast(esc((e && e.message) || 'No se pudo leer el archivo.'), { tipo: 'error', duracion: 9000 });
  }

  /* ---------- En el celu ---------- */
  // Llegan los datos de la PC (primera vez o actualización).
  function cargarDatos(txt) {
    var d;
    try { d = A.leerArchivoDatos(txt); } catch (e) { errorArchivo(e); return Promise.resolve(false); }
    var n = (d.oficinas || []).length;
    var actual = A.info().actualizado, nuevo = String(d.actualizado || '');
    var pend = A.sinPasar();
    var si = !A.hayDatos() ? Promise.resolve(true) : UI.confirmar({
      titulo: '¿Actualizar los datos del celu?',
      texto: 'Se cargan las <b>' + plural(n, 'oficina', 'oficinas') + '</b> del archivo' + (nuevo ? ' (del ' + fecha(nuevo) + ')' : '') + '.' +
        (actual && nuevo && nuevo < actual ? ' <b>Ojo:</b> es más viejo que los datos que ya tiene el celu (del ' + fecha(actual) + ').' : '') +
        (pend === 1 ? ' Tu cambio sin pasar a la PC se conserva.' : pend ? ' Tus ' + pend + ' cambios sin pasar a la PC se conservan.' : ''),
      ok: 'Actualizar',
      peligro: false
    });
    return si.then(function (ok) {
      if (!ok) return false;
      var r = A.recibirDatos(d);
      if (!A.puedeGuardar()) {
        UI.toast('No hay lugar en el celu para guardar los datos: se van a perder al cerrar la app.', { tipo: 'error', duracion: 10000 });
        return false;
      }
      UI.toast('Datos al día: <b>' + plural(r.oficinas, 'oficina', 'oficinas') + '</b>' + (nuevo ? ' (del ' + fecha(nuevo) + ')' : '') + '.');
      if (r.choques.length) {
        UI.toast('También cambiaste en la PC: <b>' + r.choques.map(esc).join(', ') + '</b>. En el celu queda lo tuyo; cuando lo pases, la PC te va a avisar.', { tipo: 'info', duracion: 12000 });
      }
      return true;
    });
  }

  function actualizarDatos() { elegirArchivo(cargarDatos); }

  // Manda los cambios hechos en el celu (WhatsApp, mail, Drive…) para cargarlos en la PC.
  function pasarALaPC() {
    var p = A.paqueteCambios();
    if (!p.cambios.length) {
      UI.toast('No hay cambios hechos en el celu para pasar a la PC.', { tipo: 'info' });
      return Promise.resolve(false);
    }
    // .txt: Chrome en Android no deja compartir archivos .json (y los mails no bloquean .txt).
    var nombre = 'cambios-impresoras-celu-' + sello() + '.txt';
    var txt = JSON.stringify(p, null, 2);
    function listo(descargado) {
      A.marcarEnviado(p);
      UI.toast((descargado ? 'Se descargó el archivo con ' : 'Listo: mandaste ') + plural(p.cambios.length, 'cambio', 'cambios') +
        '. En la PC: abrí el Buscador y tocá menú ⋮ → <b>Traer cambios del celu</b>.', { duracion: 12000 });
      return true;
    }
    function descargar() {
      UI.descargar(nombre, txt, 'text/plain');
      return listo(true);
    }
    var archivo = null;
    try { archivo = new File([txt], nombre, { type: 'text/plain' }); } catch (e) { /* navegador viejo */ }
    if (archivo && navigator.canShare && navigator.canShare({ files: [archivo] })) {
      return navigator.share({ files: [archivo], title: 'Cambios de impresoras' }).then(function () { return listo(false); }, function (e) {
        if (e && e.name === 'AbortError') return false;     // cerró la ventana de compartir
        return descargar();
      });
    }
    return Promise.resolve(descargar());
  }

  /* ---------- Instalar como app ---------- */
  var escuchas = [];
  var recienInstalada = false;  // se instaló desde esta pestaña: falta abrirla desde el ícono
  var sinInstalar = false;      // eligió seguir en el navegador (mientras esté abierta)

  function avisar() { escuchas.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } }); }

  function instalada() {
    return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  }

  function esIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  // Cómo se instala en este navegador: 'instalada' (ya se abrió como app), 'boton' (Chrome ofrece instalar con un
  // botón propio), 'webview' (navegador de WhatsApp, Instagram…: no instala, hay que abrir el link en Chrome o
  // Safari), 'ios' (Safari: Compartir → Agregar a inicio) o 'menu' (menú del navegador → Instalar app).
  function comoInstalar() {
    if (instalada()) return 'instalada';
    if (pedidoInstalar) return 'boton';
    if (/; wv\)|FBAN|FBAV|Instagram|WhatsApp|Line\//i.test(navigator.userAgent)) return 'webview';
    return esIOS() ? 'ios' : 'menu';
  }

  function instalar() {
    if (pedidoInstalar) {
      var ev = pedidoInstalar;
      pedidoInstalar = null;
      ev.prompt();
      if (ev.userChoice) ev.userChoice.then(function (r) { if (r && r.outcome === 'dismissed') { pedidoInstalar = null; avisar(); } });
      avisar();
      return;
    }
    UI.toast(esIOS()
      ? 'En el iPhone: tocá <b>Compartir</b> (el cuadrado con la flecha) → <b>Agregar a inicio</b>.'
      : 'Abrí el menú del navegador (⋮) y tocá <b>Instalar app</b>.', { tipo: 'info', duracion: 12000 });
  }

  // Pantalla de bienvenida del celu sin datos: primero instalar la app, después cargar los datos ADENTRO de la app
  // (en iPhone, Safari y la app instalada guardan los datos por separado).
  function bienvenida() {
    var ic = UI.icono, como = comoInstalar();
    if (recienInstalada && como !== 'instalada') {
      return '<div class="empty-art">' + ic('check') + '</div>' +
        '<h2>¡Listo, ya está instalada!</h2>' +
        '<p>Cerrá el navegador y abrí la app desde el ícono <b>Impresoras</b> de tu celu. Ahí cargás los datos.</p>';
    }
    if (como === 'instalada' || sinInstalar) {
      // Los datos llegan solos desde la PC (sync.js): basta con escribir una vez el código que muestra la PC.
      var S = App.Sync;
      if (S.activo() && S.estado() === 'bajando') {
        return '<div class="empty-art">' + ic('loader') + '</div>' +
          '<h2>Bajando los datos de la PC…</h2>';
      }
      return '<div class="empty-art">' + ic('plug') + '</div>' +
        '<h2>Conectá con la PC</h2>' +
        '<ol class="pasos">' +
        '<li>En la PC, abrí el Buscador y tocá menú ⋮ → <b>Ver en el celu</b>.</li>' +
        '<li>Escribí acá el código que aparece (una sola vez: después los datos llegan solos).</li>' +
        '</ol>' +
        S.htmlCodigo() +
        '<p class="pasos-nota"><button class="link-btn" type="button" data-accion="cargar-celu">O cargá un archivo que mandó la PC</button>' +
        (como === 'instalada' ? '' : ' · <button class="link-btn" type="button" data-accion="instalar">Instalar la app</button>') + '</p>';
    }
    var pasos = {
      boton: '<button class="btn btn-primary" type="button" data-accion="instalar">' + ic('smartphone') + 'Instalar app</button>',
      webview: '<p class="aviso-celu">Lo abriste dentro de otra app (WhatsApp, Instagram…), que no deja instalarla. ' +
        'Tocá su menú (<b>⋮</b> o <b>…</b>) y elegí <b>Abrir en Chrome</b> (en iPhone, <b>Abrir en Safari</b>).</p>',
      ios: '<ol class="pasos">' +
        '<li>Tocá <b>Compartir</b> (el cuadrado con la flecha hacia arriba).</li>' +
        '<li>Elegí <b>Agregar a inicio</b> y después <b>Agregar</b>.</li>' +
        '<li>Abrí la app desde el ícono <b>Impresoras</b> y cargá los datos ahí (Safari y la app no comparten los datos).</li>' +
        '</ol>',
      menu: '<ol class="pasos">' +
        '<li>Tocá el menú <b>⋮</b> de Chrome (arriba a la derecha).</li>' +
        '<li>Elegí <b>Instalar app</b>. Si solo aparece "Agregar a la pantalla principal", recargá la página, esperá unos segundos y volvé a mirar.</li>' +
        '<li>Abrí la app desde el ícono <b>Impresoras</b>.</li>' +
        '</ol>'
    }[como];
    return '<div class="empty-art">' + ic('smartphone') + '</div>' +
      '<h2>Instalá la app en el celu</h2>' +
      '<p>Queda con su ícono entre tus apps, se abre sin la barra del navegador y funciona sin señal.</p>' + pasos +
      '<p class="pasos-nota"><button class="link-btn" type="button" data-accion="sin-instalar">Seguir sin instalar</button></p>';
  }

  function seguirSinInstalar() { sinInstalar = true; avisar(); }

  function registrarApp() {
    // Solo en la copia publicada (https): con doble clic (file://) Chrome no deja leer el manifiesto ni usar un
    // service worker, y en la PC tampoco hace falta.
    var l = document.createElement('link');
    l.rel = 'manifest';
    l.href = 'manifest.webmanifest';
    document.head.appendChild(l);
    var v = document.querySelector('meta[name="version"]'), mv = document.getElementById('menuVersion');
    if (v && mv) mv.textContent = 'Versión ' + v.content;
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      // Si ya había una versión y llega una nueva, recargar una vez para verla ya (no recién en la próxima apertura).
      var habia = !!navigator.serviceWorker.controller, recargada = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!habia || recargada || document.querySelector('dialog[open]')) return;
        recargada = true;
        location.reload();
      });
      navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('Sin modo sin conexión:', e); });
    }
    // Que el celu no borre los datos para liberar espacio (Android lo concede a las apps instaladas).
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () { /* nada */ });
    window.addEventListener('beforeinstallprompt', function (ev) {
      ev.preventDefault();      // en vez del cartelito de Chrome, el botón grande de la bienvenida (y el menú ⋮)
      pedidoInstalar = ev;
      avisar();
    });
    window.addEventListener('appinstalled', function () {
      pedidoInstalar = null;
      recienInstalada = true;
      var mi = document.getElementById('miInstalar');
      if (mi) mi.hidden = true;
      avisar();
    });
  }

  /* ---------- En la PC ---------- */
  function pasarDatosAlCelu() {
    var d = A.exportar();
    UI.descargar('impresoras-para-el-celu-' + d.actualizado + '.json', JSON.stringify(d, null, 2));
    UI.toast('Se descargó el archivo para el celu (' + plural(d.oficinas.length, 'oficina', 'oficinas') + '). Mandátelo (WhatsApp, mail o Drive) ' +
      'y en la app del celu tocá menú ⋮ → <b>Actualizar datos</b>.', { duracion: 12000 });
  }

  var ETIQUETA = { nueva: 'Nueva', editada: 'Cambiada', borrada: 'Borrada' };

  // Llegan los cambios del celu: se muestran, y al confirmar se guardan como cualquier cambio hecho en la PC
  // (con la carpeta conectada van directo a datos.json). Deshacer deja cada oficina como estaba.
  function aplicarPaquete(txt) {
    var items;
    try { items = A.analizarCambios(A.leerPaquete(txt)); } catch (e) { errorArchivo(e); return Promise.resolve(false); }
    var aplicar = items.filter(function (x) { return !x.igual; });
    if (!aplicar.length) {
      UI.toast('Esos cambios del celu ya estaban en la PC: no hay nada nuevo.', { tipo: 'info' });
      return Promise.resolve(false);
    }
    var choques = aplicar.filter(function (x) { return x.choque; }).length;
    var ya = items.length - aplicar.length;
    var lista = aplicar.map(function (x) {
      return '<span class="lc-item' + (x.choque ? ' choque' : '') + '"><b>' + ETIQUETA[x.tipo] + ':</b> ' + esc(x.nombre) +
        (x.choque ? '<small>También la cambiaste en la PC: queda la versión del celu.</small>' : '') + '</span>';
    }).join('');
    return UI.confirmar({
      titulo: 'Traer cambios del celu',
      texto: 'Del celu ' + (aplicar.length === 1 ? 'llega ' : 'llegan ') + plural(aplicar.length, 'cambio', 'cambios') + ':<span class="lista-cambios">' + lista + '</span>' +
        (ya ? '<small class="lc-nota">' + plural(ya, 'cambio ya estaba', 'cambios ya estaban') + ' en la PC.</small>' : '') +
        (choques ? '<small class="lc-nota">Si preferís lo de la PC, después tocá <b>Deshacer</b>.</small>' : ''),
      ok: 'Traer cambios',
      peligro: false
    }).then(function (si) {
      if (!si) return false;
      var previas = aplicar.filter(function (x) { return x.actual; }).map(function (x) { return x.actual; });
      var nuevas = aplicar.filter(function (x) { return !x.actual; }).map(function (x) { return x.id; });
      A.guardarVarias(
        aplicar.filter(function (x) { return x.oficina; }).map(function (x) { return x.oficina; }),
        aplicar.filter(function (x) { return !x.oficina; }).map(function (x) { return x.id; })
      );
      UI.toast((aplicar.length === 1 ? 'Se cargó ' : 'Se cargaron ') + plural(aplicar.length, 'cambio', 'cambios') + ' del celu.', {
        duracion: 9000,
        accion: { texto: 'Deshacer', fn: function () { A.guardarVarias(previas, nuevas); } }
      });
      return true;
    });
  }

  function traerCambios() { elegirArchivo(aplicarPaquete); }

  /* ---------- Inicio ---------- */
  function init() {
    document.body.classList.toggle('modo-celu', celu);
    var input = document.getElementById('inputCelu');
    input.addEventListener('change', function () {
      var f = input.files && input.files[0], fn = alElegir;
      if (!f || !fn) return;
      var lector = new FileReader();
      lector.onload = function () { fn(String(lector.result)); };
      lector.onerror = function () { errorArchivo(lector.error); };
      lector.readAsText(f);
    });
    if (!celu) return;
    registrarApp();
    var mi = document.getElementById('miInstalar');
    if (mi) mi.hidden = instalada();
  }

  App.Celu = {
    init: init,
    activo: function () { return celu; },
    instalada: instalada,
    comoInstalar: comoInstalar,
    bienvenida: bienvenida,
    seguirSinInstalar: seguirSinInstalar,
    alCambiar: function (fn) { escuchas.push(fn); },
    actualizarDatos: actualizarDatos,
    cargarDatos: cargarDatos,
    pasarALaPC: pasarALaPC,
    instalar: instalar,
    pasarDatosAlCelu: pasarDatosAlCelu,
    traerCambios: traerCambios,
    aplicarPaquete: aplicarPaquete
  };
})();
