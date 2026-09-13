// ============================================================
// NA'KUL HALAL — Serveur backend
// v3 : notifications push + suivi GPS en temps réel
// ============================================================
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const Database = require("better-sqlite3");
const webpush = require("web-push");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const db = new Database("/app/data/takul.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS restaurants (
    id TEXT PRIMARY KEY, city TEXT, name TEXT, cuisine TEXT, active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS menu_items (
    id TEXT PRIMARY KEY, restaurant_id TEXT, name TEXT, price REAL
  );
  CREATE TABLE IF NOT EXISTS drivers (
    id TEXT PRIMARY KEY, city TEXT, name TEXT, active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    city TEXT, restaurant_id TEXT, restaurant_name TEXT,
    items TEXT, items_total REAL DEFAULT 0, delivery_fee REAL DEFAULT 2.5,
    tip REAL DEFAULT 0, donation REAL DEFAULT 0,
    total REAL, address TEXT,
    status TEXT DEFAULT 'nouvelle',
    driver_id TEXT, driver_name TEXT,
    driver_lat REAL, driver_lng REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS cagnotte_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL, amount REAL NOT NULL, note TEXT, order_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,        -- 'client' | 'restaurant' | 'driver'
    ref_id TEXT NOT NULL,      -- id de commande (client), id restaurant, ou nom du livreur
    city TEXT,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migration : l'ancienne contrainte UNIQUE portait sur endpoint seul, ce qui empêchait
// un même téléphone/navigateur de s'abonner à plusieurs rôles à la fois (utile en test,
// où client/restaurant/livreur sont ouverts dans le même navigateur). On la remplace
// par une contrainte composite (endpoint + role + ref_id).
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL, ref_id TEXT NOT NULL, city TEXT,
      endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_push_unique ON push_subscriptions_v2 (endpoint, role, ref_id);
  `);
  const oldRows = db.prepare("SELECT role, ref_id, city, endpoint, p256dh, auth, created_at FROM push_subscriptions").all();
  const insertV2 = db.prepare("INSERT OR IGNORE INTO push_subscriptions_v2 (role, ref_id, city, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?,?,?)");
  for (const r of oldRows) insertV2.run(r.role, r.ref_id, r.city, r.endpoint, r.p256dh, r.auth, r.created_at);
  db.exec("DROP TABLE IF EXISTS push_subscriptions;");
  db.exec("ALTER TABLE push_subscriptions_v2 RENAME TO push_subscriptions;");
} catch (e) { console.error("Migration push_subscriptions :", e.message); }

function safeAddColumn(table, columnDef) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`); } catch (e) {}
}
safeAddColumn("orders", "items_total REAL DEFAULT 0");
safeAddColumn("orders", "delivery_fee REAL DEFAULT 2.5");
safeAddColumn("orders", "tip REAL DEFAULT 0");
safeAddColumn("orders", "donation REAL DEFAULT 0");

// ---------- Notifications push (VAPID) ----------
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails("mailto:contact@nakulhalal.example", VAPID_PUBLIC, VAPID_PRIVATE);
}

async function sendPush(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (e) {
    // abonnement expiré ou invalide : on le retire silencieusement
    if (e.statusCode === 410 || e.statusCode === 404) {
      db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(subscription.endpoint);
    }
  }
}

async function notifyRole(role, refId, payload) {
  const subs = db.prepare("SELECT * FROM push_subscriptions WHERE role = ? AND ref_id = ?").all(role, String(refId));
  for (const s of subs) {
    await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
  }
}

async function notifyDriversInCity(city, payload) {
  const subs = db.prepare("SELECT * FROM push_subscriptions WHERE role = 'driver' AND city = ?").all(city);
  for (const s of subs) {
    await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
  }
}

app.get("/api/push/public-key", (req, res) => res.json({ publicKey: VAPID_PUBLIC }));

app.post("/api/push/subscribe", (req, res) => {
  const { role, ref_id, city, subscription } = req.body;
  if (!role || !ref_id || !subscription) return res.status(400).json({ error: "Champs manquants" });
  try {
    db.prepare(`
      INSERT INTO push_subscriptions (role, ref_id, city, endpoint, p256dh, auth)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(endpoint, role, ref_id) DO UPDATE SET city=excluded.city
    `).run(role, String(ref_id), city || null, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const ADMIN_KEY = process.env.ADMIN_KEY || "change-moi";
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: "Non autorisé" });
  next();
}

// ============ ADMIN : diagnostic des abonnements notifications ============
app.get("/api/admin/push/subscriptions", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT role, ref_id, city, created_at FROM push_subscriptions ORDER BY id DESC").all();
  res.json({
    count: rows.length,
    subscriptions: rows,
    vapid_configured: Boolean(VAPID_PUBLIC && VAPID_PRIVATE),
    vapid_public_length: VAPID_PUBLIC.length,
    vapid_private_length: VAPID_PRIVATE.length,
  });
});

