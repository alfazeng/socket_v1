const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const { Pool } = require("pg");
const cors = require("cors");
const admin = require("firebase-admin");
const axios = require("axios");
const fetch = require("node-fetch");
const multer = require("multer");
const FormData = require("form-data");
const fs = require("fs"); 

// --- Configuración de Multer ---
// Usamos almacenamiento en memoria porque solo actuamos como proxy.
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

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

// ARQUITECTO: Cargamos las variables de entorno para la comunicación con el backend de Go.
const GO_BACKEND_URL = process.env.GO_BACKEND_URL;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

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


// --- ARQUITECTO: INICIO DE LA NUEVA IMPLEMENTACIÓN ---
// En: server.js
// REEMPLAZA tu endpoint /api/conversations con este.

app.get("/api/conversations", authenticateToken, async (req, res) => {
  const currentUserID = req.user.id;
  try {
    // ANÁLISIS ARQUITECTÓNICO:
    // Esta consulta ha sido rediseñada para ser el motor del sistema de notificaciones.
    // 1. LEFT JOIN en `messages`: Asegura que las conversaciones sin mensajes también se listen.
    // 2. COUNT(...) FILTER (...): Es la clave. Cuenta eficientemente solo los mensajes
    //    donde el destinatario es el usuario actual Y `read_at` es NULL.
    //    Este es el `unread_count` que el frontend necesita.
    const query = `
      SELECT
        c.id AS conversation_id,
        (
          SELECT json_agg(
            json_build_object(
              'user_id', p_user.id,
              'username', p_user.nombre,
              'profileImage', p_user.url_imagen_perfil
            )
          )
          FROM conversation_participants cp
          JOIN usuarios p_user ON cp.user_id = p_user.id
          WHERE cp.conversation_id = c.id
        ) AS participants,
        (
          SELECT json_build_object('content', m.content, 'timestamp', m.timestamp)
          FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.timestamp DESC
          LIMIT 1
        ) AS last_message,
        COUNT(m.id) FILTER (WHERE m.to_user_id = $1 AND m.read_at IS NULL) AS unread_count
      FROM conversations c
      JOIN conversation_participants p ON c.id = p.conversation_id
      LEFT JOIN messages m ON c.id = m.conversation_id
      WHERE p.user_id = $1
      GROUP BY c.id
      ORDER BY MAX(m.timestamp) DESC NULLS LAST;
    `;
    const result = await pool.query(query, [currentUserID]);
    res.json(result.rows);
  } catch (error) {
    console.error("Error al obtener conversaciones:", error);
    res.status(500).json({ error: "Error interno del servidor." });
  }
});

// En: server.js
// AÑADE este nuevo endpoint, preferiblemente cerca de los otros de conversaciones.

app.put("/api/conversations/:id/mark-read", authenticateToken, async (req, res) => {
  const currentUserID = req.user.id;
  const conversationId = req.params.id;
  try {
    // Este endpoint marca todos los mensajes no leídos dirigidos al usuario actual
    // dentro de una conversación específica como leídos.
    await pool.query(
      "UPDATE messages SET read_at = NOW() WHERE conversation_id = $1 AND to_user_id = $2 AND read_at IS NULL",
      [conversationId, currentUserID]
    );
    res.sendStatus(204); // No Content - Éxito sin devolver datos.
  } catch (error) {
    console.error("Error al marcar mensajes como leídos:", error);
    res.status(500).json({ error: "Error interno del servidor." });
  }
});

