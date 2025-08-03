const WebSocket = require("ws");

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

      // Primer mensaje: autenticación/identificación
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

      // Mensaje normal P2P: {type: "mensaje", from, to, msg}
      if (msg.type === "mensaje" && msg.from && msg.to && msg.msg) {
        // Opcional: persistir en tu BD aquí
        // ...

        // Si el destinatario está online, mándale el mensaje
        const receptor = conexiones.get(msg.to);
        if (receptor && receptor.readyState === WebSocket.OPEN) {
          receptor.send(
            JSON.stringify({
              type: "mensaje",
              from: msg.from,
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
            msg: msg.msg,
            fecha: new Date().toISOString(),
          })
        );
        return;
      }

      // (Opcional) Soporte para "escribiendo", "en línea", etc
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
      }
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

// Mantener conexiones vivas (para Render y otros hosts cloud)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);
