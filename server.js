const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const { Pool } = require("pg");
const cors = require("cors");
const admin = require("firebase-admin");
const fs = require('fs');

// --- INICIO DEL NUEVO BLOQUE DE DIAGNÓSTICO ---
console.log("--- INICIANDO DIAGNÓSTICO PROFUNDO DEL ENTORNO DE RENDER ---");

const secretPath = '/etc/secrets';
const secretFile = 'credentials.json';
const fullPath = `${secretPath}/${secretFile}`;

console.log(`[DIAGNÓSTICO] Buscando el archivo: ${fullPath}`);

try {
  // 1. Verificamos si la carpeta de secretos existe.
  if (fs.existsSync(secretPath)) {
    console.log(`[DIAGNÓSTICO] La carpeta de secretos '${secretPath}' SÍ existe.`);
    
    // 2. Listamos el contenido de la carpeta.
    const files = fs.readdirSync(secretPath);
    console.log(`[DIAGNÓSTICO] Contenido de '${secretPath}': [${files.join(', ')}]`);

    // 3. Verificamos si nuestro archivo específico existe.
    if (fs.existsSync(fullPath)) {
      console.log(`[DIAGNÓSTICO] El archivo '${fullPath}' SÍ fue encontrado.`);
      // Opcional: Leer el project_id para una última confirmación.
      try {
        const creds_content = fs.readFileSync(fullPath, 'utf8');
        const creds_json = JSON.parse(creds_content);
        console.log(`[DIAGNÓSTICO] project_id en el archivo: ${creds_json.project_id}`);
      } catch (e) {
        console.error("[DIAGNÓSTICO] ERROR al leer el contenido del JSON.");
      }
    } else {
      console.error(`[DIAGNÓSTICO] ¡ERROR CRÍTICO! El archivo '${fullPath}' NO fue encontrado dentro de la carpeta de secretos.`);
    }

  } else {
    console.error(`[DIAGNÓSTICO] ¡ERROR CRÍTICO! La carpeta de secretos '${secretPath}' NO existe en este entorno.`);
  }
} catch (e) {
  console.error("[DIAGNÓSTICO] Ocurrió un error general durante el diagnóstico del sistema de archivos:", e);
}
console.log("--- FIN DEL DIAGNÓSTICO ---");
// --- FIN DEL NUEVO BLOQUE DE DIAGNÓSTICO ---

// --- CONFIGURACIÓN DE LA BASE DE DATOS ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool
  .connect()
  .then(() => console.log("✅ Conectado a la base de datos PostgreSQL"))
  .catch((err) => console.error("❌ Error de conexión a la DB:", err.stack));

// --- INICIALIZACIÓN DEL SERVIDOR ---
const PORT = process.env.PORT || 10000;
const app = express();
app.use(cors());
app.use(express.json());

// --- MIDDLEWARE DE AUTENTICACIÓN (ACTUALIZADO) ---
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];
  if (token == null) return res.sendStatus(401);
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    // Se modifica la consulta para obtener también el nombre del usuario
    const userResult = await pool.query(
      "SELECT id, nombre FROM usuarios WHERE correo = $1",
      [decodedToken.email]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }
    // Se adjunta el id y el nombre al objeto req.user
    req.user = {
      id: userResult.rows[0].id,
      nombre: userResult.rows[0].nombre,
    };
    next();
  } catch (error) {
    console.error("Error en la verificación del token:", error.code);
    return res.sendStatus(403);
  }
};

// =================================================================================
// --- ENDPOINTS DE API REST ---
// =================================================================================
// server.js

// Nuevo endpoint para guardar el token de FCM
app.post("/api/subscribe-fcm", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { fcmToken } = req.body;

  if (!fcmToken) {
    return res.status(400).json({ error: "No se proporcionó fcmToken." });
  }

  try {
    // Inserta o actualiza el token en tu nueva tabla (o la tabla modificada)
    // Lógica para evitar duplicados: un usuario puede tener tokens para varios dispositivos.
    const query = `
      INSERT INTO fcm_tokens (user_id, token) 
      VALUES ($1, $2) 
      ON CONFLICT (token) DO NOTHING;
    `;
    await pool.query(query, [userId, fcmToken]);
    res.status(200).json({ message: "Suscripción FCM guardada." });
  } catch (error) {
    console.error("Error al guardar token de FCM:", error);
    res.status(500).send("Error interno");
  }
});




app.get("/", (req, res) => {
  res.send("WebSocket Subscription Server is running.");
});

