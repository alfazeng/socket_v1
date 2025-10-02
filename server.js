const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const { Pool } = require("pg");
const cors = require("cors");
const admin = require("firebase-admin");
const fs = require('fs');

// En server.js

// En server.js
// En server.js

try {
  // 1. Leemos la variable codificada en Base64
  const credentialsBase64 = process.env.GOOGLE_CREDENTIALS_BASE64;
  if (!credentialsBase64) {
    throw new Error("La variable de entorno GOOGLE_CREDENTIALS_BASE64 no está configurada.");
  }

  // 2. La decodificamos de vuelta al JSON original
  const credentialsJSON = Buffer.from(credentialsBase64, 'base64').toString('utf8');
  const serviceAccount = JSON.parse(credentialsJSON);

  // --- INICIO DE LA SOLUCIÓN ---
  // 3. Validamos que el serviceAccount contenga el projectId correcto
  if (serviceAccount.project_id !== 'chappie4-d50ad') {
    console.warn(`[ADVERTENCIA] El projectId en las credenciales ('${serviceAccount.project_id}') no coincide con el del frontend ('chappie4-d50ad'). Esto puede causar errores de autenticación.`);
  }

  // 4. Inicializamos Firebase con el serviceAccount. No es necesario especificar el projectId aquí,
  //    ya que el SDK lo tomará directamente del archivo de credenciales.
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  // --- FIN DE LA SOLUCIÓN ---

  console.log(`✅ Firebase Admin SDK inicializado correctamente para el proyecto: ${serviceAccount.project_id}`);

} catch (error) {
  console.error("🔥 ¡ERROR CRÍTICO AL INICIALIZAR FIREBASE ADMIN!:", error.message);
  process.exit(1);
}

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

// --- MIDDLEWARE DE AUTENTICACIÓN MEJORADO ---
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];
  if (token == null) return res.sendStatus(401);
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    const userResult = await pool.query(
      "SELECT id, nombre FROM usuarios WHERE correo = $1",
      [decodedToken.email]
    );
    
    // --- SOLUCIÓN: Auto-creación de usuario si no existe ---
    if (userResult.rows.length === 0) {
      const newUserQuery = `
        INSERT INTO usuarios (nombre, correo, fecha_registro, rol, can_ask)
        VALUES ($1, $2, NOW(), 'usuario', FALSE)
        RETURNING id, nombre`;
      const newUserResult = await pool.query(newUserQuery, [decodedToken.name || decodedToken.email, decodedToken.email]);
      req.user = {
        id: newUserResult.rows[0].id,
        nombre: newUserResult.rows[0].nombre,
      };
      console.log(`✅ Nuevo usuario '${decodedToken.email}' creado con rol 'usuario'.`);
    } else {
      req.user = {
        id: userResult.rows[0].id,
        nombre: userResult.rows[0].nombre,
      };
    }
    next();
  } catch (error) {
    console.error("Error en la verificación del token:", error.code);
    return res.sendStatus(403);
  }
};

// =================================================================================
// --- ENDPOINTS DE API REST ---
// =================================================================================

app.get("/", (req, res) => {
  res.send("Servidor de WebSocket y Notificaciones está funcionando.");
});


app.post("/api/subscribe-fcm", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { fcmToken } = req.body;

  if (!fcmToken || typeof fcmToken !== 'string' || fcmToken.trim() === '') {
    // Esta validación previene que tokens vacíos lleguen a la DB.
    return res.status(200).json({ message: "Operación ignorada: fcmToken inválido." });
  }

  try {
    // Consulta UPSERT limpia, sin comentarios.
    const upsertQuery = `
      INSERT INTO fcm_tokens (user_id, token) 
      VALUES ($1, $2)
      ON CONFLICT (token) 
      DO UPDATE SET user_id = EXCLUDED.user_id;
    `;
    
    await pool.query(upsertQuery, [userId, fcmToken]);

    // La lógica de suscripción a temas se mantiene.
    const userResult = await pool.query('SELECT estado FROM usuarios WHERE id = $1', [userId]);
    const userState = userResult.rows[0]?.estado;
    
    await admin.messaging().subscribeToTopic(fcmToken, 'all_users');
    if (userState) {
      const topicName = `state_${userState.replace(/[^a-zA-Z0-9-_.~%]/g, '_')}`;
      await admin.messaging().subscribeToTopic(fcmToken, topicName);
    }

    res.status(200).json({ message: "Suscripción FCM procesada correctamente." });

  } catch (error) {
    console.error("Error en el proceso de suscripción a FCM:", error);
    res.status(500).send("Error interno del servidor");
  }
});

