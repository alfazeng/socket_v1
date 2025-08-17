const express = require("express");
const WebSocket = require("ws");
const webpush = require("web-push");
const http = require("http");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const cors = require("cors");

// --- CLAVES VAPID y JWT ---
const VAPID_PUBLIC_KEY =
  "BKk3imcvxH5Wdz2k7O8-E3-mAM73dDLbIueqvVYuSVLNsUCEAfvtNhdG_2DFYXHihC2LvCfzSdEH3oudEjF3vjY";
const VAPID_PRIVATE_KEY = "Co3e5xGt6GM5zRREBPcgoSH1DhW6pF8ej95Ysv7d6YI";
const JWT_SECRET = process.env.JWT_SECRET || "tu_secreto_muy_seguro_y_largo";

webpush.setVapidDetails(
  "mailto:chatcerexapp@chatcerexapp.com",
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// --- Conexión a la base de datos ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool
  .connect()
  .then(() => console.log("Conectado a la base de datos PostgreSQL"))
  .catch((err) => console.error("Error de conexión a la DB:", err.stack));

const PORT = process.env.PORT || 10000;
const app = express();
const conexiones = new Map();

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Middleware de autenticación JWT ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// --- Endpoint raíz ---
app.get("/", (req, res) => {
  res.send("WebSocket and Express server is running.");
});

// --- Obtener historial de mensajes ---
app.get(
  "/api/chats/:otherUserId/messages",
  authenticateToken,
  async (req, res) => {
    const { otherUserId } = req.params;
    const currentUserId = req.user.id;

    try {
      const messages = await pool.query(
        `SELECT m.id, m.content AS msg, m.from_user_id AS "from", m.timestamp AS fecha
         FROM messages m
         WHERE (m.from_user_id = $1 AND m.to_user_id = $2)
            OR (m.from_user_id = $2 AND m.to_user_id = $1)
         ORDER BY m.timestamp ASC`,
        [currentUserId, otherUserId]
      );

      res.status(200).json(messages.rows);
    } catch (error) {
      console.error("Error al obtener mensajes del chat:", error);
      res.status(500).json({ error: "Error interno del servidor." });
    }
  }
);

// --- NUEVO: Crear conversación entre comprador y vendedor ---
app.post("/api/create_conversation", async (req, res) => {
  const { buyer_id, seller_id } = req.body;

  if (!buyer_id || !seller_id) {
    return res.status(400).json({ error: "buyer_id y seller_id son requeridos." });
  }

  try {
    const client = await pool.connect();

    const existing = await client.query(
      `SELECT id FROM conversations
       WHERE (user1_id = $1 AND user2_id = $2)
          OR (user1_id = $2 AND user2_id = $1)
       LIMIT 1`,
      [buyer_id, seller_id]
    );

    let conversation_id;

    if (existing.rows.length > 0) {
      conversation_id = existing.rows[0].id;
    } else {
      const insertConv = await client.query(
        `INSERT INTO conversations (user1_id, user2_id, created_at)
         VALUES ($1, $2, NOW())
         RETURNING id`,
        [buyer_id, seller_id]
      );
      conversation_id = insertConv.rows[0].id;
    }

    const sellerData = await client.query(
      `SELECT id, nombre AS name
       FROM usuarios
       WHERE id = $1`,
      [seller_id]
    );

    client.release();

    res.status(200).json({
      conversation_id,
      seller: sellerData.rows[0] || { id: seller_id, name: "Vendedor" }
    });

  } catch (error) {
    console.error("Error en create_conversation:", error);
    res.status(500).json({ error: "Error interno del servidor." });
  }
});

// --- Servidor WebSockets ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

server.listen(PORT, () => {
  console.log("Servidor iniciado en puerto:", PORT);
});

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", async (msgRaw) => {
    try {
      const msg = JSON.parse(msgRaw);

      // --- Registrar Push ---
   // --- Registrar Push ---
if (msg.type === "registrar_push" && msg.userId && msg.subscription) {
  const client = await pool.connect();
  try {
    // Analizamos el objeto de suscripción para obtener los campos
    const subscription = msg.subscription;
    const endpoint = subscription.endpoint;
    const p256dh = subscription.keys.p256dh;
    const auth = subscription.keys.auth;

    const updateResult = await client.query(
      "UPDATE push_subscriptions SET endpoint = $1, p256dh = $2, auth = $3 WHERE user_id = $4 RETURNING *",
      [endpoint, p256dh, auth, msg.userId]
    );

    if (updateResult.rows.length === 0) {
      await client.query(
        "INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)",
        [msg.userId, endpoint, p256dh, auth]
      );
    }
  } finally {
    client.release();
  }
  return;
}

      // --- Enviar mensaje ---
      if (msg.type === "mensaje" && msg.from && msg.to && msg.msg) {
        if (msg.from !== ws.userId) {
          ws.send(JSON.stringify({ type: "error", msg: "No puedes enviar en nombre de otro usuario." }));
          return;
        }

        try {
          const result = await pool.query(
            `INSERT INTO messages (from_user_id, to_user_id, content, timestamp)
             VALUES ($1, $2, $3, NOW())
             RETURNING timestamp`,
            [msg.from, msg.to, msg.msg]
          );

          const fechaMensaje = result.rows[0].timestamp;

          const receptor = conexiones.get(msg.to);
          if (receptor && receptor.readyState === WebSocket.OPEN) {
            receptor.send(JSON.stringify({
              type: "mensaje",
              from: msg.from,
              to: msg.to,
              msg: msg.msg,
              fecha: fechaMensaje
            }));
          } else {
            const subscriptionResult = await pool.query(
              "SELECT subscription FROM push_subscriptions WHERE user_id = $1",
              [msg.to]
            );
            const subscription = subscriptionResult.rows[0]?.subscription;
            if (subscription) {
              const payload = JSON.stringify({
                title: "Nuevo mensaje",
                body: `De: ${msg.from} - ${msg.msg}`,
              });
              webpush.sendNotification(JSON.parse(subscription), payload)
                .catch(err => console.error("Error al enviar notificación push:", err));
            }
          }

          ws.send(JSON.stringify({
            type: "enviado",
            from: msg.from,
            to: msg.to,
            msg: msg.msg,
            fecha: fechaMensaje
          }));

        } catch (dbErr) {
          console.error("Error al guardar mensaje:", dbErr);
          ws.send(JSON.stringify({ type: "error", msg: "Error de servidor." }));
        }
        return;
      }

      // --- Evento typing ---
      if (msg.type === "typing" && msg.from && msg.to) {
        if (msg.from !== ws.userId) return;
        const receptor = conexiones.get(msg.to);
        if (receptor && receptor.readyState === WebSocket.OPEN) {
          receptor.send(JSON.stringify({ type: "typing", from: msg.from, to: msg.to }));
        }
        return;
      }

      ws.send(JSON.stringify({ type: "error", msg: "Formato o tipo inválido." }));
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", msg: "Formato de mensaje inválido." }));
    }
  });

  ws.on("close", () => {
    if (ws.userId) {
      conexiones.delete(ws.userId);
    }
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
  });
});

// --- Ping para mantener conexión ---
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);
