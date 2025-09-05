const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const { Pool } = require("pg");
const cors = require("cors");
const jwt = require("jsonwebtoken"); // <-- AÑADIDO: Para autenticar el nuevo endpoint

// --- CLAVE SECRETA PARA JWT ---
const JWT_SECRET = process.env.JWT_SECRET || "tu_secreto_muy_seguro_y_largo";

// --- Configuración de la Base de Datos ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool
  .connect()
  .then(() => console.log("✅ Conectado a la base de datos PostgreSQL"))
  .catch((err) => console.error("❌ Error de conexión a la DB:", err.stack));

// --- Inicialización del Servidor ---
const PORT = process.env.PORT || 10000;
const app = express();
app.use(cors());
app.use(express.json()); // <-- AÑADIDO: Middleware para que Express entienda JSON en las peticiones POST

// =================================================================================
// --- MIDDLEWARE DE AUTENTICACIÓN (NUEVO) ---
// =================================================================================
// Este middleware protegerá nuestro nuevo endpoint y nos dará acceso a req.user
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  if (token == null) return res.sendStatus(401); // No hay token

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403); // Token inválido
    req.user = user;
    next();
  });
};

// =================================================================================
// --- ENDPOINTS DE API REST ---
// =================================================================================

// Endpoint de salud para verificar que el servidor está vivo
app.get("/", (req, res) => {
  res.send("WebSocket Subscription Server is running.");
});

// --- NUEVO ENDPOINT PARA LA LÓGICA DEL CERBOT ---
// Es llamado por el ChatModal del frontend
app.post("/api/cerbot/message", authenticateToken, async (req, res) => {
  const { sellerId, message } = req.body;

  if (!sellerId || !message) {
    return res.status(400).json({ error: "Faltan sellerId o message." });
  }

  try {
    const sellerCheck = await pool.query(
      "SELECT cerbot_activo FROM usuarios WHERE id = $1",
      [sellerId]
    );

    const isCerbotActive = sellerCheck.rows[0]?.cerbot_activo;

    if (isCerbotActive) {
      const knowledge = await pool.query(
        "SELECT respuesta FROM cerbot_conocimiento WHERE user_id = $1 AND pregunta ILIKE $2",
        [sellerId, `%${message}%`]
      );

      if (knowledge.rows.length > 0) {
        res.json({ botResponse: knowledge.rows[0].respuesta });
      } else {
        res.json({
          botResponse:
            "No he encontrado una respuesta exacta para tu pregunta. Intenta reformularla o contacta directamente al vendedor a través de WhatsApp.",
        });
      }
    } else {
      res.json({
        botResponse:
          "Este usuario no ha configurado su Cerbot a detalle, sin embargo estoy aquí para brindarte apoyo sobre esta publicación. Lo más seguro es que lo que estás buscando se resuelva escribiéndole directamente por WhatsApp. 📲 Toca el botón verde que aparece abajo para chatear directamente con el vendedor.",
      });
    }
  } catch (error) {
    console.error("Error en el endpoint del Cerbot:", error);
    res.status(500).json({ error: "Error interno del servidor." });
  }
});

// --- INICIO DEL SERVIDOR HTTP Y WEBSOCKET ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

server.listen(PORT, () => {
  console.log(`🚀 Servidor WebSocket iniciado en el puerto: ${PORT}`);
});

// =================================================================================
// --- LÓGICA WEBSOCKET PARA NOTIFICACIONES PUSH (SIN ALTERACIONES) ---
// =================================================================================
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  console.log("🔌 Nuevo cliente conectado.");

  ws.on("message", async (msgRaw) => {
    let msg;
    try {
      msg = JSON.parse(msgRaw);
      console.log(`⬅️ WS Msg Received:`, msg);
    } catch (err) {
      console.error(`❌ Error al parsear mensaje WS (no es JSON): ${msgRaw}`);
      ws.send(
        JSON.stringify({ type: "error", msg: "Formato de mensaje inválido." })
      );
      return;
    }

    switch (msg.type) {
      case "identificacion":
        if (msg.userId) {
          ws.userId = msg.userId;
          console.log(
            `✅ Usuario ${ws.userId} (${msg.fullName}) identificado.`
          );
          ws.send(
            JSON.stringify({
              type: "identificado",
              msg: "Conexión lista para recibir suscripción.",
            })
          );
        }
        break;

      case "registrar_push":
        if (msg.userId && msg.subscription && ws.userId === msg.userId) {
          console.log(
            `📲 Registrando suscripción push para el usuario ${ws.userId}`
          );
          const client = await pool.connect();
          try {
            const { endpoint, keys } = msg.subscription;
            const { p256dh, auth } = keys;

            const updateResult = await client.query(
              "UPDATE push_subscriptions SET endpoint = $1, p256dh = $2, auth = $3 WHERE user_id = $4 RETURNING user_id",
              [endpoint, p256dh, auth, ws.userId]
            );

            if (updateResult.rows.length === 0) {
              await client.query(
                "INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)",
                [ws.userId, endpoint, p256dh, auth]
              );
            }
            console.log(`👍 Suscripción para usuario ${ws.userId} guardada.`);
            ws.send(
              JSON.stringify({ type: "suscripcion_registrada", status: "ok" })
            );
          } catch (dbErr) {
            console.error(
              `❌ Error de DB al guardar suscripción para ${ws.userId}:`,
              dbErr
            );
            ws.send(
              JSON.stringify({
                type: "error",
                msg: "No se pudo guardar la suscripción.",
              })
            );
          } finally {
            client.release();
          }
        }
        break;

      default:
        ws.send(
          JSON.stringify({
            type: "error",
            msg: "Tipo de mensaje no reconocido.",
          })
        );
        break;
    }
  });

  ws.on("close", () => {
    if (ws.userId) {
      console.log(`🔌 Usuario ${ws.userId} desconectado.`);
    } else {
      console.log("🔌 Una conexión anónima se ha cerrado.");
    }
  });

  ws.on("error", (err) => {
    console.error("❌ WebSocket error:", err);
  });
});

// --- Ping para mantener conexiones vivas (SIN ALTERACIONES) ---
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      if (ws.userId)
        console.log(`🔪 Terminando conexión inactiva del usuario ${ws.userId}`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);
