// ── Firebase init ────────────────────────────────────────────────────────────
firebase.initializeApp({
  apiKey: "AIzaSyDTKYcxIp3TZsY4Nc6C-urOLq824i3sCGA",
  authDomain: "baby-shower-d44f0.firebaseapp.com",
  projectId: "baby-shower-d44f0",
  storageBucket: "baby-shower-d44f0.firebasestorage.app",
  messagingSenderId: "490774326673",
  appId: "1:490774326673:web:e35275290ea9f7da50fe30"
});
var db = firebase.firestore();

// ── Constantes ───────────────────────────────────────────────────────────────
var SHEET_CSV = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQT2o7lyK2FwCQXclPQplfuPyEMYXz_LGEij6bYhshfWm3QE8y0IO_RilotAtjY5mVKgrHff_XUiTF7/pub?output=csv';

var ICON_MAP = {
  'Cuna con colchón': '🛏️',
  'Kit de biberones': '🍼',
  'Bañera ergonómica': '🛁',
  'Silla para auto': '🚗',
  'Ropa 0-3 meses': '👕',
  'Peluche suave': '🧸',
  'Kit de higiene bebé': '🧴',
  'Libros de tela': '📚',
  'Proyector musical': '🎵',
  'Pañalera grande': '🧷',
  'Termómetro digital': '🌡️',
  'Hamaca mecedora': '🪑'
};

// ── Estado ───────────────────────────────────────────────────────────────────
var gifts = [];
var reservations = {};
var currentGiftId = null;
var bsModalReservar = null;
var bsModalVerReservas = null;

// ── Utilidades ───────────────────────────────────────────────────────────────

function parseCSVLine(line) {
  var result = [];
  var current = '';
  var inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function sanitize(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ── Datos ────────────────────────────────────────────────────────────────────

function fetchSheetData() {
  return fetch(SHEET_CSV)
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    })
    .then(function(text) {
      var lines = text.trim().split('\n').filter(function(l) { return l.trim(); });
      return lines.map(function(line, i) {
        var cols = parseCSVLine(line);
        var name = cols[0] || '';
        if (!name) return null;
        var unlimited = (cols[1] || '').toLowerCase() === 'ilimitado';
        var limitVal = parseInt(cols[2], 10);
        // limit: -1 = ilimitado, 1 = un solo dueño, N = hasta N reservas
        var limit = unlimited ? -1 : (limitVal > 0 ? limitVal : 1);
        return {
          id: String(i + 1),
          name: name,
          unlimited: unlimited,
          limit: limit,
          priority: (cols[3] || '').toLowerCase().indexOf('alta') >= 0 ? 'high' : 'other',
          icon: ICON_MAP[name] || '🎁',
          desc: cols[4] || ''
        };
      }).filter(Boolean);
    })
    .catch(function(e) {
      console.warn('Error leyendo hoja:', e);
      return [];
    });
}

// ── Firestore ────────────────────────────────────────────────────────────────

function listenReservations() {
  db.collection('reservations').onSnapshot(function(snapshot) {
    reservations = {};
    snapshot.forEach(function(d) {
      var data = d.data();
      var gid = data.giftId;
      if (!reservations[gid]) reservations[gid] = [];
      reservations[gid].push({ reservedBy: data.reservedBy, giftName: data.giftName });
    });
    renderGifts();
    renderPanel();
  }, function(err) {
    console.error('Error Firestore:', err.message);
  });
}