// ============ ADMIN ============
app.post("/api/admin/restaurants", requireAdmin, (req, res) => {
  const { id, city, name, cuisine } = req.body;
  db.prepare("INSERT INTO restaurants (id, city, name, cuisine) VALUES (?,?,?,?)").run(id, city, name, cuisine);
  res.json({ ok: true });
});
app.post("/api/admin/drivers", requireAdmin, (req, res) => {
  const { id, city, name } = req.body;
  db.prepare("INSERT INTO drivers (id, city, name) VALUES (?,?,?)").run(id, city, name);
  res.json({ ok: true });
});
app.post("/api/admin/menu-items", requireAdmin, (req, res) => {
  const { id, restaurant_id, name, price } = req.body;
  db.prepare("INSERT INTO menu_items (id, restaurant_id, name, price) VALUES (?,?,?,?)").run(id, restaurant_id, name, price);
  res.json({ ok: true });
});
app.post("/api/admin/cagnotte/distribute", requireAdmin, (req, res) => {
  const { amount, note } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Montant invalide" });
  db.prepare("INSERT INTO cagnotte_ledger (type, amount, note) VALUES ('distribution', ?, ?)").run(amount, note || "");
  res.json({ ok: true });
});

// ============ PUBLIC : cagnotte ============
app.get("/api/cagnotte", (req, res) => {
  const contrib = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM cagnotte_ledger WHERE type='contribution'").get().s;
  const dist = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM cagnotte_ledger WHERE type='distribution'").get().s;
  res.json({ balance: contrib - dist, total_collected: contrib, total_distributed: dist });
});
app.get("/api/cagnotte/ledger", (req, res) => {
  res.json(db.prepare("SELECT type, amount, note, created_at FROM cagnotte_ledger ORDER BY id DESC LIMIT 20").all());
});

// ============ PUBLIC : restaurants d'une ville ============
// ============ PUBLIC : liste des villes actives (calculée automatiquement) ============
app.get("/api/cities", (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT city FROM (
      SELECT city FROM restaurants WHERE city IS NOT NULL AND active = 1
      UNION
      SELECT city FROM drivers WHERE city IS NOT NULL AND active = 1
    ) ORDER BY city
  `).all();
  res.json(rows.map((r) => r.city));
});

// ============ PUBLIC : restaurants d'une ville ============
app.get("/api/cities/:city/restaurants", (req, res) => {
  const restos = db.prepare("SELECT * FROM restaurants WHERE city = ? AND active = 1").all(req.params.city);
  res.json(restos.map((r) => ({ ...r, menu: db.prepare("SELECT * FROM menu_items WHERE restaurant_id = ?").all(r.id) })));
});

// ============ CLIENT : créer une commande ============
app.post("/api/orders", async (req, res) => {
  const { city, restaurant_id, restaurant_name, items, items_total = 0, delivery_fee = 2.5, tip = 0, donation = 0, address } = req.body;
  const total = Number(items_total) + Number(delivery_fee) + Number(tip) + Number(donation);
  const info = db.prepare(`
    INSERT INTO orders (city, restaurant_id, restaurant_name, items, items_total, delivery_fee, tip, donation, total, address)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(city, restaurant_id, restaurant_name, JSON.stringify(items), items_total, delivery_fee, tip, donation, total, address);

  if (Number(donation) > 0) {
    db.prepare("INSERT INTO cagnotte_ledger (type, amount, note, order_id) VALUES ('contribution', ?, ?, ?)")
      .run(donation, `Aumône via commande #${info.lastInsertRowid}`, info.lastInsertRowid);
  }

  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(info.lastInsertRowid);
  io.to(`restaurant:${restaurant_id}`).emit("order:new", order);
  notifyRole("restaurant", restaurant_id, {
    title: "🔔 Nouvelle commande",
    body: `Commande #${order.id} — ${Number(order.total).toFixed(2)} €`,
    tag: `order-${order.id}`,
    url: "./takul-restaurant.html",
  });
  res.json(order);
});

app.get("/api/orders/:id", (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!order) return res.status(404).json({ error: "Introuvable" });
  res.json(order);
});

