const WebSocket = require("ws");
const mysql = require("mysql2/promise");

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

// --- CONFIGURACIÓN WEBSOCKET ---
const PORT = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port: PORT });

/**
 * Mapa de conexiones: userId => ws
 */
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

      // --- MENSAJE P2P CON PERSISTENCIA ---
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

      // --- MENSAJE NO RECONOCIDO ---
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

// --- PING/PONG PARA MANTENER CONEXIONES VIVAS EN PRODUCCIÓN ---
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);
