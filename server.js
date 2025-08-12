
const WebSocket = require("ws");
const webpush = require("web-push");
const http = require("http");
const { Client } = require("pg");

// --- CLAVES VAPID ---
const VAPID_PUBLIC_KEY =
  "BKk3imcvxH5Wdz2k7O8-E3-mAM73dDLbIueqvVYuSVLNsUCEAfvtNhdG_2DFYXHihC2LvCfzSdEH3oudEjF3vjY";
const VAPID_PRIVATE_KEY = "Co3e5xGt6GM5zRREBPcgoSH1DhW6pF8ej95Ysv7d6YI";
webpush.setVapidDetails(
  "mailto:chatcerexapp@chatcerexapp.com",
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// <-- Nuevo: Conexión a la base de datos
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

client
  .connect()
  .then(() => console.log("Conectado a la base de datos PostgreSQL"))
  .catch((err) => console.error("Error de conexión a la DB:", err.stack));

const PORT = process.env.PORT || 10000;
const conexiones = new Map();

// <-- Se crea un servidor HTTP para las peticiones de Render
const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("WebSocket server is running.");
  } else {
    res.writeHead(404);
    res.end();
  }
});

// <-- Se asocia el servidor de WebSocket con el servidor HTTP
const wss = new WebSocket.Server({ server });

server.listen(PORT, () => {
  console.log("WebSocket server iniciado en puerto:", PORT);
});

wss.on("connection", (ws) => {
  ws.isAlive = true;

  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", async (msgRaw) => {
    try {
      const msg = JSON.parse(msgRaw);

      // --- REGISTRAR PUSH ---
      if (msg.type === "registrar_push" && msg.userId && msg.subscription) {
        const { endpoint, keys } = msg.subscription;
        await client.query(
          `INSERT INTO push_subscriptions (usuario_id, endpoint, p256dh, auth) 
           VALUES ($1, $2, $3, $4) ON CONFLICT (usuario_id) DO UPDATE SET 
           endpoint = $2, p256dh = $3, auth = $4`,
          [msg.userId, endpoint, keys.p256dh, keys.auth]
        );

        ws.send(JSON.stringify({ type: "push_registrada", ok: true }));
        return;
      }

      // --- IDENTIFICAR USUARIO ---
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

      // --- MENSAJE P2P ---
      // --- MENSAJE P2P ---
      if (
        msg.type === "mensaje" &&
        msg.from &&
        msg.to &&
        msg.msg &&
        msg.chat_id
      ) {
        try {
          const result = await client.query(
            // <-- CAMBIO AQUÍ: Se agrega la columna 'para_id' a la consulta
            `INSERT INTO mensajes (chat_id, de_id, para_id, mensaje, fecha) 
       VALUES ($1, $2, $3, $4, NOW()) RETURNING fecha`,
            // <-- CAMBIO AQUÍ: Se agrega msg.to a los parámetros
            [msg.chat_id, msg.from, msg.to, msg.msg]
          );

          const fechaMensaje = result.rows[0].fecha;

          const receptor = conexiones.get(msg.to);
          if (receptor && receptor.readyState === WebSocket.OPEN) {
            receptor.send(
              JSON.stringify({
                type: "mensaje",
                from: msg.from,
                chat_id: msg.chat_id,
                msg: msg.msg,
                fecha: fechaMensaje,
              })
            );
          } else {
            const resPush = await client.query(
              `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE usuario_id = $1`,
              [msg.to]
            );
            const datosPush = resPush.rows[0];

            if (datosPush && datosPush.endpoint) {
              const payload = JSON.stringify({
                title: "Nuevo mensaje de Chat Cerex",
                body: msg.msg,
                icon: "https://chatcerexapp.com/img/logo_principal_chatcerex.png",
                url: "https://chatcerexapp.com/dashboard.php",
              });
              try {
                await webpush.sendNotification(
                  {
                    endpoint: datosPush.endpoint,
                    keys: {
                      p256dh: datosPush.p256dh,
                      auth: datosPush.auth,
                    },
                  },
                  payload
                );
                console.log("Push enviado a usuario", msg.to);
              } catch (err) {
                console.error("Error enviando push:", err);
              }
            }
          }

          ws.send(
            JSON.stringify({
              type: "enviado",
              to: msg.to,
              chat_id: msg.chat_id,
              msg: msg.msg,
              fecha: fechaMensaje,
            })
          );
        } catch (dbErr) {
          console.error("Error al guardar mensaje en la DB:", dbErr);
          ws.send(JSON.stringify({ type: "error", msg: "Error de servidor." }));
        }
        return;
      }
      // --- TYPING EVENT ---
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
