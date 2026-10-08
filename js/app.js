/* Aplicación: búsqueda en vivo, tarjetas de oficinas, acciones y menú. */
(function () {
  'use strict';
  var App = window.App;
  var B = App.Busqueda, A = App.Almacen, UI = App.UI;
  var $ = UI.$, icono = UI.icono, esc = UI.esc;

  var MAX_VISIBLES = 5;   // con más impresoras se muestran 4 y un botón "Ver N más"
  var CAMPOS = {           // campos conocidos de impresora: etiqueta + ícono
    hostname: { etq: 'Host', ico: 'server' },
    mac: { etq: 'MAC', ico: 'hash' },
    serie: { etq: 'Serie', ico: 'barcode' },
    inventario: { etq: 'Inventario', ico: 'tag' },
    patrimonio: { etq: 'Patrimonio', ico: 'tag' },
    sector: { etq: '', ico: 'pin' },
    ubicacion: { etq: '', ico: 'pin' },
    tipo: { etq: '', ico: 'layers' },
    conexion: { etq: 'Conexión', ico: 'plug' },
    cola: { etq: 'Cola', ico: 'network' }
  };
  var ORDEN = ['hostname', 'mac', 'serie', 'inventario', 'patrimonio', 'sector', 'ubicacion', 'tipo', 'conexion', 'cola'];
  var COPIABLES = { hostname: 'host', mac: 'MAC', serie: 'N° de serie' };
  var NO_CHIP = new Set(['marca', 'modelo', 'nombre', 'ip', 'notas', 'observaciones', 'estado']);
  var CAMPOS_OFICINA = new Set(['id', 'nombre', 'alias', 'edificio', 'ubicacion', 'impresoras', '_origen']);

  var consulta = B.parsear('');
  var expandidas = new Set();
  var tarjetas = new Map();
  var divisor = null;
  var mostrarOtras = false;   // coincidencias secundarias (por piso, impresoras…) cuando ya hay por nombre
  var filtroUbic = '';        // filtro rápido por ubicación (clave normalizada), '' = todas
  var filtroEdif = '';        // filtro rápido por edificio (clave normalizada), '' = todos, SIN_EDIF = sin edificio
  var SIN_EDIF = '~sin';
  var ultimoFiltros = '', ultimoFiltrosEdif = '';
  var primerRender = true;
  var ultimoVacio = '';
  var timerBusqueda = null;
  var enfoque = { id: null, imp: null };  // tarjeta enfocada con un clic y, dentro de ella, la impresora (doble enfoque)
  var seleccionando = false;  // modo "Seleccionar varias": elegir oficinas para asignarles un edificio de una vez
  var seleccion = new Set();  // ids elegidos (pueden quedar fuera de la vista por un filtro o la búsqueda)

  /* ---------- Helpers de datos ---------- */
  function titulo(p) {
    var marca = String(p.marca || '').trim(), modelo = String(p.modelo || '').trim();
    if (marca && modelo && B.normalizar(modelo).indexOf(B.normalizar(marca)) === 0) return modelo;
    return [marca, modelo].filter(Boolean).join(' ') || String(p.nombre || '') || 'Impresora';
  }

  function etiquetaCampo(k) {
    var s = k.replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function totalImpresoras(lista) {
    return lista.reduce(function (n, o) { return n + (o.impresoras || []).length; }, 0);
  }

  function plural(n, uno, varios) { return n + ' ' + (n === 1 ? uno : varios); }

  function esSede(nombre) {
    return /juzg|tribunal|camara|fiscal|defensor|asesor|sala|corte/.test(B.normalizar(nombre));
  }

  function ipCompleta(ip) {
    var o = String(ip).split('.');
    return o.length === 4 && o.every(function (x) { return /^\d{1,3}$/.test(x) && Number(x) <= 255; });
  }

  // Link al panel web: solo con IP completa o nombre de host válido.
  function hrefPanel(ip) {
    ip = String(ip || '').trim();
    if (ipCompleta(ip)) return 'http://' + ip + '/';
    return /[a-z]/i.test(ip) && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(ip) ? 'http://' + ip + '/' : '';
  }

  function botonCopiar(valor, que) {
    return '<button class="chip-btn" type="button" data-copiar="' + esc(valor) + '" title="Copiar ' + esc(que) + '" aria-label="Copiar ' + esc(que) + ' ' + esc(valor) + '">' + icono('copy') + '</button>';
  }

  /* ---------- HTML de tarjetas ---------- */
  function htmlImpresora(p, match, idx) {
    var q = consulta, chips = '';
    if (p.ip) {
      var ip = String(p.ip).trim();
      if (/^[\d.]+$/.test(ip) && !ipCompleta(ip)) {
        chips += '<span class="chip chip-ip chip-warn" title="La IP está incompleta o mal escrita en los datos: revisala y corregila con Editar">' +
          icono('alert') + '<span>' + B.resaltarIp(ip, q) + '</span><b>incompleta</b></span>';
      } else {
        var href = hrefPanel(ip);
        chips += '<span class="chip chip-ip">' + icono('network') + '<span>' + B.resaltarIp(ip, q) + '</span>' + botonCopiar(ip, 'IP') +
          (href ? '<a class="chip-btn" href="' + esc(href) + '" target="_blank" rel="noopener" title="Abrir el panel web de la impresora" aria-label="Abrir panel web">' + icono('external') + '</a>' : '') +
          '</span>';
      }
    }
    if (p.estado) {
      var e = B.normalizar(p.estado);
      var cls = /fuera|baja|rota|falla|sin servicio|no funciona|reparac/.test(e) ? 'estado-mal'
        : /activa|ok|funciona|operativa|en uso/.test(e) ? 'estado-ok' : '';
      chips += '<span class="chip ' + cls + '"><span class="estado-dot"></span>' + B.resaltar(p.estado, q) + '</span>';
    }
    var claves = ORDEN.filter(function (k) { return k in p; })
      .concat(Object.keys(p).filter(function (k) { return ORDEN.indexOf(k) === -1; }));
    claves.forEach(function (k) {
      if (NO_CHIP.has(k) || k.charAt(0) === '_') return;
      var v = p[k];
      if (v == null || v === '' || typeof v === 'object') return;
      var c = CAMPOS[k];
      var etq = c ? c.etq : etiquetaCampo(k);
      var copiable = COPIABLES[k];
      chips += '<span class="chip' + (copiable ? ' chip-mono' : '') + '">' + icono(c ? c.ico : 'tag') + (etq ? '<b>' + esc(etq) + '</b>' : '') +
        '<span>' + (k === 'mac' ? B.resaltarMac(v, q) : B.resaltar(v, q)) + '</span>' +
        (copiable ? botonCopiar(v, copiable) : '') + '</span>';
    });
    var notas = p.notas || p.observaciones;
    return '<li class="prow' + (match ? ' match' : '') + '" data-p="' + idx + '">' +
      '<span class="p-ico">' + icono('printer') + '</span>' +
      '<div class="p-main">' +
      '<div class="p-title">' + B.resaltar(titulo(p), q) + '</div>' +
      (chips ? '<div class="p-chips">' + chips + '</div>' : '') +
      (notas ? '<div class="p-notas">' + B.resaltar(notas, q) + '</div>' : '') +
      '</div></li>';
  }

  function htmlTarjeta(r) {
    var o = r.oficina, q = consulta;
    var ps = o.impresoras || [];
    var meta = '';
    if (o.edificio) meta += '<span>' + icono('building') + B.resaltar(o.edificio, q) + '</span>';
    if (o.ubicacion) meta += '<span>' + icono('pin') + B.resaltar(o.ubicacion, q) + '</span>';
    if (o.alias && o.alias.length) meta += '<span class="alias">' + icono('tag') + B.resaltar(o.alias.join(' · '), q) + '</span>';
    Object.keys(o).forEach(function (k) {
      if (CAMPOS_OFICINA.has(k)) return;
      var v = o[k];
      if (v == null || v === '' || typeof v === 'object') return;
      meta += '<span><b>' + esc(etiquetaCampo(k)) + ':</b>&nbsp;' + B.resaltar(v, q) + '</span>';
    });
    if (o._origen === 'nueva') meta += '<span class="pill pill-new" title="Agregada en este navegador">Nueva</span>';
    if (o._origen === 'editada') meta += '<span class="pill pill-mod" title="Modificada en este navegador">Editada</span>';

    var hayOcultaQueCoincide = false;
    r.impresorasMatch.forEach(function (i) { if (i >= MAX_VISIBLES - 1) hayOcultaQueCoincide = true; });
    var abierta = expandidas.has(o.id) || hayOcultaQueCoincide;
    var limite = ps.length > MAX_VISIBLES && !abierta ? MAX_VISIBLES - 1 : ps.length;

    var lista = ps.length
      ? '<ul class="plist">' + ps.slice(0, limite).map(function (p, i) { return htmlImpresora(p, r.impresorasMatch.has(i), i); }).join('') + '</ul>'
      : '<p class="sin-impresoras">Sin impresoras cargadas todavía.</p>';
    var verMas = '';
    if (ps.length > MAX_VISIBLES && !hayOcultaQueCoincide) {
      verMas = '<button class="ver-mas" type="button" data-accion="ver-mas" aria-expanded="' + abierta + '">' +
        (abierta ? 'Ver menos' : 'Ver ' + (ps.length - limite) + ' más') + icono('chevron') + '</button>';
    }

    return '<div class="card-head">' +
      (seleccionando ? '<label class="sel-check" title="Seleccionar"><input type="checkbox" data-sel aria-label="Seleccionar ' + esc(o.nombre) + '">' +
        '<span class="sel-caja">' + icono('check') + '</span></label>' : '') +
      '<span class="card-ico">' + icono(esSede(o.nombre) ? 'landmark' : 'building') + '</span>' +
      '<div class="card-title"><h3>' + B.resaltar(o.nombre, q) + '</h3>' +
      (meta ? '<div class="card-meta">' + meta + '</div>' : '') + '</div>' +
      '<span class="count" title="' + plural(ps.length, 'impresora', 'impresoras') + '">' + icono('printer') + ps.length + '</span>' +
      '</div>' + lista + verMas +
      '<div class="card-foot">' +
      '<button class="foot-btn" type="button" data-accion="copiar" title="Copiar los datos de esta oficina">' + icono('copy') + '<span>Copiar</span></button>' +
      '<button class="foot-btn" type="button" data-accion="editar" title="Editar oficina e impresoras">' + icono('pencil') + '<span>Editar</span></button>' +
      '<button class="foot-btn danger" type="button" data-accion="eliminar" title="Eliminar oficina">' + icono('trash') + '<span>Eliminar</span></button>' +
      '</div>';
  }

  function textoOficina(o) {
    var ls = [o.nombre];
    if (o.edificio) ls.push('Edificio: ' + o.edificio);
    if (o.ubicacion) ls.push('Ubicación: ' + o.ubicacion);
    var ps = o.impresoras || [];
    ls.push('Impresoras (' + ps.length + '):');
    ps.forEach(function (p) {
      var partes = [titulo(p)];
      if (p.ip) partes.push('IP ' + p.ip);
      if (p.hostname) partes.push('Host ' + p.hostname);
      if (p.mac) partes.push('MAC ' + p.mac);
      if (p.serie) partes.push('Serie ' + p.serie);
      if (p.sector) partes.push(p.sector);
      if (p.conexion) partes.push('Conexión ' + p.conexion);
      if (p.estado) partes.push(p.estado);
      ls.push('• ' + partes.join(' — '));
    });
    return ls.join('\n');
  }

  /* ---------- Render ---------- */
  function quitarEntrada(el) {
    var listo = false;
    function fin() {
      if (listo) return;
      listo = true;
      el.classList.remove('enter');
      el.style.removeProperty('--i');
    }
    el.addEventListener('animationend', function h(ev) {
      if (ev.target === el && ev.animationName === 'entrar') { el.removeEventListener('animationend', h); fin(); }
    });
    setTimeout(fin, 1300);
  }

  // Si hay coincidencias por nombre, las secundarias (por piso, sector, impresoras) van plegadas.
  function contarOtras(res) {
    var hay1 = res.some(function (r) { return r.tier === 1; });
    return hay1 ? res.filter(function (r) { return r.tier === 2; }).length : 0;
  }

  function elDivisor(n) {
    if (!divisor) {
      divisor = document.createElement('button');
      divisor.type = 'button';
      divisor.className = 'divisor';
      divisor.setAttribute('data-accion', 'otras');
    }
    var html = '<span>' + (mostrarOtras ? 'Otras coincidencias' : 'Ver ' + plural(n, 'coincidencia más', 'coincidencias más')) + '</span>' +
      '<small>por ubicación o impresoras</small>' + icono('chevron');
    divisor.setAttribute('aria-expanded', String(mostrarOtras));
    if (divisor._html !== html) { divisor.innerHTML = html; divisor._html = html; }
    return divisor;
  }

  function renderLista(res) {
    var cont = $('#results');
    var animar = !primerRender && !UI.movimientoReducido() && document.visibilityState === 'visible';
    var antes = new Map();
    if (animar) tarjetas.forEach(function (el, id) { antes.set(id, el.getBoundingClientRect()); });

    var otras = contarOtras(res);
    var orden = [], siguiente = new Map(), nuevas = 0, conDivisor = false;

    res.forEach(function (r) {
      if (otras && r.tier === 2) {
        if (!conDivisor) { orden.push(elDivisor(otras)); conDivisor = true; }
        if (!mostrarOtras) return;
      }
      var id = r.oficina.id, html = htmlTarjeta(r), el = tarjetas.get(id);
      if (!el) {
        el = document.createElement('article');
        el.className = 'card enter';
        el.setAttribute('data-id', id);
        el.style.setProperty('--i', Math.min(nuevas++, 10));
        el.innerHTML = html;
        el._html = html;
        quitarEntrada(el);
      } else if (el._html !== html) {
        el.innerHTML = html;
        el._html = html;
      }
      siguiente.set(id, el);
      orden.push(el);
    });

    tarjetas.forEach(function (el, id) { if (!siguiente.has(id)) el.remove(); });
    tarjetas = siguiente;

    // Ubica los nodos en orden moviendo lo mínimo.
    var actual = cont.firstElementChild;
    orden.forEach(function (el) {
      if (el === actual) actual = actual.nextElementSibling;
      else cont.insertBefore(el, actual);
    });
    while (actual) { var sig = actual.nextElementSibling; actual.remove(); actual = sig; }

    // FLIP: las tarjetas que quedan se deslizan a su nueva posición.
    if (animar) {
      tarjetas.forEach(function (el, id) {
        var a = antes.get(id);
        if (!a) return;
        var b = el.getBoundingClientRect(), dx = a.left - b.left, dy = a.top - b.top;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          el.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }],
            { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' });
        }
      });
    }
    primerRender = false;
  }

  /* ---------- Filtros rápidos por edificio y por piso (ej: Piso 6 / Piso 7) ---------- */
  // Clave para agrupar: sin tildes, mayúsculas ni signos ("Tacuarí 138" = "tacuari, 138").
  function clave(o, campo) { return B.normalizar(String(o[campo] || '')).replace(/[^a-z0-9]+/g, ' ').trim(); }
  function claveUbic(o) { return clave(o, 'ubicacion'); }
  function claveEdif(o) { return clave(o, 'edificio') || SIN_EDIF; }

  // Valores distintos del campo y cuántas oficinas tiene cada uno, ordenados por nombre.
  function grupos(lista, campo) {
    var mapa = new Map();
    lista.forEach(function (o) {
      var k = clave(o, campo);
      if (!k) return;
      var e = mapa.get(k) || { k: k, etq: String(o[campo]).trim(), n: 0 };
      e.n++;
      mapa.set(k, e);
    });
    return Array.from(mapa.values()).sort(function (a, b) { return B.comparar(a.etq, b.etq); });
  }

  // Botones de edificio: aparecen apenas una oficina tiene edificio; las que no tienen van a "Sin edificio".
  function edificios(todas) {
    var es = grupos(todas, 'edificio');
    var sin = es.length ? todas.filter(function (o) { return claveEdif(o) === SIN_EDIF; }).length : 0;
    if (sin) es.push({ k: SIN_EDIF, etq: 'Sin edificio', n: sin });
    return es;
  }

  function delEdificio(todas) {
    return filtroEdif ? todas.filter(function (o) { return claveEdif(o) === filtroEdif; }) : todas;
  }

  // Lo que se está mirando, para los textos: " en <b>Tacuarí 138 · Piso 7</b>", " <b>sin edificio</b>"… ('' sin filtros).
  function textoDonde(todas) {
    var es = edificios(todas).filter(function (e) { return e.k === filtroEdif && e.k !== SIN_EDIF; });
    var us = grupos(delEdificio(todas), 'ubicacion').filter(function (u) { return u.k === filtroUbic; });
    var partes = es.concat(us).map(function (x) { return x.etq; });
    return (filtroEdif === SIN_EDIF ? ' <b>sin edificio</b>' : '') + (partes.length ? ' en <b>' + esc(partes.join(' · ')) + '</b>' : '');
  }

  function botonFiltro(attr, k, etq, n, ico, on) {
    return '<button class="filtro' + (on ? ' activo' : '') + '" type="button" ' + attr + '="' + esc(k) + '" aria-pressed="' + on + '">' +
      (ico ? icono(ico) : '') + esc(etq) + ' <span>' + n + '</span></button>';
  }

  function renderFiltros(todas) {
    var es = edificios(todas);
    if (filtroEdif && !es.some(function (e) { return e.k === filtroEdif; })) filtroEdif = '';
    var htmlEdif = !es.length ? '' : botonFiltro('data-edif', '', 'Todos los edificios', todas.length, 'building', !filtroEdif) +
      es.map(function (e) { return botonFiltro('data-edif', e.k, e.etq, e.n, e.k === SIN_EDIF ? '' : 'building', filtroEdif === e.k); }).join('');
    var elEdif = $('#filtrosEdif');
    elEdif.hidden = !htmlEdif;
    if (htmlEdif !== ultimoFiltrosEdif) { elEdif.innerHTML = htmlEdif; ultimoFiltrosEdif = htmlEdif; }

    // Pisos del edificio elegido (o de todos).
    var enEdif = delEdificio(todas), us = grupos(enEdif, 'ubicacion');
    var hay = us.length >= 2 && us.length <= 12;
    if (filtroUbic && (!hay || !us.some(function (u) { return u.k === filtroUbic; }))) filtroUbic = '';
    var html = !hay ? '' : botonFiltro('data-ubic', '', 'Todos los pisos', enEdif.length, '', !filtroUbic) +
      us.map(function (u) { return botonFiltro('data-ubic', u.k, u.etq, u.n, 'pin', filtroUbic === u.k); }).join('');
    var el = $('#filtros');
    el.hidden = !html;
    if (html !== ultimoFiltros) { el.innerHTML = html; ultimoFiltros = html; }
  }

  function renderResumen(res, todas, base) {
    var el = $('#resumen');
    var donde = textoDonde(todas);
    if (consulta.vacia) {
      el.innerHTML = base.length
        ? '<b>' + plural(base.length, 'oficina', 'oficinas') + '</b>' + donde + ' con <b>' + plural(totalImpresoras(base), 'impresora', 'impresoras') + '</b>. Escribí para filtrar.'
        : '';
      return;
    }
    if (!res.length) { el.innerHTML = 'Sin resultados' + donde + '.'; return; }
    var otras = contarOtras(res);
    var vis = otras && !mostrarOtras ? res.filter(function (r) { return r.tier === 1; }) : res;
    var imps = vis.reduce(function (n, r) { return n + (r.oficina.impresoras || []).length; }, 0);
    el.innerHTML = '<b>' + plural(vis.length, 'oficina', 'oficinas') + '</b> ' + (vis.length === 1 ? 'coincide' : 'coinciden') +
      ' con «' + esc(consulta.texto) + '»' + donde + ' · ' + plural(imps, 'impresora', 'impresoras');
  }

  function renderVacio(res, todas) {
    var el = $('#empty');
    var html = '';
    // Celu todavía sin datos: el buscador no sirve, que la bienvenida (instalar / cargar datos) entre en la pantalla.
    document.body.classList.toggle('celu-vacio', A.modoCelu() && !todas.length);
    if (!res.length) {
      var est = App.Carpeta.estado();
      if (!todas.length && A.modoCelu()) {
        html = App.Celu.bienvenida();     // primero instalar la app, después cargar los datos
      } else if (!todas.length && !App.Carpeta.alDia() && est !== 'no-soportado') {
        // Con doble clic el navegador no deja leer datos.json solo: hay que conectar (o autorizar) la carpeta.
        var autorizar = est !== 'local' && App.Carpeta.nombre();
        var leyendo = est === 'guardando' || est === 'conectada';
        html = '<div class="empty-art">' + icono(leyendo ? 'loader' : 'folder') + '</div>' +
          (leyendo ? '<h2>Leyendo datos.json…</h2>'
            : '<h2>' + (autorizar ? 'Autorizá la carpeta para ver las impresoras' : 'Conectá la carpeta de la web') + '</h2>' +
              '<p>Los datos están en <b>datos.json</b>, en la carpeta de la web. ' +
              (autorizar ? 'El navegador pide permiso de nuevo para leerla.' : 'El navegador necesita permiso para leerla (se hace una sola vez en esta PC).') + '</p>' +
              '<button class="btn btn-primary" type="button" data-accion="' + (autorizar ? 'autorizar' : 'conectar') + '">' + icono('folder-check') +
              (autorizar ? 'Autorizar carpeta' : 'Conectar carpeta') + '</button>');
      } else if (!todas.length && est === 'no-soportado') {
        html = '<div class="empty-art">' + icono('alert') + '</div>' +
          '<h2>Este navegador no puede leer los datos</h2>' +
          '<p>Abrí la web con <b>Chrome</b> o <b>Edge</b>: son los que pueden leer y guardar <b>datos.json</b> en la carpeta.</p>';
      } else if (!todas.length) {
        html = '<div class="empty-art">' + icono('printer') + '</div>' +
          '<h2>Todavía no hay oficinas cargadas</h2>' +
          '<p>Agregá la primera oficina con sus impresoras para empezar a buscar.</p>' +
          '<button class="btn btn-primary" type="button" data-accion="nueva">' + icono('plus') + 'Añadir oficina</button>';
      } else if (filtroUbic || filtroEdif) {
        html = '<div class="empty-art">' + icono('search-x') + '</div>' +
          '<h2>No encontramos «' + esc(consulta.texto) + '»' + textoDonde(todas) + '</h2>' +
          '<p>Puede estar en otra ubicación: probá buscando en todas.</p>' +
          '<button class="btn btn-primary" type="button" data-accion="quitar-filtro">' + icono('search') + 'Buscar en todas</button>';
      } else {
        html = '<div class="empty-art">' + icono('search-x') + '</div>' +
          '<h2>No encontramos «' + esc(consulta.texto) + '»</h2>' +
          '<p>Revisá cómo está escrito o probá solo con el número del juzgado. Si la oficina no está cargada, podés añadirla ahora.</p>' +
          '<button class="btn btn-primary" type="button" data-accion="nueva-con-nombre">' + icono('plus') + 'Añadir «' + esc(consulta.texto) + '»</button>';
      }
    }
    el.hidden = !html;
    if (html !== ultimoVacio) { el.innerHTML = html; ultimoVacio = html; }
  }

  /* ---------- Guardado en la carpeta compartida (indicador + menú) ---------- */
  var PILL = {
    conectada: { cls: 'ok', ico: 'folder-check', txt: 'Carpeta compartida' },
    guardando: { cls: 'ok girando', ico: 'loader', txt: 'Guardando…' },
    permiso: { cls: 'warn', ico: 'folder', txt: 'Autorizar carpeta' },
    error: { cls: 'mal', ico: 'alert', txt: 'Error al guardar' },
    local: { cls: 'warn', ico: 'folder', txt: 'Sin guardar para todos' },
    'no-soportado': { cls: 'warn', ico: 'alert', txt: 'Solo en este navegador' },
    celu: { cls: 'warn', ico: 'upload', txt: 'Pasar a la PC' }
  };

  function renderCarpeta() {
    var C = App.Carpeta, est = C.estado(), n = A.cambiosLocales();
    var btn = $('#btnCarpeta');
    var visible = est === 'celu' ? A.sinPasar() > 0
      : n > 0 || est === 'conectada' || est === 'guardando' || est === 'permiso' || est === 'error';
    btn.hidden = !visible;
    if (visible) {
      var t = PILL[est] || PILL.local;
      var titulo = est === 'conectada' ? 'Cada cambio se guarda en datos.json de «' + C.nombre() + '». Tocá para guardar ahora.'
        : est === 'guardando' ? 'Guardando en datos.json…'
        : est === 'permiso' ? 'Estás viendo la última copia guardada en este navegador. Tocá para autorizar la carpeta y traer lo último de datos.json.'
        : est === 'error' ? C.detalle() + ' Tocá para reintentar.'
        : est === 'no-soportado' ? 'Este navegador no puede guardar en la carpeta: usá Edge o Chrome, o descargá datos.json desde el menú ⋮.'
        : est === 'celu' ? 'Tenés ' + plural(A.sinPasar(), 'cambio hecho', 'cambios hechos') + ' en el celu sin pasar a la PC. Tocá para ' + (A.sinPasar() === 1 ? 'mandarlo.' : 'mandarlos.')
        : 'Tus cambios están solo en este navegador. Tocá para conectar la carpeta de la web y guardarlos en datos.json.';
      btn.className = 'pill-carpeta ' + t.cls;
      btn.title = titulo;
      btn.setAttribute('aria-label', t.txt + '. ' + titulo);
      var html = icono(t.ico) + '<span class="pc-txt">' + t.txt + '</span>';
      if (btn._html !== html) { btn.innerHTML = html; btn._html = html; }
    }
    $('#miConectar').hidden = !(C.soportado() && (est === 'local' || est === 'error'));
    $('#miGuardar').hidden = !C.nombre();
    $('#miDesconectar').hidden = !C.nombre();
    renderMenu();
  }

  function renderMenu() {
    var n = A.cambiosLocales(), C = App.Carpeta, est = C.estado();
    $('#menuDot').hidden = est === 'celu' ? !A.sinPasar() : !n;
    var nota = $('#menuNota'), txt = '', ok = false;
    if (est === 'celu') {
      var sp = A.sinPasar(), act = A.info().actualizado, S = App.Sync, si = S.info();
      if (sp) txt = 'Tenés ' + plural(sp, 'cambio hecho', 'cambios hechos') + ' en el celu sin pasar a la PC.';
      else if (S.activo() && si.error) txt = si.error;
      else if (n) txt = 'Ya pasaste tus cambios a la PC. Cuando los cargues allá, el celu los va a recibir.';
      else if (S.activo() && si.fecha) { txt = 'Conectado con la PC: datos subidos ' + S.fechaHora(si.fecha) + '.'; ok = true; }
      else if (act) { txt = 'Datos del celu al ' + act.split('-').reverse().join('/') + '.'; ok = true; }
    } else if (n && (est === 'conectada' || est === 'guardando')) txt = 'Guardando ' + plural(n, 'cambio', 'cambios') + ' en la carpeta…';
    else if (n && est === 'permiso') txt = 'Hay ' + plural(n, 'cambio', 'cambios') + ' esperando para guardarse: tocá "Autorizar carpeta".';
    else if (est === 'permiso') txt = 'Estás viendo la última copia guardada en este navegador: tocá "Autorizar carpeta" para traer lo último.';
    else if (n) txt = 'Tenés ' + plural(n, 'cambio guardado', 'cambios guardados') + ' solo en este navegador. ' +
      (C.soportado() ? 'Conectá la carpeta de la web para guardarlos en datos.json.' : 'Descargá datos.json y reemplazá el de la carpeta.');
    else if (est === 'conectada') { txt = 'Conectada a «' + C.nombre() + '»: cada cambio se guarda en datos.json.'; ok = true; }
    var mc = $('#miCelu');
    if (mc && !A.modoCelu()) {
      var sy = App.Sync, inf = sy.info();
      mc.lastChild.textContent = sy.activo() ? (inf.error ? 'Ver en el celu (no se pudo subir)' : 'Ver en el celu (activado)') : 'Ver en el celu…';
    }
    if (A.modoCelu()) {
      var conectado = App.Sync.activo();
      $('#miCeluConectar').hidden = conectado;
      $('#miCeluBajar').hidden = !conectado;
      $('#miCeluDesconectar').hidden = !conectado;
    }
    nota.className = 'menu-note' + (ok ? ' ok' : '');
    nota.hidden = !txt;
    nota.textContent = txt;
  }

  function accionCarpeta() {
    var C = App.Carpeta, est = C.estado();
    if (est === 'conectada') C.guardarAhora().then(function (ok) { if (ok) UI.toast('Guardado en <b>datos.json</b>'); });
    else if (est === 'permiso' || (est === 'error' && C.nombre())) C.reconectar();
    else if (est === 'local' || est === 'error') C.conectar();
    else if (est === 'no-soportado') descargarDatos();
    else if (est === 'celu') App.Celu.pasarALaPC();
  }

  function descargarDatos() {
    UI.descargar('datos.json', A.serializar(A.exportar()), 'application/json');
    UI.toast('Se descargó <b>datos.json</b>: reemplazá con ese archivo el de la carpeta de la web.', { duracion: 8000 });
  }

  function render() {
    var todas = A.lista();
    renderFiltros(todas);
    var enEdif = delEdificio(todas);
    var base = filtroUbic ? enEdif.filter(function (o) { return claveUbic(o) === filtroUbic; }) : enEdif;
    var res = B.buscar(base, consulta);
    UI.contarHasta($('#statOficinas'), todas.length);
    UI.contarHasta($('#statImpresoras'), totalImpresoras(todas));
    renderResumen(res, todas, base);
    renderLista(res);
    pintarEnfoque();
    renderVacio(res, todas);
    renderCarpeta();
    if (seleccion.size) {
      var existen = new Set(todas.map(function (o) { return o.id; }));
      seleccion.forEach(function (id) { if (!existen.has(id)) seleccion.delete(id); });
    }
    $('#btnSeleccionar').hidden = !todas.length;
    pintarSeleccion();
    var info = A.info();
    $('#avisoEjemplo').hidden = !info.ejemplo;
    var f = info.actualizado && /^\d{4}-\d{2}-\d{2}$/.test(info.actualizado) ? info.actualizado.split('-').reverse().join('/') : info.actualizado;
    $('#footerInfo').textContent = 'Buscador de impresoras' + (f ? ' · Datos base actualizados el ' + f : '');
    revisarSubir();   // al filtrar cambia el alto de la página
  }

  /* ---------- Seleccionar varias oficinas (para asignarles un edificio de una vez) ---------- */
  function seleccionadas() {
    return A.lista().filter(function (o) { return seleccion.has(o.id); });
  }

  // Marca las tarjetas elegidas y actualiza la barra, sin volver a dibujar las tarjetas (no se pierde el foco).
  function pintarSeleccion() {
    tarjetas.forEach(function (el, id) {
      var on = seleccion.has(id);
      el.classList.toggle('seleccionada', on);
      var cb = el.querySelector('[data-sel]');
      if (cb) cb.checked = on;
    });
    document.body.classList.toggle('seleccionando', seleccionando);
    var btn = $('#btnSeleccionar');
    btn.setAttribute('aria-pressed', String(seleccionando));
    $('span', btn).textContent = seleccionando ? 'Cancelar selección' : 'Seleccionar varias';
    $('#barraSel').hidden = !seleccionando;
    if (!seleccionando) return;
    var n = seleccion.size, ocultas = 0;
    seleccion.forEach(function (id) { if (!tarjetas.has(id)) ocultas++; });
    $('#bsCuenta').innerHTML = !n ? 'Tocá las oficinas que querés elegir'
      : '<b>' + plural(n, 'oficina seleccionada', 'oficinas seleccionadas') + '</b>' +
        (ocultas ? ' · ' + ocultas + (ocultas === 1 ? ' no se ve' : ' no se ven') + ' ahora' : '');
    $('[data-bs="edificio"]').disabled = !n;
  }

  function modoSeleccion(on) {
    seleccionando = on;
    if (on) { enfoque.id = null; enfoque.imp = null; }
    seleccion.clear();
    render();          // las tarjetas cambian: casilla en lugar del ícono y sin los botones de abajo
  }

  function alternarSeleccion(id) {
    if (seleccion.has(id)) seleccion.delete(id); else seleccion.add(id);
    pintarSeleccion();
  }

  function abrirAsignar() {
    var ofs = seleccionadas().sort(function (a, b) { return B.comparar(a.nombre, b.nombre); });   // como en pantalla
    if (!ofs.length) return;
    $('#edificios').innerHTML = grupos(A.lista(), 'edificio').map(function (e) { return '<option value="' + esc(e.etq) + '">'; }).join('');
    var claves = new Set(ofs.map(function (o) { return clave(o, 'edificio'); }));
    var input = $('#fEdificioVarias');
    input.value = claves.size === 1 ? String(ofs[0].edificio || '') : '';     // si ya comparten edificio, se muestra
    var nombres = ofs.slice(0, 4).map(function (o) { return esc(o.nombre); }).join(', ') + (ofs.length > 4 ? ' y ' + (ofs.length - 4) + ' más' : '');
    $('#edifTexto').innerHTML = 'Para <b>' + plural(ofs.length, 'oficina', 'oficinas') + '</b> (' +
      plural(totalImpresoras(ofs), 'impresora', 'impresoras') + '): ' + nombres + '.';
    botonAsignar();
    UI.abrirModal($('#modalEdificio'));
    setTimeout(function () { input.focus(); input.select(); }, 60);
  }

  function botonAsignar() {
    var quitar = !$('#fEdificioVarias').value.trim();
    var ok = $('#edifOk');
    ok.textContent = quitar ? 'Quitar edificio' : 'Asignar';
    ok.className = 'btn ' + (quitar ? 'btn-danger' : 'btn-primary');
  }

  function asignarEdificio(ev) {
    ev.preventDefault();
    var valor = $('#fEdificioVarias').value.trim().replace(/\s+/g, ' ');
    var antes = [], despues = [];
    seleccionadas().forEach(function (o) {
      if (String(o.edificio || '') === valor) return;              // ya estaba así
      var a = Object.assign({}, o);
      delete a._origen;
      var d = Object.assign({}, a);
      if (valor) d.edificio = valor; else delete d.edificio;
      antes.push(a);
      despues.push(d);
    });
    UI.cerrarModal($('#modalEdificio'));
    modoSeleccion(false);
    if (!despues.length) {
      UI.toast(valor ? 'Esas oficinas ya estaban en <b>' + esc(valor) + '</b>.' : 'Esas oficinas ya estaban sin edificio.', { tipo: 'info' });
      return;
    }
    A.guardarVarias(despues);           // todas juntas: un solo guardado en datos.json
    if (!A.puedeGuardar()) {
      UI.toast('No se pudo guardar en este navegador (almacenamiento bloqueado). Exportá una copia antes de cerrar.', { tipo: 'error', duracion: 8000 });
      return;
    }
    var cuantas = '<b>' + plural(despues.length, 'oficina', 'oficinas') + '</b>';
    UI.toast(valor ? cuantas + ' ahora en <b>' + esc(valor) + '</b>' : 'Se quitó el edificio a ' + cuantas, {
      duracion: 8000,
      accion: { texto: 'Deshacer', fn: function () { A.guardarVarias(antes); } }   // vuelve a guardarlas como estaban
    });
  }

  /* ---------- Búsqueda ---------- */
  function fijarBusqueda(texto, inmediato) {
    var input = $('#q');
    if (input.value !== texto) input.value = texto;
    $('#btnLimpiar').hidden = !texto;
    clearTimeout(timerBusqueda);
    var hacer = function () {
      if (texto.trim() !== consulta.texto) mostrarOtras = false;
      consulta = B.parsear(texto);
      render();
      try {
        var url = location.pathname + location.search + (texto ? '#q=' + encodeURIComponent(texto) : '');
        history.replaceState(null, '', url);
      } catch (e) { /* algunos navegadores bloquean replaceState en file:// */ }
    };
    if (inmediato) hacer(); else timerBusqueda = setTimeout(hacer, 70);
  }

  function leerHash() {
    var m = /[#&]q=([^&]*)/.exec(location.hash);
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch (e) { return ''; }
  }

  // Después de guardar: muestra la tarjeta y la resalta.
  App.mostrarOficina = function (id) {
    render();
    if (!tarjetas.has(id)) { filtroUbic = ''; filtroEdif = ''; fijarBusqueda('', true); }   // la búsqueda o un filtro la dejaban afuera
    var el = tarjetas.get(id);
    if (!el) return;
    setTimeout(function () {
      el.scrollIntoView({ block: 'center', behavior: UI.movimientoReducido() ? 'auto' : 'smooth' });
      el.classList.remove('destacar');
      void el.offsetWidth;
      el.classList.add('destacar');
      setTimeout(function () { el.classList.remove('destacar'); }, 1700);
    }, 220);
  };

  /* ---------- Acciones de tarjeta ---------- */
  function marcarOk(btn, conTexto) {
    var original = btn.innerHTML;
    btn.classList.add('ok');
    btn.innerHTML = icono('check') + (conTexto ? '<span>Copiado</span>' : '');
    setTimeout(function () { btn.classList.remove('ok'); btn.innerHTML = original; }, 1400);
  }

  function eliminar(o) {
    UI.confirmar({
      titulo: '¿Eliminar esta oficina?',
      texto: 'Se va a quitar <b>' + esc(o.nombre) + '</b> y ' + plural((o.impresoras || []).length, 'impresora', 'impresoras') + '.',
      ok: 'Eliminar'
    }).then(function (si) {
      if (!si) return;
      var el = tarjetas.get(o.id);
      var hacer = function () {
        A.eliminar(o.id);
        // Deshacer = volver a guardar la oficina (funciona aunque la baja ya se haya escrito en datos.json).
        UI.toast('Se eliminó <b>' + esc(o.nombre) + '</b>', {
          tipo: 'info',
          accion: { texto: 'Deshacer', fn: function () { A.guardar(o); App.mostrarOficina(o.id); } }
        });
      };
      if (el && !UI.movimientoReducido()) {
        el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.94)' }], { duration: 220, easing: 'ease-in' });
        setTimeout(hacer, 200);
      } else {
        hacer();
      }
    });
  }

  /* ---------- Volver arriba: el botón aparece solo al llegar al final de la página ---------- */
  /* ---------- Celular: el buscador queda pegado arriba al bajar (position: sticky en estilos.css) ---------- */
  var mqAngosta = window.matchMedia ? matchMedia('(max-width: 640px)') : null;   // mismo corte que estilos.css
  var altoBarra = 0;

  function medirBarra() {
    altoBarra = $('.topbar').offsetHeight;
    document.documentElement.style.setProperty('--alto-topbar', altoBarra + 'px');
    revisarPegado();
  }

  // Pegado = ya llegó a la barra de arriba (si no, sigue en su lugar). Solo pinta la franja de atrás.
  // Se descuenta el transform (animación de entrada, foco) para mirar dónde está de verdad.
  function revisarPegado() {
    var w = $('#searchWrap'), pegado = false;
    if (mqAngosta && mqAngosta.matches) {
      var t = getComputedStyle(w).transform, dy = 0;
      if (t && t !== 'none') { try { dy = new DOMMatrixReadOnly(t).m42; } catch (e) { /* sin DOMMatrix */ } }
      pegado = w.getBoundingClientRect().top - dy <= altoBarra + 1;
    }
    if (w.classList.contains('pegado') !== pegado) w.classList.toggle('pegado', pegado);
  }

  // Escribir con el buscador pegado (se había bajado por la lista): los resultados se ven desde el principio.
  function irAResultados() {
    var w = $('#searchWrap');
    if (!w.classList.contains('pegado')) return;
    var top = $('.hero-pie').getBoundingClientRect().top + scrollY - altoBarra - w.offsetHeight;
    if (scrollY > top + 1) window.scrollTo({ top: top, behavior: 'instant' });   // al escribir, sin animación
  }

  function revisarSubir() {
    var doc = document.documentElement, b = $('#btnSubir');
    var abajo = doc.scrollHeight > innerHeight + 200 && scrollY + innerHeight >= doc.scrollHeight - 120;
    if (b.classList.contains('visible') === abajo) return;
    b.classList.toggle('visible', abajo);
    b.tabIndex = abajo ? 0 : -1;
    b.setAttribute('aria-hidden', String(!abajo));
    document.body.classList.toggle('con-subir', abajo);
  }

  /* ---------- Enfoque: clic en una tarjeta → lo demás se desenfoca; clic en una impresora → doble enfoque ---------- */
  function enfocar(id, imp) {
    enfoque.id = id || null;
    enfoque.imp = id && imp != null ? String(imp) : null;
    pintarEnfoque();
  }

  function pintarEnfoque() {
    var card = enfoque.id ? tarjetas.get(enfoque.id) : null;
    var fila = card && enfoque.imp != null ? card.querySelector('.prow[data-p="' + enfoque.imp + '"]') : null;
    if (!card) enfoque.id = null;
    if (!fila) enfoque.imp = null;
    document.body.classList.toggle('enfocando', !!card);
    tarjetas.forEach(function (el) {
      el.classList.toggle('enfocada', el === card);
      el.classList.toggle('con-impresora', el === card && !!fila);
    });
    document.querySelectorAll('#results .prow.enfocada').forEach(function (f) { if (f !== fila) f.classList.remove('enfocada'); });
    if (fila) fila.classList.add('enfocada');
  }

  // Esc o clic afuera: primero se suelta la impresora y después la tarjeta.
  function soltarEnfoque() {
    if (enfoque.imp != null) enfocar(enfoque.id, null);
    else enfocar(null);
  }

  function alClicResultados(ev) {
    var copiarBtn = ev.target.closest('[data-copiar]');
    if (copiarBtn) {
      var valor = copiarBtn.getAttribute('data-copiar');
      UI.copiar(valor).then(function (ok) {
        if (ok) { marcarOk(copiarBtn, false); UI.toast('Copiado: <b>' + esc(valor) + '</b>'); }
        else UI.toast('No se pudo copiar. Seleccioná el texto a mano.', { tipo: 'error' });
      });
      return;
    }
    var btn = ev.target.closest('[data-accion]');
    if (btn && btn === divisor) { mostrarOtras = !mostrarOtras; render(); return; }
    var card = ev.target.closest('.card');
    // Seleccionando: tocar la tarjeta la elige (salvo la casilla, que avisa sola, los enlaces y "Ver más").
    if (seleccionando && card && !btn && !ev.target.closest('a, .sel-check')) {
      alternarSeleccion(card.getAttribute('data-id'));
      return;
    }
    // Clic en la tarjeta (no en un botón ni enlace): la enfoca; ya enfocada, enfoca la impresora tocada.
    if (card && !btn && !ev.target.closest('a, button, input, label')) {
      if (String(window.getSelection ? window.getSelection() : '')) return;   // estaba seleccionando texto para copiarlo
      var cid = card.getAttribute('data-id'), fila = ev.target.closest('.prow');
      if (enfoque.id !== cid) enfocar(cid, null);
      else if (fila) enfocar(cid, enfoque.imp === fila.getAttribute('data-p') ? null : fila.getAttribute('data-p'));
      else soltarEnfoque();
      return;
    }
    if (!btn || !card) return;
    var id = card.getAttribute('data-id');
    var o = A.obtener(id);
    if (!o) return;
    var acc = btn.getAttribute('data-accion');
    if (acc === 'ver-mas') {
      if (expandidas.has(id)) expandidas.delete(id); else expandidas.add(id);
      render();
    } else if (acc === 'copiar') {
      UI.copiar(textoOficina(o)).then(function (ok) {
        if (ok) { marcarOk(btn, true); UI.toast('Datos de <b>' + esc(o.nombre) + '</b> copiados'); }
        else UI.toast('No se pudo copiar al portapapeles.', { tipo: 'error' });
      });
    } else if (acc === 'editar') {
      App.Formulario.abrir(o);
    } else if (acc === 'eliminar') {
      eliminar(o);
    }
  }

  /* ---------- Menú de datos ---------- */
  function abrirMenu(abrir) {
    var menu = $('#menuDatos'), btn = $('#btnMenu');
    menu.hidden = !abrir;
    btn.setAttribute('aria-expanded', String(abrir));
    if (abrir) { var p = menu.querySelector('.menu-item'); if (p) p.focus(); }
  }

  function exportar() {
    var datos = A.exportar();
    UI.descargar('impresoras-' + datos.actualizado + '.json', JSON.stringify(datos, null, 2));
    UI.toast('Copia exportada: ' + plural(datos.oficinas.length, 'oficina', 'oficinas'));
  }

  function importar(archivo) {
    var lector = new FileReader();
    lector.onload = function () {
      var datos;
      try {
        var txt = String(lector.result).replace(/^﻿/, '').trim();
        var igual = txt.indexOf('=');
        if (txt.charAt(0) !== '{' && txt.charAt(0) !== '[' && igual !== -1) txt = txt.slice(igual + 1).replace(/;\s*$/, '');
        datos = JSON.parse(txt);
      } catch (e) {
        UI.toast('El archivo no tiene el formato esperado (.json exportado desde esta web).', { tipo: 'error' });
        return;
      }
      var lista = Array.isArray(datos) ? datos : (datos && datos.oficinas) || [];
      UI.confirmar({
        titulo: '¿Importar esta copia?',
        texto: 'Los datos que ves ahora se reemplazan por los del archivo (<b>' + plural(lista.length, 'oficina', 'oficinas') + '</b>).',
        ok: 'Importar',
        peligro: false
      }).then(function (si) {
        if (!si) return;
        var previo = A.exportar();
        try {
          var n = A.importar(datos);
          fijarBusqueda('', true);
          UI.toast('Se importaron ' + plural(n, 'oficina', 'oficinas'), { accion: { texto: 'Deshacer', fn: function () { A.importar(previo); } } });
        } catch (e) {
          UI.toast(esc(e.message), { tipo: 'error' });
        }
      });
    };
    lector.readAsText(archivo);
  }

  function restablecer() {
    var n = A.cambiosLocales();
    if (!n) { UI.toast('No hay cambios locales: ya estás viendo los datos originales.', { tipo: 'info' }); return; }
    UI.confirmar({
      titulo: '¿Descartar los cambios locales?',
      texto: (n === 1 ? 'Se pierde ' : 'Se pierden ') + plural(n, 'cambio hecho', 'cambios hechos') +
        (A.modoCelu() ? ' en el celu y vuelven los últimos datos que mandó la PC.' : ' en este navegador y vuelven los datos de <code>datos.json</code>.'),
      ok: 'Descartar'
    }).then(function (si) {
      if (!si) return;
      var foto = A.foto();
      A.restablecer();
      UI.toast('Se restablecieron los datos originales', { tipo: 'info', accion: { texto: 'Deshacer', fn: function () { A.volverA(foto); } } });
    });
  }

  /* ---------- Inicio ---------- */
  function init() {
    A.init();
    UI.initConfirmar();
    App.Formulario.init();
    App.Pegar.init();
    App.Celu.init();
    App.Sync.init();
    $('#btnPegar').addEventListener('click', function () { App.Pegar.abrir(); });
    UI.aplicarTema(UI.temaActual(), false);
    A.alCambiar(render);
    App.Celu.alCambiar(render);       // se pudo instalar, se instaló, o eligió seguir sin instalar
    App.Sync.alCambiar(render);       // celu: llegaron datos de la PC / PC: se subió la copia para el celu
    App.Carpeta.alCambiar(render);   // también el estado vacío (conectar / autorizar la carpeta para leer datos.json)
    $('#btnCarpeta').addEventListener('click', accionCarpeta);

    // Primer cambio sin carpeta conectada: avisar (una vez) que quedó solo en este navegador.
    var avisado = false;
    A.alCambiar(function () {
      var est = App.Carpeta.estado();
      if (est === 'celu') {     // en el celu: avisar (una vez) que hay que pasarlo a la PC
        if (avisado || !A.sinPasar()) return;
        avisado = true;
        setTimeout(function () {
          if (!A.sinPasar()) return;
          UI.toast('Quedó guardado en el celu. Cuando quieras, pasalo a la PC.', {
            tipo: 'info', duracion: 10000, accion: { texto: 'Pasar a la PC', fn: App.Celu.pasarALaPC }
          });
        }, 800);
        return;
      }
      if (avisado || !A.cambiosLocales() || (est !== 'local' && est !== 'no-soportado')) return;
      avisado = true;
      setTimeout(function () {
        var e = App.Carpeta.estado();
        if (!A.cambiosLocales() || (e !== 'local' && e !== 'no-soportado')) return;
        UI.toast('Este cambio quedó guardado <b>solo en este navegador</b>.', {
          tipo: 'info', duracion: 10000,
          accion: App.Carpeta.soportado()
            ? { texto: 'Guardar para todos', fn: App.Carpeta.conectar }
            : { texto: 'Descargar datos.json', fn: descargarDatos }
        });
      }, 800);
    });

    var input = $('#q');
    input.addEventListener('input', function () {
      fijarBusqueda(input.value, false);
      setTimeout(irAResultados, 90);      // después del render (la búsqueda espera 70 ms)
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        if (input.value) { ev.preventDefault(); fijarBusqueda('', true); }
        else input.blur();
      } else if (ev.key === 'Enter') {
        var primera = $('#results .card');
        if (primera && window.innerWidth < 640) input.blur();   // en celular oculta el teclado
      }
    });
    $('#btnLimpiar').addEventListener('click', function () { fijarBusqueda('', true); input.focus(); });

    // Atajo al buscador: suelta el enfoque de tarjeta (si no, el buscador queda desenfocado), sube y lo selecciona.
    function abrirBuscador() {
      if (enfoque.id) enfocar(null);
      if (!$('#menuDatos').hidden) abrirMenu(false);
      window.scrollTo({ top: 0, behavior: UI.movimientoReducido() ? 'auto' : 'smooth' });
      input.focus({ preventScroll: true });
      input.select();
    }

    document.addEventListener('keydown', function (ev) {
      var t = ev.target, escribiendo = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      var atajo = (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && /^[bk]$/i.test(ev.key);   // Ctrl+B (o Ctrl+K)
      if (atajo && !document.querySelector('dialog[open]')) {
        ev.preventDefault();
        abrirBuscador();
      } else if (ev.key === '/' && !escribiendo && !document.querySelector('dialog[open]')) {
        ev.preventDefault();
        abrirBuscador();
      } else if (ev.key === 'Escape' && !$('#menuDatos').hidden) {
        abrirMenu(false);
        $('#btnMenu').focus();
      } else if (ev.key === 'Escape' && enfoque.id && !escribiendo && !document.querySelector('dialog[open]')) {
        soltarEnfoque();
      } else if (ev.key === 'Escape' && seleccionando && !ev.defaultPrevented && !document.querySelector('dialog[open]')) {
        modoSeleccion(false);
      }
    });

    // Clic fuera de las tarjetas (salvo en modales y avisos): se suelta el enfoque.
    document.addEventListener('click', function (ev) {
      if (!enfoque.id || ev.target.closest('#results .card, dialog, .toasts')) return;
      enfocar(null);
    });

    var results = $('#results');
    results.addEventListener('click', alClicResultados);

    // Seleccionar varias: casillas de las tarjetas, barra de abajo y modal para asignar el edificio.
    results.addEventListener('change', function (ev) {
      var cb = ev.target.closest('[data-sel]');
      if (!cb) return;
      var id = cb.closest('.card').getAttribute('data-id');
      if (cb.checked) seleccion.add(id); else seleccion.delete(id);
      pintarSeleccion();
    });
    $('#btnSeleccionar').addEventListener('click', function () { modoSeleccion(!seleccionando); });
    $('#barraSel').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-bs]');
      if (!b || b.disabled) return;
      var acc = b.getAttribute('data-bs');
      if (acc === 'todas') { tarjetas.forEach(function (el, id) { seleccion.add(id); }); pintarSeleccion(); }
      else if (acc === 'ninguna') { seleccion.clear(); pintarSeleccion(); }
      else if (acc === 'edificio') abrirAsignar();
      else if (acc === 'salir') modoSeleccion(false);
    });
    var dlgEdif = $('#modalEdificio');
    UI.prepararModal(dlgEdif);
    dlgEdif.querySelector('[data-cerrar]').addEventListener('click', function () { UI.cerrarModal(dlgEdif); });
    $('#formEdificio').addEventListener('submit', asignarEdificio);
    $('#fEdificioVarias').addEventListener('input', botonAsignar);

    $('#empty').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-accion]');
      if (!b) return;
      var acc = b.getAttribute('data-accion');
      if (acc === 'quitar-filtro') { filtroUbic = ''; filtroEdif = ''; render(); return; }
      if (acc === 'cargar-celu') { App.Celu.actualizarDatos(); return; }
      if (acc === 'conectar') { App.Carpeta.conectar(); return; }
      if (acc === 'autorizar') { App.Carpeta.reconectar(); return; }
      if (acc === 'instalar') { App.Celu.instalar(); return; }
      if (acc === 'sin-instalar') { App.Celu.seguirSinInstalar(); return; }
      var sug = acc === 'nueva-con-nombre' ? consulta.texto : '';
      App.Formulario.abrir(null, sug ? sug.charAt(0).toUpperCase() + sug.slice(1) : '');
    });

    $('#filtros').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-ubic]');
      if (!b) return;
      var k = b.getAttribute('data-ubic');
      filtroUbic = filtroUbic === k ? '' : k;
      mostrarOtras = false;
      render();
    });
    $('#filtrosEdif').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-edif]');
      if (!b) return;
      var k = b.getAttribute('data-edif');
      filtroEdif = filtroEdif === k ? '' : k;
      mostrarOtras = false;
      render();
    });

    $('#btnAgregar').addEventListener('click', function () { App.Formulario.abrir(null); });
    window.addEventListener('scroll', revisarSubir, { passive: true });
    window.addEventListener('resize', revisarSubir);
    window.addEventListener('scroll', revisarPegado, { passive: true });
    window.addEventListener('resize', medirBarra);
    if (window.ResizeObserver) new ResizeObserver(medirBarra).observe($('.topbar'));   // cambia con las fuentes o el indicador
    medirBarra();
    $('#btnSubir').addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: UI.movimientoReducido() ? 'auto' : 'smooth' });
      this.blur();
    });
    $('#btnTema').addEventListener('click', UI.alternarTema);
    $('#brandLink').addEventListener('click', function (ev) {
      ev.preventDefault();
      fijarBusqueda('', true);
      window.scrollTo({ top: 0, behavior: UI.movimientoReducido() ? 'auto' : 'smooth' });
    });

    // Menú
    $('#btnMenu').addEventListener('click', function (ev) {
      ev.stopPropagation();
      abrirMenu($('#menuDatos').hidden);
    });
    document.addEventListener('click', function (ev) {
      if (!$('#menuDatos').hidden && !ev.target.closest('.menu-wrap')) abrirMenu(false);
    });
    $('#menuDatos').addEventListener('click', function (ev) {
      var it = ev.target.closest('[data-accion]');
      if (!it) return;
      abrirMenu(false);
      var acc = it.getAttribute('data-accion');
      if (acc === 'pegar') App.Pegar.abrir();
      else if (acc === 'exportar') exportar();
      else if (acc === 'importar') $('#inputImportar').click();
      else if (acc === 'restablecer') restablecer();
      else if (acc === 'conectar') App.Carpeta.conectar();
      else if (acc === 'guardar-ahora') accionCarpeta();
      else if (acc === 'descargar-datos') descargarDatos();
      else if (acc === 'celu-actualizar') App.Celu.actualizarDatos();
      else if (acc === 'celu-pasar') App.Celu.pasarALaPC();
      else if (acc === 'instalar') App.Celu.instalar();
      else if (acc === 'pc-al-celu') App.Celu.pasarDatosAlCelu();
      else if (acc === 'ver-celu' || acc === 'celu-conectar') App.Sync.abrir();
      else if (acc === 'celu-bajar') App.Sync.bajar({ manual: true });
      else if (acc === 'celu-desconectar') {
        UI.confirmar({
          titulo: '¿Desconectar de la PC?',
          texto: 'El celu deja de bajar solo los datos de la PC. Los que ya tiene siguen ahí, y podés volver a conectarlo con el código.',
          ok: 'Desconectar'
        }).then(function (si) { if (si) App.Sync.desconectarCelu(); });
      }
      else if (acc === 'pc-traer') App.Celu.traerCambios();
      else if (acc === 'desconectar') {
        App.Carpeta.desconectar().then(function () {
          UI.toast('Carpeta desconectada: los próximos cambios quedan solo en este navegador.', { tipo: 'info' });
        });
      }
    });
    $('#inputImportar').addEventListener('change', function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (f) importar(f);
      ev.target.value = '';
    });

    // Si el usuario nunca eligió tema, seguir el del sistema.
    if (window.matchMedia) {
      var mq = matchMedia('(prefers-color-scheme: dark)');
      var seguir = function (e) {
        var elegido = null;
        try { elegido = localStorage.getItem('impresoras.tema'); } catch (x) { /* nada */ }
        if (!elegido) UI.aplicarTema(e.matches ? 'dark' : 'light', false);
      };
      if (mq.addEventListener) mq.addEventListener('change', seguir);
    }

    fijarBusqueda(leerHash(), true);
    // Recupera la carpeta conectada (si la hay), lee datos.json y empieza a traer cambios hechos desde otra PC.
    // Si el navegador pide permiso otra vez, se ve la última copia guardada y se avisa cómo traer lo último.
    App.Carpeta.init().then(function () {
      if (App.Carpeta.estado() !== 'permiso' || !A.hayDatos()) return;
      UI.toast('Estás viendo la copia guardada en este navegador. Autorizá la carpeta para traer lo último de <b>datos.json</b>.', {
        tipo: 'info', duracion: 12000, accion: { texto: 'Autorizar', fn: App.Carpeta.reconectar }
      });
    });
    App.Titulo.init();      // luz que recorre las letras del título
  }

  init();
})();