// --- ENDPOINTS DEL CERBOT (EXISTENTES) ---
// En tu server.js, reemplaza el endpoint /api/cerbot/message completo

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

    if (sellerCheck.rows.length === 0) {
      return res
        .status(404)
        .json({ botResponse: "El vendedor especificado no fue encontrado." });
    }

    const isCerbotActive = sellerCheck.rows[0]?.cerbot_activo;

    if (isCerbotActive) {
      const n8nReasoningWebhook =
        "https://n8n.chatcerexapp.com/webhook/api_chappie/asistente_cerbot";

      // --- INICIO DE LA SOLUCIÓN ---
      // 1. Creamos un AbortController para manejar el timeout.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        console.log(`[CERBOT_TIMEOUT] La solicitud a n8n ha superado los 15 segundos. Cancelando...`);
        controller.abort();
      }, 15000); // 15 segundos de tiempo de espera

      try {
        console.log(`[CERBOT_LOG] Realizando llamada a n8n con un timeout de 15s.`);
        const n8nResponse = await fetch(n8nReasoningWebhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sellerId: sellerId,
            user_question: message,
          }),
          // 2. Asociamos la señal del controller a nuestra petición.
          signal: controller.signal, 
        });

        // 3. Si la respuesta llega a tiempo, limpiamos el timeout.
        clearTimeout(timeoutId);

        if (!n8nResponse.ok) {
          throw new Error(
            `El servicio de IA respondió con el estado: ${n8nResponse.status}`
          );
        }

        const responseText = await n8nResponse.text();
        if (!responseText) {
          throw new Error("El servicio de IA devolvió una respuesta vacía.");
        }
        const responseData = JSON.parse(responseText);

        res.json({
          botResponse:
            responseData.respuesta ||
            "No pude procesar la respuesta en este momento.",
        });

      } catch (n8nError) {
        // 4. Limpiamos el timeout aquí también por si hay otros errores.
        clearTimeout(timeoutId);

        // Si el error es por el abort, es un timeout.
        if (n8nError.name === 'AbortError') {
          console.error("Error al contactar a n8n: La solicitud ha caducado (timeout).");
          res.status(504).json({ // 504 Gateway Timeout es el código correcto
            botResponse:
              "Lo siento, mi asistente de IA está tardando mucho en responder. Intenta de nuevo más tarde.",
          });
        } else {
          console.error("Error al contactar o procesar la respuesta de n8n:", n8nError);
          res.status(500).json({
            botResponse:
              "Lo siento, mi asistente de IA no está disponible en este momento.",
          });
        }
      }
      // --- FIN DE LA SOLUCIÓN ---
    } else {
      res.json({
        botResponse:
          "Este usuario no ha configurado su Cerbot a detalle...",
      });
    }
  } catch (error) {
    console.error("Error en el endpoint del Cerbot (consulta inicial):", error);
    res.status(500).json({ error: "Error interno del servidor." });
  }
});

app.get("/api/cerbot/knowledge", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const knowledge = await pool.query(
      "SELECT id, categoria, pregunta, respuesta FROM cerbot_conocimiento WHERE user_id = $1 ORDER BY categoria, id",
      [userId]
    );
    res.json(knowledge.rows);
  } catch (error) {
    res.status(500).json({ error: "Error interno del servidor." });
  }
});

