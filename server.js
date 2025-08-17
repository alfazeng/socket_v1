const express = require("express");
const WebSocket = require("ws");
const webpush = require("web-push");
const http = require("http");
const { Pool } = require("pg");
const cors = require("cors");

// --- CLAVES VAPID ---
// Estas claves son necesarias para enviar notificaciones push
const VAPID_PUBLIC_KEY =
  "BKk3imcvxH5Wdz2k7O8-E3-mAM73dDLbIueqvVYuSVLNsUCEAfvtNhdG_2DFYXHihC2LvCfzSdEH3oudEjF3vjY";
const VAPID_PRIVATE_KEY = "Co3e5xGt6GM5zRREBPcgoSH1DhW6pF8ej95Ysv7d6YI";

webpush.setVapidDetails(
  "mailto:tuemail@ejemplo.com", // Cambia esto a tu email de contacto
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// --- Conexión a la base de datos ---
// Se mantiene para guardar las suscripciones en la tabla `push_subscriptions`
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

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Endpoint raíz ---
app.get("/", (req, res) => {
  res.send("Notification Subscription Server is running.");
});

// --- Servidor WebSockets ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

server.listen(PORT, () => {
  console.log("Servidor iniciado en puerto:", PORT);
});

// =================================================================================
// --- LÓGICA DE WEBSOCKETS PARA SUSCRIPCIONES ---
// =================================================================================
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", async (msgRaw) => {
    try {
      const msg = JSON.parse(msgRaw);
      console.log(`⬅️ WS Msg Received:`, msg);

      // --- Manejador para la identificación del usuario ---
      // Sigue siendo necesario para saber a qué usuario pertenece la suscripción
      if (msg.type === "identificacion" && msg.userId) {
        ws.userId = msg.userId; // Asocia el ID a esta conexión
        console.log(`✅ Usuario ${msg.userId} (${msg.fullName}) conectado y esperando suscripción.`);
        ws.send(JSON.stringify({ type: "identificado", msg: "Listo para recibir suscripción." }));
        return;
      }

      // --- Manejador para Registrar Push ---
   // ENCUENTRA Y REEMPLAZA ESTE BLOQUE EN TU server.js

if (msg.type === "registrar_push" && msg.userId && msg.subscription) {
    if (ws.userId !== msg.userId) {
        console.warn(`Intento de registrar suscripción para un usuario diferente (${msg.userId}) en una conexión de ${ws.userId}.`);
        return;
    }

    console.log(`📲 Registrando suscripción push para el usuario ${msg.userId}`);
    const client = await pool.connect();
    try {
        const { endpoint, keys } = msg.subscription;
        const { p256dh, auth } = keys;

        // CONSULTA UPDATE CORREGIDA con "user_id"
        const updateResult = await client.query(
            "UPDATE push_subscriptions SET endpoint = $1, p256dh = $2, auth = $3 WHERE user_id = $4 RETURNING *",
            [endpoint, p256dh, auth, msg.userId]
        );

        if (updateResult.rows.length === 0) {
            // CONSULTA INSERT CORREGIDA con "user_id"
            await client.query(
                "INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)",
                [msg.userId, endpoint, p256dh, auth]
            );
        }
        console.log(`👍 Suscripción para usuario ${msg.userId} guardada correctamente.`);
        ws.send(JSON.stringify({ type: "suscripcion_registrada", status: "ok" }));

    } catch (dbErr) {
        console.error(`❌ Error de base de datos al guardar suscripción para ${msg.userId}:`, dbErr);
        ws.send(JSON.stringify({ type: "error", msg: "No se pudo guardar la suscripción." }));
    } finally {
        client.release();
    }
    return;
}

      // --- Mensaje de fallback si no se reconoce el tipo ---
      ws.send(JSON.stringify({ type: "error", msg: "Tipo de mensaje no reconocido." }));

    } catch (err) {
      console.error(`❌ Error procesando mensaje WS. Causa: ${err.message}. Mensaje crudo: ${msgRaw}`);
      ws.send(JSON.stringify({ type: "error", msg: "Formato de mensaje inválido o error interno." }));
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
    console.error("WebSocket error:", err);
  });
});

// --- Ping para mantener conexiones vivas ---
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      if (ws.userId) console.log(`Terminando conexión inactiva del usuario ${ws.userId}`);
      else console.log("Terminando conexión inactiva anónima");
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);
