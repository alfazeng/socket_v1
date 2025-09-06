const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const { Pool } = require("pg");
const cors = require("cors");
// --- 1. Se importa firebase-admin y se elimina jsonwebtoken ---
const admin = require("firebase-admin");

// --- 2. Se inicializa el SDK de Firebase Admin ---
// Este código buscará las credenciales en las variables de entorno de Render
try {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
  console.log("✅ Firebase Admin SDK inicializado correctamente.");
} catch (error) {
  console.error("❌ Error al inicializar Firebase Admin SDK:", error);
  console.log(
    "Asegúrate de que la variable de entorno GOOGLE_APPLICATION_CREDENTIALS esté configurada en Render."
  );
}

// --- Configuración de la Base de Datos (sin cambios) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool
  .connect()
  .then(() => console.log("✅ Conectado a la base de datos PostgreSQL"))
  .catch((err) => console.error("❌ Error de conexión a la DB:", err.stack));

// --- Inicialización del Servidor (sin cambios) ---
const PORT = process.env.PORT || 10000;
const app = express();
app.use(cors());
app.use(express.json());

// =================================================================================
// --- 3. MIDDLEWARE DE AUTENTICACIÓN (ACTUALIZADO CON FIREBASE) ---
// =================================================================================
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  if (token == null) return res.sendStatus(401); // No hay token

  try {
    // Se verifica el token usando Firebase Admin
    const decodedToken = await admin.auth().verifyIdToken(token);

    // Se busca el ID interno del usuario en la base de datos usando el email del token
    const userResult = await pool.query(
      "SELECT id FROM usuarios WHERE correo = $1",
      [decodedToken.email]
    );

    if (userResult.rows.length === 0) {
      // Si el usuario existe en Firebase pero no en tu DB, se rechaza
      return res
        .status(404)
        .json({ error: "Usuario no encontrado en la base de datos." });
    }

    // Se añade el ID interno del usuario al objeto de la petición
    req.user = { id: userResult.rows[0].id };
    next();
  } catch (error) {
    console.error(
      "Error en la verificación del token de Firebase:",
      error.code
    );
    return res.sendStatus(403); // Token inválido o expirado
  }
};

// =================================================================================
// --- ENDPOINTS DE API REST ---
// =================================================================================

app.get("/", (req, res) => {
  res.send("WebSocket Subscription Server is running.");
});

// Este endpoint ahora funcionará correctamente
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

// --- INICIO DEL SERVIDOR HTTP Y WEBSOCKET (sin cambios) ---
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
