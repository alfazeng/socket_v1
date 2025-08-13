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

// --- Conexión a la base de datos con Pool para múltiples conexiones ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
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

// --- Middleware de Autenticación (para endpoints de API) ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  if (token == null) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// --- ENDPOINTS DE API REST ---

// Endpoint raíz para verificar que el servidor está corriendo
app.get("/", (req, res) => {
  res.send("WebSocket and Express server is running.");
});

// Endpoint para crear o encontrar un chat existente
app.post("/api/chats", authenticateToken, async (req, res) => {
  const senderId = req.user.id;
  const { recipient_id } = req.body;

  if (!recipient_id) {
    return res.status(400).json({ error: "recipient_id es requerido." });
  }

  try {
    const existingChat = await pool.query(
      `SELECT c.id FROM chats c
        JOIN chat_members cm1 ON c.id = cm1.chat_id
        JOIN chat_members cm2 ON c.id = cm2.chat_id
        WHERE cm1.user_id = $1 AND cm2.user_id = $2`,
      [senderId, recipient_id]
    );

    if (existingChat.rows.length > 0) {
      return res.status(200).json({ chat_id: existingChat.rows[0].id });
    }

    const newChat = await pool.query(
      "INSERT INTO chats (created_at) VALUES (NOW()) RETURNING id"
    );
    const newChatId = newChat.rows[0].id;

    await pool.query(
      "INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2), ($1, $3)",
      [newChatId, senderId, recipient_id]
    );

    res.status(201).json({ chat_id: newChatId });
  } catch (error) {
    console.error("Error al crear o encontrar chat:", error);
    res.status(500).json({ error: "Error interno del servidor." });
  }
});

// NUEVO: Endpoint para obtener el historial de mensajes de un chat
app.get("/api/chats/:chatId/messages", authenticateToken, async (req, res) => {
  const { chatId } = req.params;
  const userId = req.user.id;

  try {
    // Verificamos si el usuario es miembro de este chat
    const isMember = await pool.query(
      "SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2",
      [chatId, userId]
    );

    if (isMember.rows.length === 0) {
      return res.status(403).json({ error: "Acceso denegado." });
    }

    const messages = await pool.query(
      `SELECT m.id, m.mensaje AS msg, m.de_id AS from, m.fecha
        FROM mensajes m
        WHERE m.chat_id = $1
        ORDER BY m.fecha ASC`,
      [chatId]
    );

    res.status(200).json(messages.rows);
  } catch (error) {
    console.error("Error al obtener mensajes del chat:", error);
    res.status(500).json({ error: "Error interno del servidor." });
  }
});

// --- SERVIDOR WEB SOCKETS ---

// Se crea un servidor HTTP para Express y WebSockets
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

      // --- REGISTRAR PUSH ---
      if (msg.type === "registrar_push" && msg.userId && msg.subscription) {
        const userId = msg.userId;
        const subscription = msg.subscription;
        const client = await pool.connect();
        try {
          // Primero, intenta actualizar el registro
          const updateResult = await client.query(
            "UPDATE push_subscriptions SET subscription = $1 WHERE user_id = $2 RETURNING *",
            [JSON.stringify(subscription), userId]
          );

          if (updateResult.rows.length === 0) {
            // Si no hay filas actualizadas, inserta un nuevo registro
            await client.query(
              "INSERT INTO push_subscriptions (user_id, subscription) VALUES ($1, $2)",
              [userId, JSON.stringify(subscription)]
            );
          }
          console.log("Suscripción a notificaciones push registrada para:", userId);
        } finally {
          client.release();
        }
      }

      // --- IDENTIFICAR USUARIO ---
      if (msg.type === "identificacion" && msg.userId) {
        ws.userId = msg.userId;
        conexiones.set(ws.userId, ws);
        console.log(`Usuario conectado: ${ws.userId}`);
        ws.send(
          JSON.stringify({
            type: "status",
            msg: "identificado",
            userId: ws.userId,
          })
        );
        return;
      }

      // --- ENVIAR MENSAJE ---
      if (
        msg.type === "mensaje" &&
        msg.from &&
        msg.to &&
        msg.msg &&
        msg.chat_id
      ) {
        // AÑADIDO: Verificamos que el emisor del mensaje sea el mismo que el usuario de la conexión
        if (msg.from !== ws.userId) {
          ws.send(
            JSON.stringify({
              type: "error",
              msg: "No puedes enviar un mensaje en nombre de otro usuario.",
            })
          );
          return;
        }

        try {
          const result = await pool.query(
            `INSERT INTO mensajes (chat_id, de_id, para_id, mensaje, fecha) VALUES ($1, $2, $3, $4, NOW()) RETURNING fecha`,
            [msg.chat_id, msg.from, msg.to, msg.msg]
          );

          const fechaMensaje = result.rows[0].fecha;

          // Mensaje para el RECEPTOR
          const receptor = conexiones.get(msg.to);
          if (receptor && receptor.readyState === WebSocket.OPEN) {
            receptor.send(
              JSON.stringify({
                type: "mensaje",
                from: msg.from,
                to: msg.to,
                chat_id: msg.chat_id,
                msg: msg.msg,
                fecha: fechaMensaje,
              })
            );
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
              webpush
                .sendNotification(JSON.parse(subscription), payload)
                .catch((err) =>
                  console.error("Error al enviar notificación push:", err)
                );
            }
          }
          
          // Mensaje de confirmación para el EMISOR
          ws.send(
            JSON.stringify({
              type: "enviado",
              from: msg.from,
              to: msg.to,
              chat_id: msg.chat_id,
              msg: msg.msg,
              fecha: fechaMensaje,
            })
          );
        } catch (dbErr) {
          console.error("Error al guardar mensaje en la DB:", dbErr);
          ws.send(JSON.stringify({ type: "error", msg: "Error de servidor." }));
        }
        return;
      }

      // --- TYPING EVENT ---
      if (msg.type === "typing" && msg.from && msg.to) {
        if (msg.from !== ws.userId) {
          return;
        }
        const receptor = conexiones.get(msg.to);
        if (receptor && receptor.readyState === WebSocket.OPEN) {
          receptor.send(
            JSON.stringify({
              type: "typing",
              from: msg.from,
              to: msg.to,
            })
          );
        }
        return;
      }

      ws.send(
        JSON.stringify({
          type: "error",
          msg: "Formato de mensaje inválido o tipo no reconocido.",
        })
      );
    } catch (err) {
      ws.send(
        JSON.stringify({ type: "error", msg: "Formato de mensaje inválido." })
      );
    }
  });

  ws.on("close", () => {
    if (ws.userId) {
      conexiones.delete(ws.userId);
      console.log(`Usuario desconectado: ${ws.userId}`);
    }
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);