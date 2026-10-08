/* "Pegar datos": se pega texto copiado de cualquier lado (PDF, mail, Word, una tabla) y la web
   reconoce las impresoras (IP, MAC, N° de serie, modelo, host, conexión, estado), el juzgado u
   oficina y el piso. Se revisan en una vista previa y se cargan todas juntas.
   analizar() es pura (sin pantalla) para poder probarla con Node: ver pruebas/pruebas.js. */
(function () {
  'use strict';
  var App = window.App = window.App || {};

  function norm(s) { return App.Busqueda.normalizar(s); }
  function clave(s) { return norm(s).replace(/[^a-z0-9]+/g, ' ').trim(); }   // misma clave que Almacen.porNombre
  function sinCeros(n) { return String(Number(n)); }

  var CORE = ['modelo', 'ip', 'hostname', 'mac', 'serie'];        // datos que identifican una impresora
  var ORDEN = ['marca', 'modelo', 'ip', 'hostname', 'mac', 'serie', 'sector', 'conexion', 'estado'];
  var MARCAS = { hp: 'HP', lexmark: 'Lexmark', brother: 'Brother', epson: 'Epson', samsung: 'Samsung', kyocera: 'Kyocera',
    xerox: 'Xerox', canon: 'Canon', ricoh: 'Ricoh', konica: 'Konica Minolta', oki: 'OKI', pantum: 'Pantum' };
  var ESTADOS = { 'en uso': 'En uso', 'sin uso': 'Sin uso', 'fuera de servicio': 'Fuera de servicio', 'en reparacion': 'En reparación' };

  var RE_JUZ = /\bjuz(?:gado)?s?\.?\s*(?:(?:nro|no|n)\.?\s*)?(\d{1,3})\b/;   // sobre texto normalizado
  var RE_JCYF = /\bj(?:uz)?cyf\s*(\d{1,3})(?!\d)/;                          // "JCyF 30", host "foto-juzcyf99"

  function ipValida(ip) {
    return ip.split('.').every(function (x) { return Number(x) <= 255; });
  }

  function mac(hex) { return hex.replace(/[^0-9a-f]/gi, '').toUpperCase().match(/../g).join(':'); }

  /* ---------- Oficinas: reconocer juzgados por número y oficinas ya cargadas por nombre ---------- */
  function numJuzgado(texto) {
    var n = norm(texto), m = RE_JUZ.exec(n) || RE_JCYF.exec(n);
    return m ? sinCeros(m[1]) : '';
  }

  function porNumero(n, oficinas) {
    var o = oficinas.filter(function (x) { return numJuzgado(x.nombre) === n; })[0];
    return o ? { nombre: o.nombre, existe: true } : { nombre: 'Juzgado N° ' + n, existe: false };
  }

  // Nombre escrito o detectado → oficina ya cargada (si coincide) o nombre para una nueva.
  function resolver(nombre, oficinas) {
    nombre = String(nombre || '').trim().replace(/\s+/g, ' ');
    if (!nombre) return null;
    var k = clave(nombre);
    var o = oficinas.filter(function (x) {
      return clave(x.nombre) === k || (x.alias || []).some(function (a) { return clave(a) === k && k.length >= 3; });
    })[0];
    if (o) return { nombre: o.nombre, existe: true };
    var n = numJuzgado(nombre);
    if (n) return porNumero(n, oficinas);
    return { nombre: nombre.charAt(0).toUpperCase() + nombre.slice(1), existe: false };
  }

  // Oficinas cuyo nombre (o alias) aparece tal cual en el texto: "OGAAC", "Mesa General de Entradas"…
  function porNombreEn(texto, oficinas) {
    var t = ' ' + clave(texto) + ' ', pegado = norm(texto).replace(/[^a-z0-9]+/g, '');
    var o = oficinas.filter(function (x) {
      if (numJuzgado(x.nombre)) return false;                    // los juzgados se reconocen por número
      return [x.nombre].concat(x.alias || []).some(function (nom) {
        var k = clave(nom);
        if (k.length < 4) return false;
        return t.indexOf(' ' + k + ' ') !== -1 || (/^[a-z]+$/.test(k) && pegado.indexOf(k) !== -1);
      });
    })[0];
    return o ? { nombre: o.nombre, existe: true } : null;
  }

  function oficinaEn(linea, oficinas) {
    var m = /\b(oficina|dependencia|juzgado|organismo|[aá]rea|sede)\s*:\s*([^|;\t]+)/i.exec(linea);
    if (m) {
      var bruto = m[2].split(/\s+-\s+|\s{2,}|,\s*piso\b/i)[0].replace(/\s*\bpiso\s*\d+.*$/i, '').trim();
      if (/^\d{1,3}$/.test(bruto)) return porNumero(sinCeros(bruto), oficinas);
      var r = resolver(bruto, oficinas);
      if (r) { r.rotulada = true; return r; }
    }
    var n = numJuzgado(linea);
    if (n) return porNumero(n, oficinas);
    return porNombreEn(linea, oficinas) || primeraCelda(linea, oficinas);
  }

  // Fila de tabla (tabs, varios espacios, " | " o ";") cuya 1ª celda es texto y no un dato de impresora:
  // suele ser la oficina ("Fiscalía N° 3 <tab> SP 3710DN <tab> 10.0.12.3").
  var NO_OFICINA = /^(oficina|dependencia|juzgado|organismo|area|sede|modelo|marca|impresora|impresoras|ip|mac|serie|n de serie|host|hostname|sector|estado|conexion|ubicacion|piso|n|nro|item)$/;
  function primeraCelda(linea, oficinas) {
    var celdas = linea.split(/\t|\s{2,}|\s\|\s|;/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (celdas.length < 3) return null;
    var c0 = celdas[0], k = clave(c0);
    if (!/[a-z]/.test(k) || c0.length > 60 || /\d{3}/.test(c0) || /^[a-z]+-[a-z0-9-]+$/i.test(c0)) return null;
    if (NO_OFICINA.test(k) || MARCAS[k] || ESTADOS[k] || /^piso \d+$/.test(k)) return null;
    return resolver(c0, oficinas);
  }

  /* ---------- Una línea → los datos de impresora que tenga ---------- */
  function leerLinea(linea, oficinas) {
    var c = {}, resto = ' ' + linea + ' ', m;
    function sacar(txt) { resto = resto.replace(txt, ' '); }

    // MAC (antes que nada: sus grupos de números confunden al resto)
    m = /(?:^|[^0-9a-f:-])([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5})(?![0-9a-f:-])/i.exec(resto) ||
        /(?:^|[^0-9a-f.])([0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})(?![0-9a-f.])/i.exec(resto) ||
        /\bmac\b\s*[:=#-]?\s*([0-9a-f]{12})\b/i.exec(resto);
    if (m) { c.mac = mac(m[1]); sacar(m[1]); }

    // IP
    m = /(?:^|[^\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.]*\d)/.exec(resto);
    if (m && ipValida(m[1])) { c.ip = m[1]; sacar(m[1]); }

    // Host: con etiqueta, o una palabra con guion y números (red-juzcyf99-1, foto-ogaac-99…)
    m = /\b(?:hostname|nombre\s+de\s+host|nombre\s+de\s+equipo|host|equipo)\b\s*[:=#-]?\s*([a-z0-9][a-z0-9._-]{2,})/i.exec(resto);
    if (m) { c.hostname = m[1].replace(/[.]+$/, ''); sacar(m[0]); }

    // Modelo (Ricoh y parecidos: P 311, MP 2554, MP C3004, IM C3000, SP 3710DN…)
    m = /(?:^|[^a-z0-9])((?:ricoh\s+)?(?:aficio\s+)?(im|mp|sp|p|m)\s?(c\s?)?(\d{3,4})([a-z]{0,4}))(?![a-z0-9])/i.exec(resto);
    if (m) {
      c.modelo = m[2].toUpperCase() + ' ' + (m[3] ? 'C' : '') + m[4] + m[5].toUpperCase();
      sacar(m[1]);
    }

    // N° de serie con etiqueta
    m = /(?:n[°ºo]?\.?\s*(?:de\s+)?serie|nro\.?\s*(?:de\s+)?serie|serial|serie|s\/n)\s*[:=#.-]?\s*([a-z0-9][a-z0-9-]{4,})/i.exec(resto);
    if (m) { c.serie = m[1].toUpperCase(); sacar(m[0]); }

    // Palabras sueltas: host sin etiqueta, serie sin etiqueta (mayúsculas, letras y 3+ números) y MAC sin separadores
    resto.split(/[\s|;,()[\]]+/).forEach(function (tk) {
      tk = tk.replace(/^[:.\-]+|[:.\-]+$/g, '');
      if (!tk) return;
      if (!c.hostname && tk.length >= 6 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?:\.[a-z0-9-]+)*$/i.test(tk) && /\d/.test(tk)) {
        c.hostname = tk;
      } else if (/^[0-9A-F]{12}$/.test(tk) && /[A-F]/.test(tk) && /\d/.test(tk)) {
        if (!c.mac) c.mac = mac(tk);
      } else if (!c.serie && /^[A-Z0-9]{9,14}$/.test(tk) && /[A-Z]/.test(tk) && (tk.match(/\d/g) || []).length >= 3) {
        c.serie = tk;
      }
    });

    var n = norm(linea);
    if (/\busb\b/.test(n)) c.conexion = 'USB';
    else if (/\bwi-?fi\b|\binalambric/.test(n)) c.conexion = 'Wi-Fi';
    else if (/\bconexion\s*[:=]?\s*red\b/.test(n)) c.conexion = 'Red';
    m = /\b(en uso|sin uso|fuera de servicio|en reparacion)\b/.exec(n);
    if (m) c.estado = ESTADOS[m[1]];
    m = /\b(?:sector|lugar|ubicaci[oó]n\s+f[ií]sica)\s*[:=]\s*([^|;\t]+)/i.exec(linea);
    if (m) c.sector = m[1].split(/\s{2,}/)[0].trim();
    m = /\b(hp|lexmark|brother|epson|samsung|kyocera|xerox|canon|ricoh|konica|oki|pantum)\b/.exec(n);
    if (m) c.marca = MARCAS[m[1]];

    var piso = /\bpiso\s*(\d{1,2})\b/.exec(n);
    return { campos: c, oficina: oficinaEn(linea, oficinas), piso: piso ? 'Piso ' + sinCeros(piso[1]) : '' };
  }

  // Oficina a partir del host: "foto-juzcyf99" → Juzgado N° 99, "red-ogaac-99" → OGAAC.
  function oficinaDelHost(host, oficinas) {
    if (!host) return null;
    var m = /juz[a-z]*?(\d{1,3})(?!\d)/i.exec(host);
    if (m) return porNumero(sinCeros(m[1]), oficinas);
    return porNombreEn(host, oficinas);
  }

  /* ---------- Texto completo → impresoras ---------- */
  // Cada renglón con datos se suma a la impresora en curso, salvo que repita un dato que ya tiene
  // (otra IP, otro modelo…): ahí empieza otra. Los renglones vacíos NO la cortan (lo copiado de una
  // web o un PDF suele traerlos entre dato y dato). Un renglón con solo un juzgado u oficina vale
  // para las impresoras que siguen (encabezado).
  // texto puede ser una lista (los "cuadros" de la ventana): lo de un cuadro nunca se mezcla con el de
  // otro; un encabezado tampoco pasa al cuadro siguiente.
  function analizar(texto, oficinas) {
    oficinas = oficinas || [];
    var cuadros = Array.isArray(texto) ? texto : [texto];
    var res = [], actual = null, ctxOf = null, ctxPiso = '', corte = false, desde = 0, ofFinal = null;

    function cerrar() {
      if (actual && CORE.some(function (k) { return k !== 'mac' && actual.campos[k]; })) res.push(actual);
      actual = null;
    }

    cuadros.forEach(function (cuadro) {
      ctxOf = null; ctxPiso = ''; corte = false; desde = res.length; ofFinal = null;
      String(cuadro == null ? '' : cuadro).replace(/\r/g, '').split('\n').forEach(function (l) {
        var t = l.trim();
        if (!t) { corte = true; return; }
        var tras = corte;
        corte = false;
        var d = leerLinea(t, oficinas);
        var core = CORE.filter(function (k) { return d.campos[k]; });
        if (!core.length) {
          if (actual && Object.keys(d.campos).length) {           // "USB", "En uso", "Sector: …" en su propio renglón
            Object.keys(d.campos).forEach(function (k) { if (!actual.campos[k]) actual.campos[k] = d.campos[k]; });
          }
          if (d.oficina) {
            // "Oficina: …" pegado al final del bloque es de esa impresora; tras un renglón vacío es encabezado.
            if (actual && !actual.ofLinea && d.oficina.rotulada && !tras) actual.ofLinea = d.oficina;
            else { cerrar(); ctxOf = d.oficina; ctxPiso = d.piso || ''; ofFinal = d.oficina; }
          } else if (d.piso) {
            if (actual && !actual.piso) actual.piso = d.piso; else ctxPiso = d.piso;
          }
          return;
        }
        ofFinal = null;
        if (!actual || core.some(function (k) { return actual.campos[k]; })) {
          cerrar();
          actual = { campos: {}, ofLinea: null, ofCtx: ctxOf, piso: ctxPiso, texto: [] };
        }
        Object.keys(d.campos).forEach(function (k) { if (!actual.campos[k]) actual.campos[k] = d.campos[k]; });
        if (d.oficina && !actual.ofLinea) {
          actual.ofLinea = d.oficina;
          // El piso del encabezado es de SU oficina: no pasa a otra que venga en la misma fila.
          if (actual.ofCtx && clave(actual.ofCtx.nombre) !== clave(d.oficina.nombre)) actual.piso = '';
        }
        if (d.piso) actual.piso = d.piso;
        actual.texto.push(t);
      });
      cerrar();
      // La oficina escrita al final del cuadro, después de todo, es de las que quedaron sin oficina en ese cuadro.
      if (ofFinal) res.slice(desde).forEach(function (r) { if (!r.ofLinea && !r.ofCtx) r.ofLinea = ofFinal; });
    });

    // Dónde está cargado hoy cada IP / MAC / serie / host, para avisar repetidas.
    var cargadas = {};
    oficinas.forEach(function (o) {
      (o.impresoras || []).forEach(function (p) {
        ['ip', 'mac', 'serie', 'hostname'].forEach(function (k) {
          if (p[k]) cargadas[k + ':' + String(p[k]).toLowerCase().replace(k === 'mac' ? /[^0-9a-f]/g : /^$/, '')] = o.nombre;
        });
      });
    });
    var vistas = {};

    return res.map(function (r) {
      var c = r.campos, datos = {};
      if (!c.marca) c.marca = 'Ricoh';
      if (!c.conexion && c.ip) c.conexion = 'Red';
      ORDEN.forEach(function (k) { if (c[k]) datos[k] = c[k]; });
      var claves = ['ip', 'mac', 'serie', 'hostname'].filter(function (k) { return c[k]; }).map(function (k) {
        return k + ':' + String(c[k]).toLowerCase().replace(k === 'mac' ? /[^0-9a-f]/g : /^$/, '');
      });
      var yaEn = claves.map(function (k) { return cargadas[k]; }).filter(Boolean)[0] || '';
      var repetida = claves.some(function (k) { return vistas[k]; });
      claves.forEach(function (k) { vistas[k] = true; });
      var of = r.ofLinea || r.ofCtx || oficinaDelHost(c.hostname, oficinas);
      return { datos: datos, oficina: of ? of.nombre : '', piso: r.piso || '', yaEn: yaEn, repetida: repetida, texto: r.texto.join('\n') };
    });
  }

  /* ---------- Pantalla ---------- */
  var UI, A, $, esc, icono;
  var dlg, items = [], timer = null;

  function titulo(d) {
    return d.modelo ? (d.marca && d.marca !== 'Ricoh' ? d.marca + ' ' : 'Ricoh ') + d.modelo : (d.marca || 'Impresora');
  }

  function chip(ico, etq, valor, mono) {
    return '<span class="chip' + (mono ? ' chip-mono' : '') + '">' + icono(ico) + (etq ? '<b>' + esc(etq) + '</b>' : '') +
      '<span>' + esc(valor) + '</span></span>';
  }

  function htmlItem(it, i) {
    var d = it.datos, chips = '';
    if (d.ip) chips += chip('network', '', d.ip, true);
    if (d.hostname) chips += chip('server', 'Host', d.hostname, true);
    if (d.mac) chips += chip('hash', 'MAC', d.mac, true);
    if (d.serie) chips += chip('barcode', 'Serie', d.serie, true);
    if (d.sector) chips += chip('pin', '', d.sector);
    if (d.conexion) chips += chip('plug', 'Conexión', d.conexion);
    if (d.estado) chips += chip('info', '', d.estado);
    var aviso = it.yaEn ? '<span class="pill pill-mod" title="Esa IP, MAC, serie o host ya está cargada">Ya está en «' + esc(it.yaEn) + '»</span>'
      : it.repetida ? '<span class="pill pill-mod">Repetida en lo pegado</span>' : '';
    return '<div class="pg-item' + (it.incluir ? '' : ' fuera') + '" data-i="' + i + '">' +
      '<label class="sel-check pg-check" title="Cargar esta impresora"><input type="checkbox" data-incluir' + (it.incluir ? ' checked' : '') +
      ' aria-label="Cargar ' + esc(titulo(d)) + '"><span class="sel-caja">' + icono('check') + '</span></label>' +
      '<div class="pg-main">' +
      '<div class="pg-titulo">' + esc(titulo(d)) + aviso + '</div>' +
      (chips ? '<div class="p-chips">' + chips + '</div>' : '') +
      '<div class="pg-oficina">' + icono('building') +
      '<input type="text" data-oficina list="oficinasPegar" autocomplete="off" placeholder="¿A qué oficina va?" value="' + esc(it.oficina) + '" aria-label="Oficina de ' + esc(titulo(d)) + '">' +
      '<span class="pg-nueva" hidden>Oficina nueva</span></div>' +
      '</div></div>';
  }

  function pintarItem(el) {
    var it = items[+el.getAttribute('data-i')];
    var r = resolver(it.oficina, A.lista());
    var nueva = el.querySelector('.pg-nueva');
    nueva.hidden = !r || r.existe;
    if (r && !r.existe) nueva.textContent = 'Oficina nueva' + (it.piso ? ' · ' + it.piso : '');
    el.classList.toggle('fuera', !it.incluir);
    el.classList.toggle('sin-oficina', it.incluir && !r);
  }

  function pintarCuenta() {
    var elegidas = items.filter(function (it) { return it.incluir; });
    var faltan = elegidas.filter(function (it) { return !it.oficina.trim(); }).length;
    var ok = $('#pegarOk');
    ok.disabled = !elegidas.length || !!faltan;
    ok.innerHTML = icono('save') + 'Cargar ' + (elegidas.length === 1 ? '1 impresora' : elegidas.length + ' impresoras');
    $('#pegarCuenta').textContent = faltan ? (faltan === 1 ? 'Falta elegir la oficina de 1 impresora' : 'Falta elegir la oficina de ' + faltan + ' impresoras') : '';
  }

  /* ---------- Cuadros: uno o varios textos pegados (lo de cada cuadro no se mezcla con lo de otro) ---------- */
  var EJEMPLO = 'Ej:\nJuzgado N° 30 - Piso 7\nRicoh MP 2554   10.0.12.8   00:11:22:AA:BB:01   G145R000001\nRicoh P 311   10.0.12.34   00:11:22:AA:BB:02   5873Z000002';

  function cuadros() { return Array.prototype.slice.call($('#pegarCuadros').querySelectorAll('textarea')); }
  function textos() { return cuadros().map(function (t) { return t.value; }); }

  function nuevoCuadro(texto) {
    var div = document.createElement('div');
    div.className = 'pg-cuadro';
    div.innerHTML = '<span class="pg-cuadro-num"></span>' +
      '<textarea rows="5" spellcheck="false" autocomplete="off"></textarea>' +
      '<button class="icon-btn pg-quitar" type="button" data-quitar title="Quitar este cuadro" aria-label="Quitar este cuadro">' + icono('x') + '</button>';
    div.querySelector('textarea').value = texto || '';
    $('#pegarCuadros').appendChild(div);
    return div.querySelector('textarea');
  }

  function numerar() {
    var ts = cuadros();
    $('#pegarCuadros').classList.toggle('varios', ts.length > 1);
    ts.forEach(function (t, i) {
      if (i) t.removeAttribute('id'); else t.id = 'pegarTexto';   // el 1º lleva la etiqueta "Texto copiado"
      t.placeholder = i ? 'Datos de otra impresora…' : EJEMPLO;
      if (i) t.setAttribute('aria-label', 'Cuadro ' + (i + 1)); else t.removeAttribute('aria-label');
      t.parentNode.querySelector('.pg-cuadro-num').textContent = 'Cuadro ' + (i + 1);
    });
  }

  // Abre otro cuadro (o usa el último si está vacío), opcionalmente con texto ya pegado.
  function otroCuadro(texto) {
    var ts = cuadros(), t = ts[ts.length - 1];
    if (!t || t.value.trim()) t = nuevoCuadro();
    if (texto) t.value = texto;
    numerar();
    t.focus();
    t.scrollIntoView({ block: 'nearest' });
    if (texto) analizarTexto();
  }

  function analizarTexto() {
    var txt = textos(), out = $('#pegarResultado');
    items = analizar(txt, A.lista()).map(function (it) { it.incluir = !it.yaEn && !it.repetida; return it; });
    if (!txt.join('').trim()) out.innerHTML = '';
    else if (!items.length) {
      out.innerHTML = '<p class="aviso-ejemplo pg-vacio">' + icono('info') +
        '<span>No encontré impresoras en el texto. Tiene que haber al menos una IP, un N° de serie, un modelo o un host.</span></p>';
    } else {
      var yaCargadas = items.filter(function (it) { return it.yaEn; }).length;
      out.innerHTML = '<div class="pg-cabecera">' +
        '<p>Encontré <b>' + (items.length === 1 ? '1 impresora' : items.length + ' impresoras') + '</b>' +
        (yaCargadas ? ' · ' + yaCargadas + (yaCargadas === 1 ? ' ya estaba cargada (quedó destildada)' : ' ya estaban cargadas (quedaron destildadas)') : '') + '</p>' +
        '<div class="pg-todas"><input type="text" id="pegarOficinaTodas" list="oficinasPegar" autocomplete="off" placeholder="Oficina para todas" aria-label="Oficina para todas las tildadas">' +
        '<button class="btn btn-ghost" type="button" id="pegarAplicar">Aplicar</button></div>' +
        '</div><div class="pg-lista">' + items.map(htmlItem).join('') + '</div>';
      out.querySelectorAll('.pg-item').forEach(pintarItem);
    }
    pintarCuenta();
  }

  function abrir(texto) {
    $('#oficinasPegar').innerHTML = A.lista().map(function (o) { return o.nombre; }).sort(App.Busqueda.comparar)
      .map(function (n) { return '<option value="' + esc(n) + '">'; }).join('');
    $('#pegarCuadros').innerHTML = '';
    nuevoCuadro(texto);
    numerar();
    analizarTexto();
    UI.abrirModal(dlg);
    $('.modal-body', dlg).scrollTop = 0;
    setTimeout(function () { if (!texto) $('#pegarTexto').focus(); }, 60);
  }

  function intentarCerrar() {
    if (!items.length) { UI.cerrarModal(dlg); return; }
    UI.confirmar({ titulo: '¿Descartar lo pegado?', texto: 'Las impresoras reconocidas no se van a cargar.', ok: 'Descartar' })
      .then(function (si) { if (si) UI.cerrarModal(dlg); });
  }

  function cargar(ev) {
    ev.preventDefault();
    var oficinas = A.lista(), grupos = new Map(), cant = 0;
    items.forEach(function (it) {
      if (!it.incluir) return;
      var r = resolver(it.oficina, oficinas);
      if (!r) return;
      var k = clave(r.nombre), g = grupos.get(k);
      if (!g) {
        g = { nombre: r.nombre, existente: r.existe ? A.porNombre(r.nombre) : null, piso: it.piso, impresoras: [] };
        grupos.set(k, g);
      }
      g.impresoras.push(Object.assign({}, it.datos));
      cant++;
    });
    if (!cant) return;
    var lista = Array.from(grupos.values()), guardar = [], antes = [];
    lista.forEach(function (g) {
      if (g.existente) {
        var a = Object.assign({}, g.existente);
        delete a._origen;
        antes.push(a);
        guardar.push(Object.assign({}, a, { impresoras: (a.impresoras || []).concat(g.impresoras) }));
      } else {
        var o = { nombre: g.nombre, impresoras: g.impresoras };
        if (g.piso) o.ubicacion = g.piso;
        guardar.push(o);
      }
    });
    var ids = A.guardarVarias(guardar);                       // todas juntas: un solo guardado en datos.json
    var nuevas = ids.filter(function (id, i) { return !lista[i].existente; });
    items = [];
    UI.cerrarModal(dlg);
    App.mostrarOficina(ids[0]);
    if (!A.puedeGuardar()) {
      UI.toast('No se pudo guardar en este navegador (almacenamiento bloqueado). Exportá una copia antes de cerrar.', { tipo: 'error', duracion: 8000 });
      return;
    }
    UI.toast('Se cargaron <b>' + (cant === 1 ? '1 impresora' : cant + ' impresoras') + '</b> en ' +
      (lista.length === 1 ? '<b>' + esc(lista[0].nombre) + '</b>' : '<b>' + lista.length + ' oficinas</b>') +
      (nuevas.length ? ' (' + (nuevas.length === 1 ? '1 nueva' : nuevas.length + ' nuevas') + ')' : ''), {
      duracion: 9000,
      accion: { texto: 'Deshacer', fn: function () { A.guardarVarias(antes, nuevas); } }   // vuelve todo como estaba
    });
  }

  function init() {
    UI = App.UI; A = App.Almacen; $ = UI.$; esc = UI.esc; icono = UI.icono;
    dlg = $('#modalPegar');
    UI.prepararModal(dlg, intentarCerrar);
    dlg.querySelectorAll('[data-cerrar]').forEach(function (b) { b.addEventListener('click', intentarCerrar); });
    $('#formPegar').addEventListener('submit', cargar);
    $('#pegarCuadros').addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(analizarTexto, 250); });
    $('#pegarCuadros').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-quitar]');
      if (!b) return;
      var div = b.closest('.pg-cuadro'), vecino = div.previousElementSibling || div.nextElementSibling;
      div.remove();
      numerar();
      if (vecino) vecino.querySelector('textarea').focus();
      analizarTexto();
    });
    $('#pegarOtro').addEventListener('click', function () { otroCuadro(); });

    var out = $('#pegarResultado');
    out.addEventListener('change', function (ev) {
      if (!ev.target.matches('[data-incluir]')) return;
      var el = ev.target.closest('.pg-item');
      items[+el.getAttribute('data-i')].incluir = ev.target.checked;
      pintarItem(el);
      pintarCuenta();
    });
    out.addEventListener('input', function (ev) {
      if (!ev.target.matches('[data-oficina]')) return;
      var el = ev.target.closest('.pg-item');
      items[+el.getAttribute('data-i')].oficina = ev.target.value;
      pintarItem(el);
      pintarCuenta();
    });
    out.addEventListener('click', function (ev) {
      if (!ev.target.closest('#pegarAplicar')) return;
      var v = $('#pegarOficinaTodas').value.trim();
      if (!v) { $('#pegarOficinaTodas').focus(); return; }
      out.querySelectorAll('.pg-item').forEach(function (el) {
        var it = items[+el.getAttribute('data-i')];
        if (!it.incluir) return;
        it.oficina = v;
        el.querySelector('[data-oficina]').value = v;
        pintarItem(el);
      });
      pintarCuenta();
    });
    out.addEventListener('keydown', function (ev) {      // Enter en "Oficina para todas" aplica (no carga)
      if (ev.ctrlKey || ev.metaKey) return;              // Ctrl+Enter sí carga (atajo en app.js)
      if (ev.key === 'Enter' && ev.target.id === 'pegarOficinaTodas') { ev.preventDefault(); $('#pegarAplicar').click(); }
      else if (ev.key === 'Enter' && ev.target.matches('[data-oficina]')) ev.preventDefault();
    });

    // Ctrl+V en la página, fuera de un lugar donde se escribe (buscador, campos…): abre esta ventana con lo
    // copiado. Con esta ventana abierta, Ctrl+V fuera de los cuadros lo pone en otro cuadro.
    document.addEventListener('paste', function (ev) {
      var t = ev.target;
      if (t && t.closest && (t.closest('input, textarea, select, [contenteditable="true"]') || t.isContentEditable)) return;
      var abiertos = document.querySelectorAll('dialog[open]');
      if (abiertos.length && abiertos[abiertos.length - 1] !== dlg) return;
      var txt = (ev.clipboardData && ev.clipboardData.getData('text')) || '';
      ev.preventDefault();
      if (dlg.open) { if (txt.trim()) otroCuadro(txt); }
      else abrir(txt);
    });
  }

  App.Pegar = { analizar: analizar, resolver: resolver, init: init, abrir: abrir };
})();