app.get("/api/restaurants/:id/orders", (req, res) => {
  res.json(db.prepare("SELECT * FROM orders WHERE restaurant_id = ? ORDER BY id DESC").all(req.params.id));
});

// ============ RESTAURANT : faire avancer le statut ============
app.patch("/api/orders/:id/status", async (req, res) => {
  const { status } = req.body;
  db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, req.params.id);
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  io.to(`client:${order.id}`).emit("order:updated", order);

  const CLIENT_MESSAGES = {
    acceptee: "✅ Votre commande a été acceptée par le restaurant",
    preparation: "👨‍🍳 Votre commande est en préparation",
    prete: "📦 Votre commande est prête, un livreur va être attribué",
    livree: "🎉 Votre commande a été livrée. Bon appétit !",
  };
  if (CLIENT_MESSAGES[status]) {
    notifyRole("client", order.id, {
      title: "NA'KUL HALAL",
      body: CLIENT_MESSAGES[status],
      tag: `order-${order.id}`,
      url: "./takul-client.html",
    });
  }

  if (status === "prete") {
    io.to(`pool:${order.city}`).emit("order:available", order);
    notifyDriversInCity(order.city, {
      title: "🛵 Nouvelle course disponible",
      body: `${order.restaurant_name} — ${Number(order.total).toFixed(2)} € (dont pourboire ${Number(order.tip).toFixed(2)} €)`,
      tag: `pool-${order.id}`,
      url: "./takul-livreur.html",
    });
  }
  res.json(order);
});

// ============ LIVREUR : pool de sa ville ============
app.get("/api/cities/:city/pool", (req, res) => {
  res.json(db.prepare("SELECT * FROM orders WHERE city = ? AND status = 'prete'").all(req.params.city));
});

// ============ LIVREUR : accepter une commande ============
app.patch("/api/orders/:id/accept", async (req, res) => {
  const { driver_id, driver_name } = req.body;
  db.prepare("UPDATE orders SET status='en_livraison', driver_id=?, driver_name=? WHERE id=?").run(driver_id, driver_name, req.params.id);
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  io.to(`client:${order.id}`).emit("order:updated", order);
  notifyRole("client", order.id, {
    title: "NA'KUL HALAL",
    body: `🛵 ${driver_name} a pris en charge votre commande et arrive vers vous`,
    tag: `order-${order.id}`,
    url: "./takul-client.html",
  });
  notifyRole("restaurant", order.restaurant_id, {
    title: "NA'KUL HALAL",
    body: `🛵 ${driver_name} a été attribué à la commande #${order.id}`,
    tag: `order-${order.id}`,
    url: "./takul-restaurant.html",
  });
  res.json(order);
});

// ============ LIVREUR : signaler son arrivée (au restaurant ou chez le client) ============
app.post("/api/orders/:id/arrived", async (req, res) => {
  const { where } = req.body; // 'restaurant' | 'client'
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!order) return res.status(404).json({ error: "Introuvable" });
  if (where === "restaurant") {
    notifyRole("restaurant", order.restaurant_id, {
      title: "NA'KUL HALAL",
      body: `📍 ${order.driver_name} est arrivé pour récupérer la commande #${order.id}`,
      tag: `order-${order.id}`,
      url: "./takul-restaurant.html",
    });
  } else {
    notifyRole("client", order.id, {
      title: "NA'KUL HALAL",
      body: `📍 ${order.driver_name} est arrivé avec votre commande`,
      tag: `order-${order.id}`,
      url: "./takul-client.html",
    });
  }
  res.json({ ok: true });
});

app.get("/api/drivers/:name/deliveries", (req, res) => {
  res.json(db.prepare("SELECT * FROM orders WHERE driver_name = ? AND status = 'livree' ORDER BY id DESC").all(req.params.name));
});

// ============ LIVREUR : position GPS en direct ============
app.post("/api/orders/:id/location", (req, res) => {
  const { lat, lng } = req.body;
  db.prepare("UPDATE orders SET driver_lat=?, driver_lng=? WHERE id=?").run(lat, lng, req.params.id);
  io.to(`client:${req.params.id}`).emit("driver:location", { lat, lng });
  res.json({ ok: true });
});

io.on("connection", (socket) => {
  socket.on("join:client", (orderId) => socket.join(`client:${orderId}`));
  socket.on("join:restaurant", (restaurantId) => socket.join(`restaurant:${restaurantId}`));
  socket.on("join:pool", (city) => socket.join(`pool:${city}`));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`NA'KUL HALAL backend en ligne sur le port ${PORT}`));
