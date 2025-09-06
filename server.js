const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const { Pool } = require("pg");
const cors = require("cors");
const admin = require("firebase-admin");

// --- INICIALIZACIÓN DE FIREBASE ADMIN (Correcta, sin cambios) ---
try {
  admin.initializeApp({
    credential: admin.credential.cert("/etc/secrets/credentials.json"),
  });
  console.log(
    "✅ Firebase Admin SDK inicializado correctamente desde el Secret File."
  );
} catch (error) {
  console.error("❌ Error al inicializar Firebase Admin SDK:", error);
}

// --- CONFIGURACIÓN DE LA BASE DE DATOS (Sin cambios) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool
  .connect()
  .then(() => console.log("✅ Conectado a la base de datos PostgreSQL"))
  .catch((err) => console.error("❌ Error de conexión a la DB:", err.stack));

// --- INICIALIZACIÓN DEL SERVIDOR (Sin cambios) ---
const PORT = process.env.PORT || 10000;
const app = express();
app.use(cors());
app.use(express.json());

// --- MIDDLEWARE DE AUTENTICACIÓN (Correcto, sin cambios) ---
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];
  if (token == null) return res.sendStatus(401);
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    const userResult = await pool.query(
      "SELECT id FROM usuarios WHERE correo = $1",
      [decodedToken.email]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }
    req.user = { id: userResult.rows[0].id };
    next();
  } catch (error) {
    console.error("Error en la verificación del token:", error.code);
    return res.sendStatus(403);
  }
};

// =================================================================================
// --- ENDPOINTS DE API REST (ACTUALIZADOS) ---
// =================================================================================

app.get("/", (req, res) => {
  res.send("WebSocket Subscription Server is running.");
});

// --- ENDPOINT DE RAZONAMIENTO (MODIFICADO) ---
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
      // --- LÓGICA NUEVA: LLAMADA AL WEBHOOK DE N8N PARA RAZONAR ---
      // Reemplaza esta URL con tu webhook de n8n para el razonamiento
      const n8nReasoningWebhook =
        "https://n8n.chatcerexapp.com/webhook/api_chappie/asistente_cerbot";

      const n8nResponse = await fetch(n8nReasoningWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerId: sellerId,
          user_question: message,
        }),
      });

      if (!n8nResponse.ok) {
        throw new Error("Error en la comunicación con el servicio de IA.");
      }

      const responseData = await n8nResponse.json();
      res.json({
        botResponse:
          responseData.respuesta ||
          "No pude procesar la respuesta en este momento.",
      });
    } else {
      // Lógica para la respuesta fija (sin cambios)
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

// --- NUEVOS ENDPOINTS PARA EL ENTRENAMIENTO GUIADO ---

// 1. OBTENER el conocimiento existente de un usuario
app.get("/api/cerbot/knowledge", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const knowledge = await pool.query(
      "SELECT id, categoria, pregunta, respuesta FROM cerbot_conocimiento WHERE user_id = $1 ORDER BY categoria, id",
      [userId]
    );
    res.json(knowledge.rows);
  } catch (error) {
    console.error("Error al obtener conocimiento:", error);
    res.status(500).json({ error: "Error interno del servidor." });
  }
});

// 2. AÑADIR un nuevo conocimiento (con categoría)
app.post("/api/cerbot/knowledge", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { categoria, pregunta, respuesta } = req.body;

  if (!categoria || !pregunta || !respuesta) {
    return res.status(400).json({ error: "Todos los campos son requeridos." });
  }

  try {
    const newKnowledge = await pool.query(
      "INSERT INTO cerbot_conocimiento (user_id, categoria, pregunta, respuesta) VALUES ($1, $2, $3, $4) RETURNING *",
      [userId, categoria, pregunta, respuesta]
    );
    res.status(201).json(newKnowledge.rows[0]);
  } catch (error) {
    console.error("Error al añadir conocimiento:", error);
    res.status(500).json({ error: "Error interno del servidor." });
  }
});

// 3. ELIMINAR un conocimiento
app.delete("/api/cerbot/knowledge/:id", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;
  try {
    const deleteResult = await pool.query(
      "DELETE FROM cerbot_conocimiento WHERE id = $1 AND user_id = $2",
      [id, userId]
    );
    if (deleteResult.rowCount === 0) {
      return res
        .status(404)
        .json({ error: "Registro no encontrado o no autorizado." });
    }
    res.status(204).send();
  } catch (error) {
    console.error("Error al eliminar conocimiento:", error);
    res.status(500).json({ error: "Error interno del servidor." });
  }
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
    } catch (err) {
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
            JSON.stringify({ type: "identificado", msg: "Conexión lista." })
          );
        }
        break;

      case "registrar_push":
        if (msg.userId && msg.subscription && ws.userId === msg.userId) {
          console.log(`📲 Registrando suscripción push para ${ws.userId}`);
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
            console.log(`👍 Suscripción para ${ws.userId} guardada.`);
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
      console.log("🔌 Conexión anónima cerrada.");
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