// --- ENDPOINTS DEL CERBOT (EXISTENTES) ---
// **NUEVO ENDPOINT** para enviar notificaciones desde el panel de administrador
// En tu server.js (Render)
// VERSIÓN FINAL Y ROBUSTA PARA /api/notifications/send

// --- ENDPOINT DE ENVÍO DE NOTIFICACIONES (CORREGIDO) ---
app.post("/api/notifications/send", authenticateToken, async (req, res) => {
  try {
    const userCheck = await pool.query("SELECT rol FROM usuarios WHERE id = $1", [req.user.id]);
    if (userCheck.rows.length === 0 || userCheck.rows[0].rol !== "admin") {
      return res.status(403).json({ error: "Acceso denegado. Se requiere rol de administrador." });
    }
  } catch (e) {
    return res.status(500).json({ error: "Error al verificar el rol del usuario." });
  }

  const { title, body, url, image, segments } = req.body;
  if (!title || !body || !url) {
    return res.status(400).json({ error: "Faltan los campos title, body, o url." });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --- SOLUCIÓN ARQUITECTÓNICA: LÓGICA DE NOTIFICACIONES CORREGIDA ---
    // 1. OBTENER IDs DE USUARIO ÚNICOS
    let userIdsQuery;
    const queryParams = [];
    if (segments && segments.state) {
      console.log(`[DB] Obteniendo IDs de usuario para el estado: ${segments.state}`);
      userIdsQuery = `SELECT id FROM usuarios WHERE estado = $1`;
      queryParams.push(segments.state);
    } else {
      console.log(`[DB] Obteniendo todos los IDs de usuario.`);
      userIdsQuery = "SELECT id FROM usuarios";
    }
    const userIdsResult = await client.query(userIdsQuery, queryParams);
    const recipientUserIds = userIdsResult.rows.map(row => row.id);

    if (recipientUserIds.length === 0) {
      await client.query('COMMIT');
      return res.status(200).json({ message: "No hay usuarios que coincidan con el segmento." });
    }
    
    // 2. INSERTAR UNA NOTIFICACIÓN POR USUARIO
    console.log(`[DB] Guardando ${recipientUserIds.length} registro(s) de notificación en el historial.`);
    const insertQuery = `INSERT INTO notificaciones (user_id, titulo, cuerpo, url, imagen) VALUES ($1, $2, $3, $4, $5)`;
    for (const userId of recipientUserIds) {
      await client.query(insertQuery, [userId, title, body, url, image || null]);
    }
    
    // 3. NOTIFICAR A CLIENTES ACTIVOS VÍA WEBSOCKET
    wss.clients.forEach((wsClient) => {
        if (wsClient.readyState === WebSocket.OPEN && recipientUserIds.includes(parseInt(wsClient.userId, 10))) {
            console.log(`[WS] Enviando ping de 'new_notification' al usuario ${wsClient.userId}`);
            wsClient.send(JSON.stringify({ type: "new_notification" }));
        }
    });
    
    // 4. OBTENER TODOS LOS TOKENS Y ENVIAR PUSH
    const tokensResult = await client.query("SELECT token FROM fcm_tokens WHERE user_id = ANY($1::int[])", [recipientUserIds]);
    const tokens = tokensResult.rows.map(row => row.token);

    let fcmResponse = { successCount: 0, failureCount: 0 };
    if (tokens.length > 0) {
      console.log(`[FCM] Enviando notificación push a ${tokens.length} dispositivo(s).`);
      const messagePayload = {
          data: { title, body, image: image || "", url, icon: "https://chatcerex.com/img/icon-192.png" },
          tokens: tokens,
      };
      fcmResponse = await admin.messaging().sendEachForMulticast(messagePayload);
      console.log(`[FCM] Notificaciones enviadas: ${fcmResponse.successCount} con éxito, ${fcmResponse.failureCount} fallaron.`);
      
      if (fcmResponse.failureCount > 0) {
        const tokensToDelete = [];
        fcmResponse.responses.forEach((resp, idx) => {
            if (!resp.success) {
                const errorCode = resp.error.code;
                if (errorCode === "messaging/registration-token-not-registered" || errorCode === "messaging/invalid-registration-token") {
                    tokensToDelete.push(tokens[idx]);
                }
            }
        });
        if (tokensToDelete.length > 0) {
            console.log(`[FCM Cleanup] Eliminando ${tokensToDelete.length} tokens inválidos.`);
            await client.query("DELETE FROM fcm_tokens WHERE token = ANY($1::text[])", [tokensToDelete]);
        }
      }
    }
    // --- FIN DE LA SOLUCIÓN ARQUITECTÓNICA ---
    
    await client.query('COMMIT');

    res.status(200).json({
      message: `Notificación enviada a ${recipientUserIds.length} usuario(s).`,
      successCount: fcmResponse.successCount,
      failureCount: fcmResponse.failureCount,
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`[FCM] Error fatal al enviar notificación, se hizo rollback:`, error);
    res.status(500).json({
      error: "Error interno del servidor al intentar enviar la notificación.",
    });
  } finally {
    client.release();
  }
});
// **NUEVO ENDPOINT** para obtener las notificaciones no leídas
app.get("/api/notifications/unread", authenticateToken, async (req, res) => {
const userId = req.user.id;
try {
  const unreadNotifications = await pool.query(
    "SELECT id, titulo, cuerpo, url, imagen, leida, fecha_creacion FROM notificaciones WHERE user_id = $1 AND leida = FALSE ORDER BY fecha_creacion DESC",
    [userId]
  );
  res.json(unreadNotifications.rows);
} catch (error) {
  console.error("Error al obtener notificaciones no leídas:", error);
  res.status(500).json({ error: "Error interno del servidor." });
}
});

// En server.js, dentro de la sección de ENDPOINTS DE NOTIFICACIONES

app.put("/api/notifications/mark-read/:id", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const notificationId = req.params.id;

  try {
    const result = await pool.query(
      "UPDATE notificaciones SET leida = TRUE WHERE id = $1 AND user_id = $2",
      [notificationId, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Notificación no encontrada o no tienes permiso para marcarla." });
    }

    res.status(200).json({ message: "Notificación marcada como leída." });
  } catch (error) {
    console.error("Error al marcar la notificación como leída:", error);
    res.status(500).json({ error: "Error interno del servidor." });
  }
});


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


app.post("/api/promociones/enviar", authenticateToken, async (req, res) => {
  const sender = req.user; // { id, nombre }
  const { message, publicationId, recipientIds } = req.body;

  if (!message || !publicationId || !Array.isArray(recipientIds) || recipientIds.length === 0) {
    return res.status(400).json({ error: "Faltan datos para enviar la promoción." });
  }

  const client = await pool.connect();
  try {
    // 1. Verificar permisos (sin cambios)
    const publicationCheck = await client.query(
      "SELECT usuario_id FROM publicaciones WHERE id = $1",
      [publicationId]
    );
    if (
      publicationCheck.rows.length === 0 ||
      publicationCheck.rows[0].usuario_id !== sender.id
    ) {
      return res
        .status(403)
        .json({ error: "No tienes permiso para esta acción." });
    }

    // --- INICIO DE LA SOLUCIÓN ARQUITECTÓNICA ---
    await client.query("BEGIN");

    // 2. (NUEVO) Guardar la notificación en el historial para TODOS los destinatarios.
    console.log(
      `[DB] Guardando historial de promoción para ${recipientIds.length} usuario(s).`
    );
    const notificationTitle = `📢 Nueva promoción de ${sender.nombre}`;
    const notificationUrl = `/publicacion/${publicationId}`;
    const insertQuery = `INSERT INTO notificaciones (user_id, titulo, cuerpo, url) VALUES ($1, $2, $3, $4)`;

    for (const userId of recipientIds) {
      await client.query(insertQuery, [
        userId,
        notificationTitle,
        message,
        notificationUrl,
      ]);
    }

    // 3. Proceder con la entrega diferenciada (Online vs. Offline)
    // 3. Proceder con la entrega diferenciada (Online vs. Offline)
    const onlineUserIds = [];
    wss.clients.forEach((wsClient) => {
      // --- INICIO DE LA SOLUCIÓN ---
      // Convertimos el wsClient.userId (string) a un número antes de la comparación.
      const clientUserId = parseInt(wsClient.userId, 10);
      if (
        wsClient.readyState === WebSocket.OPEN &&
        recipientIds.includes(clientUserId)
      ) {
        // --- FIN DE LA SOLUCIÓN ---
        wsClient.send(
          JSON.stringify({
            type: "promotional_message",
            payload: {
              from: sender.nombre,
              message,
              publicationId,
              timestamp: new Date().toISOString(),
            },
          })
        );
        onlineUserIds.push(clientUserId);
      }
    });

    const offlineUserIds = recipientIds.filter(
      (id) => !onlineUserIds.includes(id)
    );

    if (offlineUserIds.length > 0) {
      console.log(
        `[FCM] Enviando notificaciones push a ${offlineUserIds.length} usuarios offline.`
      );

      const tokensResult = await client.query(
        `SELECT token FROM fcm_tokens WHERE user_id = ANY($1::int[])`,
        [offlineUserIds]
      );
      const tokens = tokensResult.rows.map((row) => row.token);

      if (tokens.length > 0) {
        const messagePayload = {
          data: {
            title: notificationTitle,
            body: message,
            url: `https://chatcerex.com${notificationUrl}`,
            icon: "https://chatcerex.com/img/icon-192.png",
          },
          tokens: tokens,
        };

        // No necesitamos esperar la respuesta, el envío es asíncrono
        admin
          .messaging()
          .sendEachForMulticast(messagePayload)
          .then((response) => {
            console.log(
              `[FCM] Promociones enviadas: ${response.successCount} con éxito.`
            );
            // Aquí puedes añadir la lógica de limpieza de tokens si lo deseas
          })
          .catch((err) =>
            console.error("[FCM] Error al enviar promociones:", err)
          );
      }
    }

    await client.query("COMMIT");
    // --- FIN DE LA SOLUCIÓN ARQUITECTÓNICA ---

    res.status(200).json({
      message: "Promoción enviada y registrada con éxito.",
      totalRecipients: recipientIds.length,
      onlineDeliveries: onlineUserIds.length,
      offlinePushNotifications: offlineUserIds.length,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error fatal al enviar la promoción:", error);
    res.status(500).json({ error: "Error interno del servidor." });
  } finally {
    client.release();
  }
});


// En tu server.js (Render)

app.delete("/api/notifications/:id", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { id: notificationId } = req.params;

  try {
    const deleteResult = await pool.query(
      // CRÍTICO: La cláusula WHERE asegura que un usuario solo pueda borrar SUS PROPIAS notificaciones.
      "DELETE FROM notificaciones WHERE id = $1 AND user_id = $2",
      [notificationId, userId]
    );

    if (deleteResult.rowCount === 0) {
      // Esto ocurre si la notificación no existe o no le pertenece al usuario.
      return res.status(404).json({ error: "Notificación no encontrada o sin permisos para eliminarla." });
    }

    // 204 No Content es la respuesta estándar para una eliminación exitosa.
    res.sendStatus(204); 

  } catch (error) {
    console.error("Error al eliminar la notificación:", error);
    res.status(500).json({ error: "Error interno del servidor." });
  }
});

// =================================================================================
// --- SERVIDOR WEBSOCKET (SIN CAMBIOS EN LA LÓGICA DE CONEXIÓN) ---
// =================================================================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  console.log("🔌 Nuevo cliente conectado.");

  ws.on("message", async (msgRaw) => {
    let msg;
    try {
      msg = JSON.parse(msgRaw);
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", msg: "Formato de mensaje inválido." }));
      return;
    }

    if (msg.type === "identificacion" && msg.userId) {
      ws.userId = msg.userId; // Almacenamos el ID del usuario en la conexión del socket
      console.log(`✅ Usuario ${ws.userId} (${msg.fullName}) identificado.`);
      ws.send(JSON.stringify({ type: "identificado", msg: "Conexión lista." }));
    } else {
      ws.send(JSON.stringify({ type: "error", msg: "Tipo de mensaje no reconocido." }));
    }
  });

  ws.on("close", () => {
    if (ws.userId) {
      console.log(`🔌 Usuario ${ws.userId} desconectado.`);
    }
  });

  ws.on("error", (err) => {
    console.error("❌ WebSocket error:", err);
  });
});

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

server.listen(PORT, () => {
  console.log(`🚀 Servidor WebSocket y API escuchando en el puerto: ${PORT}`);
});