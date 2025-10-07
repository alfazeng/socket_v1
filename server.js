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

// =================================================================================
// --- ENDPOINT DEL CERBOT (MODIFICADO) ---
// =================================================================================
// ARQUITECTO: Reemplaza tu endpoint existente con esta versión corregida.
app.post("/api/cerbot/message", authenticateToken, async (req, res) => {
  const { sellerId, message, sessionId } = req.body;
  const askingUserId = req.user.id;
  
  if (!sellerId || !message || !sessionId) {
      return res.status(400).json({ error: "Faltan sellerId, message, o sessionId." });
  }

  const isTestMode = String(askingUserId) === String(sellerId);
  let updatedCredit = null;

  try {
      // --- INICIO DE LA LÓGICA DE CRÉDITOS CONDICIONAL ---
      if (isTestMode) {
          console.log(`[Cerbot] MODO PRUEBA: El dueño (ID: ${sellerId}) está probando su bot. No se aplican cargos.`);
      } else {
          // FLUJO DE PRODUCCIÓN: Se debita al vendedor.
          const debitAmount = 10.00;
          const debitDescription = `Costo por respuesta de Cerbot (al usuario ID: ${askingUserId})`;

          const debitResponse = await fetch(`${GO_BACKEND_URL}/api/usuarios/debitar-creditos`, {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${INTERNAL_API_KEY}`
              },
              body: JSON.stringify({
                  monto: debitAmount,
                  userID: parseInt(sellerId, 10),
                  descripcion: debitDescription
              })
          });

          if (debitResponse.status === 402) {
              console.warn(`[Cerbot] Créditos insuficientes para el vendedor ID: ${sellerId}.`);
              return res.status(402).json({ error: 'El asistente no está disponible en este momento.' });
          }
          if (!debitResponse.ok) {
              const errorData = await debitResponse.json();
              throw new Error(errorData.error || 'Fallo en el sistema de créditos de Go.');
          }

          const debitData = await debitResponse.json();
          updatedCredit = debitData.newBalance; // Guardamos el nuevo saldo para la respuesta.
          console.log(`[Cerbot] Débito exitoso. Vendedor ID: ${sellerId}, Nuevo Saldo: ${updatedCredit}`);
      }
      // --- FIN DE LA LÓGICA DE CRÉDITOS CONDICIONAL ---

      // ARQUITECTO: La lógica de la IA ahora se ejecuta para AMBOS flujos (prueba y producción).
      const n8nReasoningWebhook = process.env.N8N_ASSISTANT_WEBHOOK_URL;
      if (!n8nReasoningWebhook) {
          throw new Error("N8N_ASSISTANT_WEBHOOK_URL no está configurada.");
      }

      const timeZone = "America/Caracas";
      const currentHour = parseInt(new Date().toLocaleTimeString("en-US", { timeZone, hour12: false, hour: "2-digit" }));
      let timeOfDay;
      if (currentHour >= 5 && currentHour < 12) timeOfDay = "mañana";
      else if (currentHour >= 12 && currentHour < 19) timeOfDay = "tarde";
      else if (currentHour >= 1 && currentHour < 5) timeOfDay = "madrugada";
      else timeOfDay = "noche";
      const timeContext = new Date().toLocaleString("es-VE", { timeZone });

      const n8nResponse = await axios.post(n8nReasoningWebhook, {
          sellerId: sellerId,
          user_question: message,
          sessionId: sessionId,
          timeContext: timeContext,
          timeOfDay: timeOfDay,
      }, { timeout: 15000 });

      // Enviamos la respuesta de la IA y el nuevo saldo (si aplica).
      res.json({
          botResponse: n8nResponse.data.respuesta || "No pude procesar la respuesta en este momento.",
          updatedCredit: updatedCredit // Será `null` en modo de prueba, o el nuevo saldo en producción.
      });

  } catch (error) {
      console.error(`[Cerbot] Error en el endpoint /message:`, error);
      if (axios.isAxiosError(error) && (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT")) {
          return res.status(504).json({ botResponse: "El asistente está tardando mucho en responder. Intenta de nuevo más tarde." });
      }
      if (!res.headersSent) {
          return res.status(500).json({ error: error.message || 'Error interno del servidor.' });
      }
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



// ARQUITECTO: Reemplaza tu endpoint existente con esta versión completa y robusta.
app.post("/api/promociones/enviar", authenticateToken, async (req, res) => {
  const sender = req.user; // { id, nombre }
  const { message, publicationId, recipientIds } = req.body;

  if (!message || !publicationId || !Array.isArray(recipientIds) || recipientIds.length === 0) {
    return res.status(400).json({ error: "Faltan datos para enviar la promoción." });
  }

  // --- ARQUITECTO: FASE 1 - PROCESAMIENTO DEL PAGO ---
  // Calculamos el costo total y preparamos la descripción del débito.
  const costoTotal = 20.0 * recipientIds.length;
  const debitDescription = `Costo por campaña a ${recipientIds.length} usuarios (publicación ID: ${publicationId})`;

  try {
    // Llamamos al backend de Go para debitar los créditos ANTES de cualquier otra operación.
    const debitResponse = await fetch(`${GO_BACKEND_URL}/api/usuarios/debitar-creditos`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': req.headers.authorization // Reutilizamos el token del usuario que hace la petición.
        },
        body: JSON.stringify({
            monto: costoTotal,
            descripcion: debitDescription
            // No se necesita 'userID' porque Go lo infiere del token del usuario.
        })
    });

    // Manejamos la respuesta del sistema de créditos.
    if (debitResponse.status === 402) { // 402 Payment Required
        console.warn(`[Promociones] Créditos insuficientes para el usuario ID: ${sender.id}.`);
        return res.status(402).json({ error: 'Créditos insuficientes para enviar la campaña.' });
    }

    if (!debitResponse.ok) {
        const errorData = await debitResponse.json();
        throw new Error(errorData.error || 'Fallo en el sistema de créditos de Go.');
    }

    const debitData = await debitResponse.json();
    console.log(`[Promociones] Débito exitoso. Usuario ID: ${sender.id}, Nuevo Saldo: ${debitData.newBalance}`);

  } catch (error) {
      console.error("[Promociones] Error fatal durante el proceso de débito:", error);
      return res.status(500).json({ error: error.message || "Error al procesar el pago de créditos." });
  }
  // --- FIN DE LA FASE DE PAGO ---


  // --- ARQUITECTO: FASE 2 - ENTREGA DEL SERVICIO (SOLO SI EL PAGO FUE EXITOSO) ---
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const publicationCheck = await client.query("SELECT usuario_id FROM publicaciones WHERE id = $1", [publicationId]);
    if (publicationCheck.rows.length === 0 || publicationCheck.rows[0].usuario_id !== sender.id) {
        await client.query('ROLLBACK');
        // Nota: El crédito ya fue debitado. Este es un caso de error que debe ser monitoreado.
        return res.status(403).json({ error: "Pago procesado, pero no tienes permiso para esta publicación." });
    }

    // Guardar historial de notificaciones
    const notificationTitle = `📢 Nueva promoción de ${sender.nombre}`;
    const notificationUrl = `/publicacion/${publicationId}`;
    const insertQuery = `INSERT INTO notificaciones (user_id, titulo, cuerpo, url) VALUES ($1, $2, $3, $4)`;
    for (const userId of recipientIds) {
        await client.query(insertQuery, [userId, notificationTitle, message, notificationUrl]);
    }

    // Lógica de entrega diferenciada (WebSocket y FCM)
    const onlineUserIds = [];
    wss.clients.forEach((wsClient) => {
        const clientUserId = parseInt(wsClient.userId, 10);
        if (wsClient.readyState === WebSocket.OPEN && recipientIds.includes(clientUserId)) {
            wsClient.send(JSON.stringify({
                type: "promotional_message",
                payload: { from: sender.nombre, message, publicationId, timestamp: new Date().toISOString() },
            }));
            onlineUserIds.push(clientUserId);
        }
    });

    const offlineUserIds = recipientIds.filter((id) => !onlineUserIds.includes(id));
    if (offlineUserIds.length > 0) {
        const tokensResult = await client.query(`SELECT token FROM fcm_tokens WHERE user_id = ANY($1::int[])`, [offlineUserIds]);
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
            // Se envía de forma asíncrona, no bloqueamos la respuesta.
            admin.messaging().sendEachForMulticast(messagePayload)
              .catch(err => console.error("[FCM] Error asíncrono al enviar promociones:", err));
        }
    }

    await client.query("COMMIT");

    res.status(200).json({
      message: "Campaña enviada y registrada con éxito.",
      totalRecipients: recipientIds.length,
      onlineDeliveries: onlineUserIds.length,
      offlinePushNotifications: offlineUserIds.length,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error fatal al enviar la promoción (post-pago):", error);
    res.status(500).json({
        error: "El pago fue procesado, pero ocurrió un error al enviar las notificaciones."
    });
  } finally {
    client.release();
  }
});


// ARQUITECTO: Endpoint de EDICIÓN completamente reescrito
app.put("/api/publicaciones/:id", 
  authenticateToken, 
  upload.array('images', 3), // Usamos el middleware de multer aquí. 'images' debe coincidir con el nombre del campo en el FormData del cliente.
  async (req, res) => {
  
  const userId = req.user.id;
  const postId = req.params.id;

  // --- FASE 1: PROCESAMIENTO DEL PAGO (sin cambios, ya funciona) ---
  try {
      const debitAmount = 100.00;
      const debitDescription = `Costo por edición de publicación ID: ${postId}`;

      const debitResponse = await fetch(`${GO_BACKEND_URL}/api/usuarios/debitar-creditos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': req.headers.authorization },
          body: JSON.stringify({ monto: debitAmount, descripcion: debitDescription })
      });

      if (debitResponse.status === 402) {
          return res.status(402).json({ error: 'Créditos insuficientes para editar.' });
      }
      if (!debitResponse.ok) {
          const errorData = await debitResponse.json();
          throw new Error(errorData.error || 'Fallo en el sistema de créditos.');
      }
      console.log(`[Edición] Débito de ${debitAmount} exitoso para el usuario ID: ${userId}`);
  } catch (error) {
      console.error("[Edición] Error durante el débito:", error);
      return res.status(500).json({ error: error.message || "Error al procesar el pago." });
  }

  // --- FASE 2: RECONSTRUCCIÓN Y ENVÍO DEL FORMDATA A GO ---
  try {
      // ARQUITECTO: Creamos un nuevo FormData para reenviar los datos.
      const formData = new FormData();

      // 1. Añadimos los campos de texto que multer ha parseado en req.body
      formData.append('titulo', req.body.titulo);
      formData.append('descripcion', req.body.descripcion);
      formData.append('category', req.body.category);
      formData.append('tags', req.body.tags); // Asumiendo que las tags vienen como un string JSON

      // 2. Añadimos los archivos (si los hay) que multer ha puesto en req.files
      if (req.files && req.files.length > 0) {
          req.files.forEach(file => {
              // Usamos el buffer del archivo en memoria.
              formData.append('images', file.buffer, { filename: file.originalname });
          });
      }
      
      // 3. Reenviamos la petición a Go, esta vez como multipart/form-data
      const updateResponse = await fetch(`${GO_BACKEND_URL}/api/publicaciones/${postId}`, {
          method: 'PUT',
          headers: {
              // ARQUITECTO: ¡Crucial! Dejamos que node-fetch establezca el Content-Type y el boundary por nosotros.
              // No lo definimos manualmente.
              ...formData.getHeaders(),
              'Authorization': req.headers.authorization
          },
          body: formData
      });

      if (!updateResponse.ok) {
          const errorData = await updateResponse.json();
          throw new Error(errorData.error || 'El pago fue exitoso, pero la actualización falló.');
      }

      const updateData = await updateResponse.json();
      res.status(200).json(updateData);

  } catch (error) {
      console.error("[Edición] Error en fase de actualización:", error);
      res.status(500).json({ error: error.message });
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