function saveReservation(giftId, giftName, reservedBy, limit) {
  var clean = String(reservedBy || 'Reservado').replace(/[<>'"%;()&+]/g, '').trim();
  if (!clean) clean = 'Reservado';

  var payload = {
    giftId: giftId,
    giftName: giftName,
    reservedBy: clean,
    timestamp: firebase.firestore.FieldValue.serverTimestamp()
  };

  // limit === -1 → ilimitado: siempre se puede agregar
  if (limit === -1) {
    return db.collection('reservations').add(payload);
  }

  // limit > 1 → múltiple pero acotado: usar subcolección o docs con sufijo
  if (limit > 1) {
    return db.runTransaction(function(tx) {
      var colRef = db.collection('reservations');
      return colRef.where('giftId', '==', giftId).get().then(function(snap) {
        if (snap.size >= limit) throw new Error('Este regalo ya alcanzó su límite de reservas');
        return colRef.add(payload);
      });
    });
  }

  // limit === 1 → solo una reserva (comportamiento original)
  var docRef = db.collection('reservations').doc(String(giftId));
  return db.runTransaction(function(tx) {
    return tx.get(docRef).then(function(doc) {
      if (doc.exists) throw new Error('Este regalo ya fue reservado');
      tx.set(docRef, payload);
    });
  });
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderGifts() {
  var highEl = document.getElementById('high-priority');
  var otherEl = document.getElementById('other-gifts');
  highEl.innerHTML = '';
  otherEl.innerHTML = '';

  if (gifts.length === 0) {
    var errorMsg = document.createElement('div');
    errorMsg.className = 'alert alert-warning text-center mt-4';
    errorMsg.style.gridColumn = '1 / -1';
    if (window.location.protocol === 'file:') {
      errorMsg.innerHTML = '⚠️ <strong>Aviso:</strong> Estás abriendo el archivo directamente (<code>file://</code>). Los navegadores bloquean la conexión a la base de datos por seguridad. Por favor, usa una extensión como <strong>Live Server</strong> o sube la página a un hosting.';
    } else {
      errorMsg.innerHTML = 'No se pudieron cargar los regalos o la lista está vacía. Verifica la hoja de cálculo.';
    }
    highEl.appendChild(errorMsg);
    return;
  }

  gifts.forEach(function(g) {
    var giftRes = reservations[g.id] || [];
    var reservedCount = giftRes.length;
    // isFull: sin hueco disponible
    var isFull = g.limit !== -1 && reservedCount >= g.limit;

    var card = document.createElement('div');
    card.className = 'gift-card' + (isFull ? ' reserved' : '');

    var badge = document.createElement('span');
    if (g.limit === -1) {
      // Ilimitado
      badge.className = 'badge available';
      badge.textContent = reservedCount > 0 ? reservedCount + ' reserva(s)' : 'Disponible';
    } else if (g.limit > 1) {
      // Límite numérico
      badge.className = 'badge ' + (isFull ? 'reserved' : 'available');
      badge.textContent = isFull
        ? 'Completo (' + g.limit + '/' + g.limit + ')'
        : reservedCount + '/' + g.limit + ' reservas';
    } else {
      // Solo 1
      badge.className = 'badge ' + (isFull ? 'reserved' : 'available');
      badge.textContent = isFull ? 'Reservado' : 'Disponible';
    }

    var icon = document.createElement('div');
    icon.className = 'gift-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = g.icon;

    var name = document.createElement('div');
    name.className = 'gift-name';
    name.textContent = g.name;

    var desc = document.createElement('div');
    desc.className = 'gift-desc';
    desc.textContent = g.desc;

    var priority = document.createElement('div');
    priority.className = 'gift-priority' + (g.priority === 'high' ? ' high' : '');
    priority.textContent = g.priority === 'high' ? '★ Alta prioridad' : '☆ Opcional';

    var canReserve = !isFull;
    var btn = document.createElement('button');
    btn.className = 'btn bs-btn-primary btn-sm' + (!canReserve ? ' disabled' : '');
    btn.textContent = !canReserve ? (g.limit === 1 ? 'Reservado' : 'Completo') : 'Reservar';
    btn.disabled = !canReserve;
    if (canReserve) {
      btn.addEventListener('click', (function(id) {
        return function() { openModalReservar(id); };
      })(g.id));
    }

    var btnInfo = document.createElement('button');
    btnInfo.className = 'btn bs-btn-outline btn-sm';
    btnInfo.textContent = '👤 Ver reserva';
    btnInfo.addEventListener('click', (function(id, n) {
      return function() { openModalVerReservas(id, n); };
    })(g.id, g.name));

    var btnRow = document.createElement('div');
    btnRow.className = 'btn-row';
    btnRow.appendChild(btn);
    btnRow.appendChild(btnInfo);

    card.appendChild(badge);
    card.appendChild(icon);
    card.appendChild(name);
    card.appendChild(desc);
    card.appendChild(priority);
    card.appendChild(btnRow);

    (g.priority === 'high' ? highEl : otherEl).appendChild(card);
  });
}

function renderPanel() {
  var list = document.getElementById('panel-list');
  var allEntries = [];
  Object.keys(reservations).forEach(function(k) {
    reservations[k].forEach(function(r) { allEntries.push(r); });
  });
  if (allEntries.length === 0) {
    list.innerHTML = '<li class="panel-empty">Aún no hay reservas 🌸</li>';
    return;
  }
  list.innerHTML = allEntries.map(function(r) {
    return '<li class="panel-item">'
      + '<span class="panel-gift">' + sanitize(r.giftName) + '</span>'
      + '<span class="panel-person">👤 ' + sanitize(r.reservedBy) + '</span>'
      + '</li>';
  }).join('');
}

// ── Modales ──────────────────────────────────────────────────────────────────

function openModalReservar(id) {
  currentGiftId = id;
  var g = gifts.filter(function(g) { return g.id === id; })[0];
  document.getElementById('modal-gift-name').textContent = '"' + g.name + '"';
  document.getElementById('modal-confirm-text').textContent = '¿Deseas reservar este regalo?';
  bsModalReservar.show();
}

function openModalVerReservas(giftId, giftName) {
  var giftRes = reservations[giftId] || [];
  document.getElementById('modal-info-gift').textContent = '"' + giftName + '"';
  var list = document.getElementById('modal-info-list');
  if (giftRes.length === 0) {
    list.innerHTML = '<li class="modal-reserva-empty">Aún sin reservar 🌸</li>';
  } else {
    list.innerHTML = giftRes.map(function(r) {
      return '<li class="modal-reserva-item">👤 ' + sanitize(r.reservedBy) + '</li>';
    }).join('');
  }
  bsModalVerReservas.show();
}

// ── Event listeners ──────────────────────────────────────────────────────────

document.getElementById('btn-confirm').addEventListener('click', function() {
  var g = gifts.filter(function(g) { return g.id === currentGiftId; })[0];
  if (!g) return;

  var confirmBtn = document.getElementById('btn-confirm');
  confirmBtn.disabled = true;
  confirmBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Guardando...';
  bsModalReservar.hide();

  saveReservation(g.id, g.name, 'Reservado', g.limit)
    .catch(function(err) {
      console.error('Error al reservar:', err);
      alert('No se pudo guardar la reserva. Intenta de nuevo.');
    })
    .finally(function() {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = 'Sí';
    });
});

document.getElementById('btn-reservas').addEventListener('click', function() {
  renderPanel();
});

// ── Init ─────────────────────────────────────────────────────────────────────

bsModalReservar    = new bootstrap.Modal(document.getElementById('modalReservar'));
bsModalVerReservas = new bootstrap.Modal(document.getElementById('modalVerReservas'));

fetchSheetData().then(function(data) {
  gifts = data;
  renderGifts();
  listenReservations();
});