// ARQUITECTO: Se ha reemplazado la consulta de búsqueda por una más eficiente.
app.post("/api/conversations/find-or-create", authenticateToken, async (req, res) => {
  const currentUserID = req.user.id;
  const { otherUserID } = req.body;

  if (!otherUserID || currentUserID === otherUserID) {
    return res.status(400).json({ error: "ID de usuario inválido." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // SOLUCIÓN: Consulta optimizada para encontrar la conversación.
    const findQuery = `
      SELECT conversation_id FROM conversation_participants
      WHERE user_id IN ($1, $2)
      GROUP BY conversation_id
      HAVING COUNT(DISTINCT user_id) = 2;
    `;
    const findResult = await client.query(findQuery, [currentUserID, otherUserID]);

    let conversationId;

    if (findResult.rows.length > 0) {
      conversationId = findResult.rows[0].conversation_id;
    } else {
      const createConvResult = await client.query("INSERT INTO conversations DEFAULT VALUES RETURNING id");
      conversationId = createConvResult.rows[0].id;
      await client.query(
        "INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)",
        [conversationId, currentUserID, otherUserID]
      );
    }

    await client.query("COMMIT");
    res.status(200).json({ conversationId });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error en /api/conversations/find-or-create:", error);
    res.status(500).json({ error: "Error al procesar la conversación." });
  } finally {
    client.release();
  }
});


app.get(
  "/api/conversations/:id/messages",
  authenticateToken,
  async (req, res) => {
    const currentUserID = req.user.id;
    const conversationId = req.params.id;
    try {
      const checkAccess = await pool.query(
        "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
        [conversationId, currentUserID]
      );

      if (checkAccess.rowCount === 0) {
        return res
          .status(403)
          .json({ error: "No tienes acceso a esta conversación." });
      }

      const messages = await pool.query(
        "SELECT id, from_user_id, content, timestamp FROM messages WHERE conversation_id = $1 ORDER BY timestamp ASC",
        [conversationId]
      );
      res.json(messages.rows);
    } catch (error) {
      console.error(
        `Error al obtener mensajes para la conversación ${conversationId}:`,
        error
      );
      res.status(500).json({ error: "Error interno del servidor." });
    }
  }
);


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

// --- ENDPOINT DE ENVÍO DE NOTIFICACIONES (CORREGIDO) ---
app.post("/api/notifications/send", authenticateToken, async (req, res) => {
  try {
    const userCheck = await pool.query(
      "SELECT rol FROM usuarios WHERE id = $1",
      [req.user.id]
    );
    if (userCheck.rows.length === 0 || userCheck.rows[0].rol !== "admin") {
      return res
        .status(403)
        .json({ error: "Acceso denegado. Se requiere rol de administrador." });
    }
  } catch (e) {
    return res
      .status(500)
      .json({ error: "Error al verificar el rol del usuario." });
  }

  const { title, body, url, image, segments } = req.body;
  if (!title || !body || !url) {
    return res
      .status(400)
      .json({ error: "Faltan los campos title, body, o url." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let userIdsQuery;
    const queryParams = [];
    if (segments && segments.state) {
      userIdsQuery = `SELECT id FROM usuarios WHERE estado = $1`;
      queryParams.push(segments.state);
    } else {
      userIdsQuery = "SELECT id FROM usuarios";
    }
    const userIdsResult = await client.query(userIdsQuery, queryParams);
    const recipientUserIds = userIdsResult.rows.map((row) => row.id);

    if (recipientUserIds.length === 0) {
      await client.query("COMMIT");
      return res
        .status(200)
        .json({ message: "No hay usuarios que coincidan con el segmento." });
    }

    const insertQuery = `INSERT INTO notificaciones (user_id, titulo, cuerpo, url, imagen) VALUES ($1, $2, $3, $4, $5)`;
    for (const userId of recipientUserIds) {
      await client.query(insertQuery, [
        userId,
        title,
        body,
        url,
        image || null,
      ]);
    }

    wss.clients.forEach((wsClient) => {
      if (
        wsClient.readyState === WebSocket.OPEN &&
        recipientUserIds.includes(parseInt(wsClient.userId, 10))
      ) {
        wsClient.send(JSON.stringify({ type: "new_notification" }));
      }
    });

    const tokensResult = await client.query(
      "SELECT token FROM fcm_tokens WHERE user_id = ANY($1::int[])",
      [recipientUserIds]
    );
    const tokens = tokensResult.rows.map((row) => row.token);

    let fcmResponse = { successCount: 0, failureCount: 0 };
    if (tokens.length > 0) {
      // --- INICIO DE LA SOLUCIÓN ARQUITECTÓNICA ---
      const messagePayload = {
        tokens: tokens,
        // PAYLOAD PARA LA NOTIFICACIÓN VISIBLE
        notification: {
          title: title,
          body: body,
          image: image || undefined, // `image` es opcional
        },
        // PAYLOAD DE DATOS PARA MANEJAR EL CLIC EN LA APP
        data: {
          url: url,
          icon: "https://chatcerex.com/img/icon-192_v2.png",
        },
      };
      // --- FIN DE LA SOLUCIÓN ARQUITECTÓNICA ---

      fcmResponse = await admin
        .messaging()
        .sendEachForMulticast(messagePayload);
      console.log(
        `[FCM] Notificaciones enviadas: ${fcmResponse.successCount} con éxito, ${fcmResponse.failureCount} fallaron.`
      );

      if (fcmResponse.failureCount > 0) {
        const tokensToDelete = [];
        fcmResponse.responses.forEach((resp, idx) => {
          if (!resp.success) {
            const errorCode = resp.error.code;
            if (
              errorCode === "messaging/registration-token-not-registered" ||
              errorCode === "messaging/invalid-registration-token"
            ) {
              tokensToDelete.push(tokens[idx]);
            }
          }
        });
        if (tokensToDelete.length > 0) {
          await client.query(
            "DELETE FROM fcm_tokens WHERE token = ANY($1::text[])",
            [tokensToDelete]
          );
        }
      }
    }

    await client.query("COMMIT");

    res.status(200).json({
      message: `Notificación enviada a ${recipientUserIds.length} usuario(s).`,
      successCount: fcmResponse.successCount,
      failureCount: fcmResponse.failureCount,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(
      `[FCM] Error fatal al enviar notificación, se hizo rollback:`,
      error
    );
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
    `SELECT id, titulo, cuerpo, url, imagen, leida, fecha_creacion, type, sender_id 
     FROM notificaciones 
     WHERE user_id = $1 AND leida = FALSE 
     ORDER BY fecha_creacion DESC`,
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

// =================================================================================
// --- ENDPOINT DEL CERBOT (MODIFICADO) ---
// =================================================================================
// ARQUITECTO: Endpoint /api/cerbot/message con validación de estado del Cerbot.
app.post("/api/cerbot/message", authenticateToken, async (req, res) => {
  const { sellerId, message, sessionId } = req.body;
  const askingUserId = req.user.id;

  if (!sellerId || !message || !sessionId) {
    return res
      .status(400)
      .json({ error: "Faltan sellerId, message, o sessionId." });
  }

  const isTestMode = String(askingUserId) === String(sellerId);

  try {
    const sellerCheckResult = await pool.query(
      "SELECT cerbot_activo FROM usuarios WHERE id = $1",
      [sellerId]
    );

    const isCerbotActive = sellerCheckResult.rows[0]?.cerbot_activo;

    if (!isCerbotActive && !isTestMode) {
      return res.json({
        botResponse:
          "Este usuario no ha configurado su Cerbot a detalle, sin embargo estoy aquí para brindarte apoyo sobre esta publicación. Lo más seguro es que lo que estás buscando se resuelva escribiéndole directamente por WhatsApp. 📲 Toca el botón verde que aparece abajo para chatear directamente con el vendedor.",
      });
    }

    // --- INICIO DE LA SOLUCIÓN ARQUITECTÓNICA ---
    // FASE 1: OBTENER LA RESPUESTA DE LA IA PRIMERO
    const n8nReasoningWebhook = process.env.N8N_ASSISTANT_WEBHOOK_URL;
    if (!n8nReasoningWebhook) {
      throw new Error("N8N_ASSISTANT_WEBHOOK_URL no está configurada.");
    }

    const timeZone = "America/Caracas";
    const currentHour = parseInt(
      new Date().toLocaleTimeString("en-US", {
        timeZone,
        hour12: false,
        hour: "2-digit",
      })
    );
    let timeOfDay;
    if (currentHour >= 5 && currentHour < 12) timeOfDay = "mañana";
    else if (currentHour >= 12 && currentHour < 19) timeOfDay = "tarde";
    else if (currentHour >= 1 && currentHour < 5) timeOfDay = "madrugada";
    else timeOfDay = "noche";
    const timeContext = new Date().toLocaleString("es-VE", { timeZone });

    const n8nResponse = await axios.post(
      n8nReasoningWebhook,
      {
        sellerId: sellerId,
        user_question: message,
        sessionId: sessionId,
        timeContext: timeContext,
        timeOfDay: timeOfDay,
      },
      { timeout: 15000 }
    );

    const botResponse =
      n8nResponse.data.respuesta ||
      "No pude procesar la respuesta en este momento.";

    // Si estamos en modo de prueba, devolvemos la respuesta sin cobrar.
    if (isTestMode) {
      console.log(
        `[Cerbot] MODO PRUEBA: El dueño (ID: ${sellerId}) está probando su bot. No se aplican cargos.`
      );
      return res.json({ botResponse, updatedCredit: null });
    }

    // FASE 2: PROCESAR EL PAGO (SOLO SI LA IA RESPONDIÓ Y NO ES MODO PRUEBA)
    const debitAmount = parseFloat(process.env.COST_CERBOT_RESPONSE) || 2.0;
    const debitDescription = `Costo por respuesta de Cerbot (al usuario ID: ${askingUserId})`;

    const debitResponse = await fetch(
      `${GO_BACKEND_URL}/api/usuarios/debitar-creditos`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${INTERNAL_API_KEY}`,
        },
        body: JSON.stringify({
          monto: debitAmount,
          userID: parseInt(sellerId, 10),
          descripcion: debitDescription,
        }),
      }
    );

    if (debitResponse.status === 402) {
      console.warn(
        `[Cerbot] Créditos insuficientes para el vendedor ID: ${sellerId}. La respuesta de la IA se envió pero no se pudo cobrar.`
      );
      // Aunque no se pudo cobrar, entregamos la respuesta al usuario final. Es mejor para la UX.
      // Esto debe ser monitoreado como una pérdida para el negocio.
      return res.json({ botResponse, updatedCredit: 0 }); // O el saldo que devuelva el error
    }

    if (!debitResponse.ok) {
      const errorData = await debitResponse.json();
      console.error(
        `[Cerbot PAGO] ¡ALERTA! La respuesta de la IA se dio pero el débito falló.`,
        errorData.error
      );
      return res.json({
        botResponse,
        warning: "Hubo un problema al procesar el costo de esta respuesta.",
      });
    }

    const debitData = await debitResponse.json();
    console.log(
      `[Cerbot] Débito exitoso. Vendedor ID: ${sellerId}, Nuevo Saldo: ${debitData.newBalance}`
    );

    res.json({
      botResponse: botResponse,
      updatedCredit: debitData.newBalance,
    });
    // --- FIN DE LA SOLUCIÓN ARQUITECTÓNICA ---
  } catch (error) {
    console.error(`[Cerbot] Error en el endpoint /message:`, error);
    if (
      axios.isAxiosError(error) &&
      (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT")
    ) {
      return res
        .status(504)
        .json({
          botResponse:
            "El asistente está tardando mucho en responder. Intenta de nuevo más tarde.",
        });
    }
    if (!res.headersSent) {
      return res
        .status(500)
        .json({ error: error.message || "Error interno del servidor." });
    }
  }
});

// ARQUITECTO: Reemplaza tu endpoint POST existente con esta versión robusta.
app.post("/api/cerbot/knowledge", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { categoria, pregunta, respuesta } = req.body;

  if (!categoria || !pregunta || !respuesta) {
    return res.status(400).json({ error: "Todos los campos son requeridos." });
  }

  // --- INICIO DE LA SOLUCIÓN: CONSULTA UPSERT ---
  // Esta consulta intenta insertar. Si encuentra un conflicto en la combinación
  // de (user_id, pregunta), en lugar de fallar, ejecuta una actualización.
  const upsertQuery = `
    INSERT INTO cerbot_conocimiento (user_id, categoria, pregunta, respuesta)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, pregunta)
    DO UPDATE SET
      respuesta = EXCLUDED.respuesta,
      categoria = EXCLUDED.categoria,
      updated_at = NOW()
    RETURNING *;
  `;
  // --- FIN DE LA SOLUCIÓN ---

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(upsertQuery, [userId, categoria, pregunta, respuesta]);

    // Independientemente de si fue un insert o un update, activamos el cerbot.
    const updateUserQuery =
      "UPDATE usuarios SET cerbot_activo = true, cerbot_entrenamiento_completo = true WHERE id = $1";
    await client.query(updateUserQuery, [userId]);

    await client.query("COMMIT");
    
    // Devolvemos el registro guardado (ya sea nuevo o actualizado).
    res.status(200).json(result.rows[0]);

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error al guardar/actualizar conocimiento del Cerbot:", error);
    res.status(500).json({ error: "Error interno del servidor al guardar el conocimiento." });
  } finally {
    client.release();
  }
});

// ARQUITECTO: Añade este nuevo endpoint para solucionar el error 404.
app.get("/api/cerbot/knowledge", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  
  try {
    const result = await pool.query(
      "SELECT * FROM cerbot_conocimiento WHERE user_id = $1 ORDER BY id", 
      [userId]
    );
    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Error al cargar el conocimiento del Cerbot:", error);
    res.status(500).json({ error: "Error interno al cargar el conocimiento." });
  }
});

app.delete("/api/cerbot/knowledge/:id", authenticateToken, async (req, res) => {
    
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

// En server.js, añade este nuevo endpoint para el agente de n8n

app.get("/api/cerbot/search-knowledge", async (req, res) => {
  // El agente pasará el sellerId como un parámetro de consulta
  const { sellerId } = req.query;

  if (!sellerId) {
    return res.status(400).json({ error: "El parámetro sellerId es requerido." });
  }

  try {
    console.log(`[AGENT_API] Buscando base de conocimiento para sellerId: ${sellerId}`);
    const knowledge = await pool.query(
      "SELECT pregunta, respuesta FROM cerbot_conocimiento WHERE user_id = $1",
      [sellerId]
    );
    
    // Devolvemos las filas encontradas como JSON
    res.json(knowledge.rows);

  } catch (error) {
    console.error("Error al buscar en la base de conocimiento:", error);
    res.status(500).json({ error: "Error interno del servidor." });
  }
});// --- ENDPOINTS PARA EL FLUJO DE CRM (NUEVOS) ---
// En server.js, dentro de la sección de ENDPOINTS DE API REST

// --- ENDPOINTS PARA EL FLUJO DE CRM (NUEVOS) ---

// SOLUCIÓN: Añade este endpoint completo.
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

      // 2. Obtener los usuarios únicos que preguntaron en la publicación
      const interestedUsers = await pool.query(
        `SELECT DISTINCT u.id, u.nombre, u.url_imagen_perfil
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

// En: server.js
// ARQUITECTO: Reemplaza tu handler PUT /api/publicaciones/:id existente con esta versión corregida.

// En: server.js
// ARQUITECTO: Handler de EDICIÓN reescrito para ser ATÓMICO (Cobrar primero, editar después).

app.put(
  "/api/publicaciones/:id",
  authenticateToken,
  // 1. Mantenemos la eliminación de "upload.any()".
  async (req, res) => {
    const userId = req.user.id;
    const postId = req.params.id;
    const goBackendUrl = `${GO_BACKEND_URL}/api/publicaciones/${postId}`;

    try {
      // --- INICIO DE LA SOLUCIÓN ARQUITECTÓNICA ---
      // --- FASE 1: PROCESAMIENTO DEL PAGO (Cobrar primero) ---
      const debitAmount = parseFloat(process.env.COST_POST_EDIT) || 100.0;
      const debitDescription = `Costo por edición de publicación ID: ${postId}`;

      const debitResponse = await fetch(
        `${GO_BACKEND_URL}/api/usuarios/debitar-creditos`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Usamos el token del usuario que está autenticado
            Authorization: req.headers.authorization,
          },
          body: JSON.stringify({
            monto: debitAmount,
            descripcion: debitDescription,
            // 2. IMPORTANTE: No pasamos el UserID, Go lo toma del token.
            //    Esto asegura que el usuario 3 se cobre a sí mismo.
          }),
        }
      );

      // 3. Si el débito falla (ej. 402 Créditos Insuficientes), detenemos todo.
      if (!debitResponse.ok) {
        const errorData = await debitResponse.json();
        console.warn(
          `[Edición PAGO RECHAZADO] Usuario ID: ${userId} no pudo editar post ${postId}. Motivo: ${
            errorData.error || "Fallo en el débito"
          }`
        );
        // Devolvemos el error 402 (Payment Required) o el que sea que Go nos dio.
        return res
          .status(debitResponse.status)
          .json({
            error:
              errorData.error || "No se pudo procesar el pago de la edición.",
          });
      }

      console.log(
        `[Edición PAGO] Débito de ${debitAmount} exitoso para el usuario ID: ${userId}`
      );
      // --- FIN DE LA FASE 1 ---

      // --- FASE 2: PROXY DIRECTO DEL STREAM (Solo si el pago fue exitoso) ---
      const proxyResponse = await fetch(goBackendUrl, {
        method: "PUT",
        headers: {
          "Content-Type": req.headers["content-type"],
          Authorization: req.headers.authorization,
        },
        // 4. Usamos "req" (el stream) como body, tal como en el fix anterior.
        body: req,
      });
      // --- FIN DE LA SOLUCIÓN ARQUITECTÓNICA ---

      const responseData = await proxyResponse.json();

      if (!proxyResponse.ok) {
        // En este caso improbable, el PAGO tuvo éxito pero la EDICIÓN falló.
        // Esto debe ser monitoreado y el crédito devuelto (lógica de compensación).
        console.error(
          `[Edición Proxy] ¡ALERTA CRÍTICA! Se cobró al usuario ${userId} pero la edición falló. Se necesita REEMBOLSO.`
        );
        return res
          .status(proxyResponse.status)
          .json({
            error:
              responseData.error ||
              "El backend de Go rechazó la actualización (post-pago).",
            warning:
              "Se ha cobrado la edición pero la actualización falló. Contacta a soporte.",
          });
      }

      console.log(
        `[Edición] Actualización de post ${postId} exitosa (post-pago).`
      );
      // Devolvemos el 200 OK con los datos de la publicación actualizada
      res.status(200).json(responseData);
    } catch (error) {
      console.error(
        "[Edición] Error fatal en el proxy de actualización:",
        error
      );
      res.status(500).json({
        error: "Error interno del servidor al procesar la edición.",
      });
    }
  }
);

app.post("/api/promociones/enviar", authenticateToken, async (req, res) => {
  const sender = req.user; // { id, nombre }
  const { message, publicationId, recipientIds } = req.body;

  if (
    !message ||
    !publicationId ||
    !Array.isArray(recipientIds) ||
    recipientIds.length === 0
  ) {
    return res
      .status(400)
      .json({ error: "Faltan datos para enviar la promoción." });
  }

  // --- FASE 1: PROCESAMIENTO DEL PAGO (Sin cambios) ---
  const costPerUser = parseFloat(process.env.COST_PROMOTION_PER_USER) || 10.0;
  const costoTotal = costPerUser * recipientIds.length;
  const debitDescription = `Costo por campaña a ${recipientIds.length} usuarios (publicación ID: ${publicationId})`;

  try {
    const debitResponse = await fetch(
      `${GO_BACKEND_URL}/api/usuarios/debitar-creditos`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: req.headers.authorization,
        },
        body: JSON.stringify({
          monto: costoTotal,
          descripcion: debitDescription,
        }),
      }
    );
    if (debitResponse.status === 402) {
      return res
        .status(402)
        .json({ error: "Créditos insuficientes para enviar la campaña." });
    }
    if (!debitResponse.ok) {
      const errorData = await debitResponse.json();
      throw new Error(
        errorData.error || "Fallo en el sistema de créditos de Go."
      );
    }
    const debitData = await debitResponse.json();
    console.log(
      `[Promociones] Débito exitoso. Usuario ID: ${sender.id}, Nuevo Saldo: ${debitData.newBalance}`
    );
  } catch (error) {
    console.error("[Promociones] Error durante el proceso de débito:", error);
    return res
      .status(500)
      .json({ error: error.message || "Error al procesar el pago de créditos." });
  }

  // --- FASE 2: ENTREGA DEL SERVICIO (CON LÓGICA 'AWAIT' CORREGIDA) ---
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const publicationCheck = await client.query(
      "SELECT usuario_id FROM publicaciones WHERE id = $1",
      [publicationId]
    );
    if (
      publicationCheck.rows.length === 0 ||
      publicationCheck.rows[0].usuario_id !== sender.id
    ) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        error: "Pago procesado, pero no tienes permiso para esta publicación.",
      });
    }

    const notificationTitle = `📢 Nueva promoción de ${sender.nombre}`;
    const notificationUrl = `/publicacion/${publicationId}`;
    
    const onlineUserIds = [];
    const offlineUserIds = [];

    for (const userId of recipientIds) {
      const insertQuery = `
        INSERT INTO notificaciones (user_id, titulo, cuerpo, url, type, sender_id) 
        VALUES ($1, $2, $3, $4, 'promocion', $5) RETURNING *;
      `;
      const result = await client.query(insertQuery, [
        userId,
        notificationTitle,
        message,
        notificationUrl,
        sender.id,
      ]);
      const newNotification = result.rows[0];

      const recipientSocket = clients.get(String(userId));
      if (
        recipientSocket &&
        recipientSocket.readyState === WebSocket.OPEN
      ) {
        recipientSocket.send(
          JSON.stringify({
            type: "new_notification",
            payload: newNotification,
          })
        );
        onlineUserIds.push(userId);
      } else {
        offlineUserIds.push(userId);
      }
    }
    
    let fcmSuccessCount = 0;
    let fcmFailureCount = 0;

    if (offlineUserIds.length > 0) {
      const tokensResult = await client.query(
        `SELECT token FROM fcm_tokens WHERE user_id = ANY($1::int[])`,
        [offlineUserIds]
      );
      const tokens = tokensResult.rows.map((row) => row.token);

      if (tokens.length > 0) {
        const messagePayload = {
          tokens: tokens,
          notification: {
            title: notificationTitle,
            body: message.substring(0, 100),
          },
          data: {
            url: `https://chatcerex.com${notificationUrl}`,
            icon: "https://chatcerex.com/img/icon-192_v2.png",
            type: "promocion",
            senderId: String(sender.id),
          },
        };
        
        // --- INICIO DE LA SOLUCIÓN ARQUITECTÓNICA ---
        // Se añade 'await' para asegurar que el envío se complete antes de continuar.
        // Se captura la respuesta para un logging más preciso.
        const fcmResponse = await admin.messaging().sendEachForMulticast(messagePayload);
        fcmSuccessCount = fcmResponse.successCount;
        fcmFailureCount = fcmResponse.failureCount;
        console.log(
          `[FCM Promociones] Envío completado: ${fcmSuccessCount} con éxito, ${fcmFailureCount} fallaron.`
        );
        // (Aquí se puede añadir la lógica de auto-curación de tokens si se desea)
        // --- FIN DE LA SOLUCIÓN ARQUITECTÓNICA ---
      }
    }

    await client.query("COMMIT");

    res.status(200).json({
      message: "Campaña enviada y registrada con éxito.",
      totalRecipients: recipientIds.length,
      onlineDeliveries: onlineUserIds.length,
      offlinePushNotifications: offlineUserIds.length, // Mantenemos este para consistencia con la respuesta anterior
      pushSuccess: fcmSuccessCount,
      pushFailures: fcmFailureCount,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error fatal al enviar la promoción (post-pago):", error);
    res.status(500).json({
      error:
        "El pago fue procesado, pero ocurrió un error al enviar las notificaciones.",
    });
  } finally {
    client.release();
  }
});




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
// --- ARQUITECTO: MIDDLEWARE DE DIAGNÓSTICO PARA RUTAS 404 ---
// =================================================================================
// Este middleware se ejecutará para cualquier petición a /api/* que no haya sido
// manejada por ninguna de las rutas anteriores.
app.use("/api", (req, res, next) => {
  console.log(`[DIAGNÓSTICO 404] Petición no manejada recibida: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ 
    error: "Endpoint no encontrado.",
    diagnostic: `La petición ${req.method} ${req.originalUrl} llegó al servidor pero no fue reconocida por ninguna ruta.`,
    tip: "Verifica que la última versión del código esté desplegada correctamente en el servidor."
  });
});

// =================================================================================
// --- SERVIDOR WEBSOCKET (CON PUSH NOTIFICATIONS OPTIMIZADAS PARA CHAT) ---
// =================================================================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map();

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  console.log("🔌 Nuevo cliente conectado.");

  ws.on("message", async (msgRaw) => {
    let msg;
    try {
      msg = JSON.parse(msgRaw);
    } catch (err) {
      return;
    }

    switch (msg.type) {
      case "identificacion":
        if (msg.userId) {
          ws.userId = msg.userId;
          clients.set(ws.userId, ws);
          console.log(
            `✅ Usuario ${ws.userId} (${msg.fullName}) identificado.`
          );
        }
        break;

      case "chat_message":
        const client = await pool.connect();
        try {
          await client.query("BEGIN");

          const { conversation_id, recipient_id, content, publicationId } =
            msg.payload;
          const senderId = ws.userId;

          if (publicationId) {
            const insertConversionQuery = `
              INSERT INTO campaign_responses (publication_id, consumer_id, seller_id)
              VALUES ($1, $2, $3)
              ON CONFLICT (publication_id, consumer_id) DO NOTHING;
            `;
            await client.query(insertConversionQuery, [
              publicationId,
              senderId,
              recipient_id,
            ]);
          }

          const insertResult = await client.query(
            "INSERT INTO messages (conversation_id, from_user_id, to_user_id, content) VALUES ($1, $2, $3, $4) RETURNING id, from_user_id, content, timestamp",
            [conversation_id, senderId, recipient_id, content]
          );
          const newMessage = insertResult.rows[0];
          await client.query("COMMIT");

          const recipientSocket = clients.get(String(recipient_id));
          if (
            recipientSocket &&
            recipientSocket.readyState === WebSocket.OPEN
          ) {
            recipientSocket.send(
              JSON.stringify({
                type: "new_chat_message",
                payload: { ...newMessage, conversation_id },
              })
            );
          } else {
            // --- INICIO DE LA SOLUCIÓN ARQUITECTÓNICA ---
            console.log(`[WS] Usuario ${recipient_id} offline. Enviando PUSH tipo PING.`);
            
            const tokensResult = await pool.query(
              "SELECT token FROM fcm_tokens WHERE user_id = $1",
              [recipient_id]
            );
            const tokens = tokensResult.rows.map((row) => row.token);

            if (tokens.length > 0) {
              const messagePayload = {
                tokens: tokens,
                notification: {
                  title: "Nuevo Mensaje",
                  body: "Tienes un nuevo mensaje.",
                },
                data: {
                  url: `https://chatcerex.com/chat?conversationId=${conversation_id}`,
                  icon: "https://chatcerex.com/img/icon-192_v2.png",
                  type: "chat_message",
                },
              };

              const fcmResponse = await admin.messaging().sendEachForMulticast(messagePayload);
              console.log(
                `[FCM Chat PING] Notificaciones enviadas: ${fcmResponse.successCount} con éxito, ${fcmResponse.failureCount} fallaron.`
              );
            }
            // --- FIN DE LA SOLUCIÓN ARQUITECTÓNICA ---
          }
        } catch (error) {
          await client.query("ROLLBACK");
          console.error("[WS] Error al procesar chat_message:", error);
        } finally {
          client.release();
        }
        break;
    }
  });

  ws.on("close", () => {
    if (ws.userId) {
      clients.delete(ws.userId);
      console.log(`🔌 Usuario ${ws.userId} desconectado.`);
    }
  });
  ws.on("error", (err) => console.error("❌ WebSocket error:", err));
});

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

server.listen(PORT, () => {
  console.log(`🚀 Servidor WebSocket y API escuchando en el puerto: ${PORT}`);
});