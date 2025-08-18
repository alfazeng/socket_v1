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
// --- LÓGICA DE ENVIAR NOTIFICACIONES DESDE EL PANEL ---
// =================================================================================


// Middleware para verificar si el usuario es admin
const verifyAdmin = (req, res, next) => {
  // Este middleware debe correr DESPUÉS de authenticateToken
  if (req.user && req.user.rol === 'admin') {
    next(); // El usuario es admin, continuar
  } else {
    res.sendStatus(403); // Prohibido
  }
};



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


// --- ENDPOINT PARA ENVIAR NOTIFICACIONES MASIVAS Y SEGMENTADAS ---
app.post('/api/notifications/send', authenticateToken, verifyAdmin, async (req, res) => {
  // Obtenemos los datos del panel de React
  const { title, body, url, image, segments } = req.body;

  if (!title || !body || !url) {
    return res.status(400).json({ message: 'Título, cuerpo y URL son requeridos.' });
  }

  try {
    // --- Lógica de Segmentación ---
    let queryParams = [];
    let query = `
      SELECT ps.endpoint, ps.p256dh, ps.auth
      FROM push_subscriptions ps
      JOIN usuarios u ON ps.user_id = u.id
      WHERE 1=1
    `;

    if (segments && segments.state) {
      queryParams.push(segments.state);
      query += ` AND u.estado = $${queryParams.length}`;
    }
    // Aquí podrías añadir más filtros: por fecha de registro, etc.

    const result = await pool.query(query, queryParams);
    const subscriptions = result.rows;

    if (subscriptions.length === 0) {
      return res.status(404).json({ message: 'No se encontraron usuarios con esos criterios.' });
    }

    console.log(`Enviando notificación a ${subscriptions.length} suscriptores...`);

    // --- Lógica de Envío ---
    const payload = JSON.stringify({
      title: title,
      body: body,
      icon: 'https://chatcerexapp.netlify.app/img/icon-192.png', // Ícono por defecto
      image: image, // URL de la imagen de la promoción
      data: {
        url: url, // Link al que irá el usuario al hacer clic
      },
    });

    // Enviamos todas las notificaciones en paralelo
    const sendPromises = subscriptions.map(s => {
      const subscriptionObject = {
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
      };
      return webpush.sendNotification(subscriptionObject, payload).catch(err => {
        // Si una suscripción es inválida (error 410), la eliminamos
        if (err.statusCode === 410) {
          console.log('Eliminando suscripción expirada:', s.endpoint);
          pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [s.endpoint]);
        } else {
          console.error('Error al enviar notificación individual:', err);
        }
      });
    });

    await Promise.all(sendPromises);

    res.status(200).json({ message: `Notificaciones enviadas a ${subscriptions.length} usuarios.` });

  } catch (error) {
    console.error('Error masivo al enviar notificaciones:', error);
    res.status(500).json({ message: 'Error interno del servidor.' });
  }
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