app.post("/api/cerbot/knowledge", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { categoria, pregunta, respuesta } = req.body;

  if (!categoria || !pregunta || !respuesta) {
    return res.status(400).json({ error: "Todos los campos son requeridos." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const newKnowledgeQuery =
      "INSERT INTO cerbot_conocimiento (user_id, categoria, pregunta, respuesta) VALUES ($1, $2, $3, $4) RETURNING *";
    const newKnowledgeResult = await client.query(newKnowledgeQuery, [
      userId,
      categoria,
      pregunta,
      respuesta,
    ]);

    const updateUserQuery =
      "UPDATE usuarios SET cerbot_activo = true, cerbot_entrenamiento_completo = true WHERE id = $1";
    await client.query(updateUserQuery, [userId]);

    await client.query("COMMIT");

    const insertedKnowledge = newKnowledgeResult.rows[0];
    const responsePayload = {
      id: insertedKnowledge.id,
      user_id: insertedKnowledge.user_id,
      categoria: insertedKnowledge.categoria,
      pregunta: insertedKnowledge.pregunta,
      respuesta: insertedKnowledge.respuesta,
    };

    res.status(201).json(responsePayload);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error al guardar conocimiento y activar el Cerbot:", error);
    res.status(500).json({ error: "Error interno del servidor." });
  } finally {
    client.release();
  }
});

app.delete(
  "/api/cerbot/knowledge/:id",
  authenticateToken,
  async (req, res) => {
    const userId = req.user.id;
    const { id } = req.params;
    try {
      const deleteResult = await pool.query(
        "DELETE FROM cerbot_conocimiento WHERE id = $1 AND user_id = $2",
        [id, userId]
      );
      if (deleteResult.rowCount === 0) {
        return res.status(404).json({ error: "Registro no encontrado." });
      }
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Error interno del servidor." });
    }
  }
);

// --- ENDPOINTS PARA EL FLUJO DE CRM (NUEVOS) ---

// Endpoint 1: Obtener la lista de usuarios interesados en una publicación
app.get(
  "/api/publicaciones/:id/interesados",
  authenticateToken,
  async (req, res) => {
    const ownerId = req.user.id;
    const { id: publicationId } = req.params;

    try {
      // 1. Verificar que el solicitante es el dueño de la publicación
      const publicationCheck = await pool.query(
        "SELECT usuario_id FROM publicaciones WHERE id = $1",
        [publicationId]
      );

      if (publicationCheck.rows.length === 0) {
        return res.status(404).json({ error: "Publicación no encontrada." });
      }

      if (publicationCheck.rows[0].usuario_id !== ownerId) {
        return res
          .status(403)
          .json({ error: "No tienes permiso para ver esta lista." });
      }

      // 2. Obtener los usuarios que preguntaron
      const interestedUsers = await pool.query(
        `SELECT u.id, u.nombre, u.url_imagen_perfil
       FROM usuarios u
       JOIN registro_preguntas rp ON u.id = rp.preguntador_id
       WHERE rp.publicacion_id = $1`,
        [publicationId]
      );

      res.json(interestedUsers.rows);
    } catch (error) {
      console.error("Error al obtener la lista de interesados:", error);
      res.status(500).json({ error: "Error interno del servidor." });
    }
  }
);

// Endpoint 2: Enviar mensaje promocional a los interesados
// --- Endpoint de envío de promociones MODIFICADO ---


app.post("/api/promociones/enviar", authenticateToken, async (req, res) => {
  const sender = req.user; // { id, nombre }
  const { message, publicationId, recipientIds } = req.body;

  if (!message || !publicationId || !Array.isArray(recipientIds) || recipientIds.length === 0) {
    return res.status(400).json({ error: "Faltan datos para enviar la promoción." });
  }

  try {
    // 1. Verificar permisos (sin cambios)
    const publicationCheck = await pool.query(
      "SELECT usuario_id FROM publicaciones WHERE id = $1",
      [publicationId]
    );
    if (publicationCheck.rows.length === 0 || publicationCheck.rows[0].usuario_id !== sender.id) {
      return res.status(403).json({ error: "No tienes permiso para esta acción." });
    }

    // 2. Enviar a usuarios online vía WebSocket (sin cambios)
    const onlineUserIds = [];
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && recipientIds.includes(client.userId)) {
        client.send(JSON.stringify({
          type: "promotional_message",
          payload: { from: sender.nombre, message, publicationId, timestamp: new Date().toISOString() },
        }));
        onlineUserIds.push(client.userId);
      }
    });

    // --- INICIO DE LA OPTIMIZACIÓN CON FCM ---
    const offlineUserIds = recipientIds.filter(id => !onlineUserIds.includes(id));
    
    if (offlineUserIds.length > 0) {
      console.log(`[FCM] Intentando enviar notificaciones a ${offlineUserIds.length} usuarios offline.`);
      
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // A. Guardar en la tabla 'notificaciones' para el historial (sin cambios)
        const notificationTitle = `📢 Nueva promoción de ${sender.nombre}`;
        const notificationUrl = `/publicacion/${publicationId}`;
        const insertQuery = `INSERT INTO notificaciones (user_id, titulo, cuerpo, url) VALUES ($1, $2, $3, $4)`;
        for (const userId of offlineUserIds) {
          await client.query(insertQuery, [userId, notificationTitle, message, notificationUrl]);
        }

        // B. Obtener los tokens de FCM de los usuarios offline
        const tokensResult = await client.query(
          `SELECT token FROM fcm_tokens WHERE user_id = ANY($1::int[])`,
          [offlineUserIds]
        );
        const tokens = tokensResult.rows.map(row => row.token);

        // C. Enviar la notificación PUSH usando Firebase Admin SDK
        if (tokens.length > 0) {
          const messagePayload = {
            notification: {
              title: notificationTitle,
              body: message,
            },
            webpush: {
              notification: { icon: "/img/icon-192.png" },
              fcm_options: { link: `https://chatcerex.com/publicacion/${publicationId}` },
            },
            tokens: tokens,
          };

          admin.messaging().sendMulticast(messagePayload)
            .then((response) => {
              console.log(`[FCM] Notificaciones enviadas: ${response.successCount} con éxito.`);
              // Opcional: puedes añadir lógica para limpiar tokens inválidos si fallan
            })
            .catch(err => console.error("[FCM] Error al enviar notificaciones:", err));
        }

        await client.query("COMMIT");
      } catch (dbError) {
        await client.query("ROLLBACK");
        throw dbError;
      } finally {
        client.release();
      }
    }
    // --- FIN DE LA OPTIMIZACIÓN CON FCM ---

    res.status(200).json({
      message: "Promoción enviada con éxito.",
      totalRecipients: recipientIds.length,
      onlineDeliveries: onlineUserIds.length,
    });
  } catch (error) {
    console.error("Error al enviar la promoción:", error);
    res.status(500).json({ error: "Error interno del servidor." });
  }
});

// =================================================================================
// --- INICIO DEL SERVIDOR HTTP Y WEBSOCKET ---
// =================================================================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

server.listen(PORT, () => {
  console.log(`🚀 Servidor WebSocket iniciado en el puerto: ${PORT}`);
});

// =================================================================================
// --- LÓGICA WEBSOCKET PARA NOTIFICACIONES ---
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

// --- Ping para mantener conexiones vivas ---
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
