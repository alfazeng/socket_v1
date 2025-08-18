const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const { Pool } = require("pg");
const cors = require("cors");

// --- Configuración de la Base de Datos ---
// Se conecta a la base de datos para guardar las suscripciones de los usuarios
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

// Endpoint de salud para verificar que el servidor está vivo
app.get("/", (req, res) => {
  res.send("WebSocket Subscription Server is running.");
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

server.listen(PORT, () => {
  console.log(`🚀 Servidor WebSocket iniciado en el puerto: ${PORT}`);
});


// =================================================================================
// --- LÓGICA PRINCIPAL DEL SERVIDOR WEBSOCKET ---
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
      ws.send(JSON.stringify({ type: "error", msg: "Formato de mensaje inválido." }));
      return;
    }

    switch (msg.type) {
      // Caso 1: El cliente se identifica al conectarse
      case "identificacion":
        if (msg.userId) {
          ws.userId = msg.userId; // Asocia el ID a esta conexión específica
          console.log(`✅ Usuario ${ws.userId} (${msg.fullName}) identificado.`);
          ws.send(JSON.stringify({ type: "identificado", msg: "Conexión lista para recibir suscripción." }));
        }
        break;

      // Caso 2: El cliente envía su token de suscripción para notificaciones push
      case "registrar_push":
        if (msg.userId && msg.subscription && ws.userId === msg.userId) {
          console.log(`📲 Registrando suscripción push para el usuario ${ws.userId}`);
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
            ws.send(JSON.stringify({ type: "suscripcion_registrada", status: "ok" }));
          } catch (dbErr) {
            console.error(`❌ Error de DB al guardar suscripción para ${ws.userId}:`, dbErr);
            ws.send(JSON.stringify({ type: "error", msg: "No se pudo guardar la suscripción." }));
          } finally {
            client.release();
          }
        }
        break;
      
      // Default: Mensajes no reconocidos
      default:
        ws.send(JSON.stringify({ type: "error", msg: "Tipo de mensaje no reconocido." }));
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

// --- Ping para mantener conexiones vivas ---
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      if (ws.userId) console.log(`🔪 Terminando conexión inactiva del usuario ${ws.userId}`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);
