const WebSocket = require("ws");
const mysql = require("mysql2/promise");
const webpush = require("web-push");

// --- CLAVES VAPID (pon las tuyas aquí) ---
const VAPID_PUBLIC_KEY =
  "BKk3imcvxH5Wdz2k7O8-E3-mAM73dDLbIueqvVYuSVLNsUCEAfvtNhdG_2DFYXHihC2LvCfzSdEH3oudEjF3vjY";
const VAPID_PRIVATE_KEY = "Co3e5xGt6GM5zRREBPcgoSH1DhW6pF8ej95Ysv7d6YI";
webpush.setVapidDetails(
  "mailto:chatcerexapp@chatcerexapp.com",
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// --- CONFIGURACIÓN MYSQL PRODUCCIÓN ---
const db = mysql.createPool({
  host: "188.127.239.143",
  user: "ceres",
  password: "alfa1260",
  database: "chat_cerex_db",
  charset: "utf8mb4",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// --- WEBSOCKET ---
const PORT = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port: PORT });
const conexiones = new Map();

console.log("WebSocket server iniciado en puerto:", PORT);

wss.on("connection", (ws, req) => {
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (msgRaw) => {
    try {
      const msg = JSON.parse(msgRaw);

      // --- RECIBIR SUSCRIPCIÓN PUSH DESDE EL FRONTEND ---
      if (msg.type === "registrar_push" && msg.userId && msg.subscription) {
        // Guarda o actualiza la suscripción para el usuario
        (async () => {
          const { endpoint, keys } = msg.subscription;
          await db.execute(
            `REPLACE INTO suscripciones_push (usuario_id, endpoint, p256dh, auth)
             VALUES (?, ?, ?, ?)`,
            [msg.userId, endpoint, keys.p256dh, keys.auth]
          );
          ws.send(JSON.stringify({ type: "push_registrada", ok: true }));
        })();
        return;
      }

      // --- IDENTIFICACIÓN DE USUARIO ---
      if (msg.type === "identificacion" && msg.userId) {
        ws.userId = msg.userId;
        conexiones.set(ws.userId, ws);
        console.log(`Usuario conectado: ${ws.userId}`);
        ws.send(
          JSON.stringify({
            type: "status",
            msg: "identificado",
            userId: ws.userId,
          })
        );
        return;
      }

      // --- MENSAJE P2P CON PERSISTENCIA Y NOTIFICACIÓN PUSH ---
      if (
        msg.type === "mensaje" &&
        msg.from &&
        msg.to &&
        msg.msg &&
        msg.chat_id
      ) {
        (async () => {
          try {
            await db.execute(
              "INSERT INTO mensajes (chat_id, de_id, mensaje, fecha) VALUES (?, ?, ?, NOW())",
              [msg.chat_id, msg.from, msg.msg]
            );
          } catch (err) {
            console.error("Error guardando mensaje en BD:", err);
            ws.send(
              JSON.stringify({
                type: "error",
                msg: "No se pudo guardar el mensaje",
                detalle: err.message,
              })
            );
            return;
          }

          // Si el destinatario está online, mándale el mensaje en tiempo real
          const receptor = conexiones.get(msg.to);
          if (receptor && receptor.readyState === WebSocket.OPEN) {
            receptor.send(
              JSON.stringify({
                type: "mensaje",
                from: msg.from,
                chat_id: msg.chat_id,
                msg: msg.msg,
                fecha: new Date().toISOString(),
              })
            );
          } else {
            // Si está offline, manda notificación push (si tiene suscripción guardada)
            try {
              const [rows] = await db.execute(
                "SELECT endpoint, p256dh, auth FROM suscripciones_push WHERE usuario_id = ? ORDER BY id DESC LIMIT 1",
                [msg.to]
              );
              if (rows.length) {
                const suscripcion = {
                  endpoint: rows[0].endpoint,
                  keys: {
                    p256dh: rows[0].p256dh,
                    auth: rows[0].auth,
                  },
                };
                const payload = JSON.stringify({
                  title: "Nuevo mensaje de Chat Cerex",
                  body: msg.msg,
                  icon: "https://chatcerexapp.com/img/logo_principal_chatcerex.png", 
                  url: "https://chatcerexapp.com/dashboard.php", 
                });
                
                await webpush.sendNotification(suscripcion, payload);
                console.log("Notificación push enviada a usuario", msg.to);
              }
            } catch (err) {
              console.error("Error enviando push:", err);
            }
          }

          // Confirmación local al emisor
          ws.send(
            JSON.stringify({
              type: "enviado",
              to: msg.to,
              chat_id: msg.chat_id,
              msg: msg.msg,
              fecha: new Date().toISOString(),
            })
          );
        })();
        return;
      }

      // --- "ESCRIBIENDO" U OTROS EVENTOS (Opcional) ---
      if (msg.type === "typing" && msg.from && msg.to) {
        const receptor = conexiones.get(msg.to);
        if (receptor && receptor.readyState === WebSocket.OPEN) {
          receptor.send(
            JSON.stringify({
              type: "typing",
              from: msg.from,
            })
          );
        }
        return;
      }

      ws.send(
        JSON.stringify({
          type: "error",
          msg: "Formato de mensaje inválido o tipo no reconocido.",
        })
      );
    } catch (err) {
      ws.send(
        JSON.stringify({ type: "error", msg: "Formato de mensaje inválido." })
      );
    }
  });

  ws.on("close", () => {
    if (ws.userId) {
      conexiones.delete(ws.userId);
      console.log(`Usuario desconectado: ${ws.userId}`);
    }
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);
