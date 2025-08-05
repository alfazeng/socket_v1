// server.js (versión API intermedia)
const WebSocket = require("ws");
const webpush = require("web-push");
const fetch = require("node-fetch"); 

// --- CLAVES VAPID ---
const VAPID_PUBLIC_KEY =
  "BKk3imcvxH5Wdz2k7O8-E3-mAM73dDLbIueqvVYuSVLNsUCEAfvtNhdG_2DFYXHihC2LvCfzSdEH3oudEjF3vjY";
const VAPID_PRIVATE_KEY = "Co3e5xGt6GM5zRREBPcgoSH1DhW6pF8ej95Ysv7d6YI";
webpush.setVapidDetails(
  "mailto:chatcerexapp@chatcerexapp.com",
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

const API_URL = "https://www.chatcerexapp.com/api/api_ws.php";
const API_KEY = "cerex_secret_key";

const PORT = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port: PORT });
const conexiones = new Map();

console.log("WebSocket server iniciado en puerto:", PORT);

wss.on("connection", (ws) => {
  ws.isAlive = true;

  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", async (msgRaw) => {
    try {
      const msg = JSON.parse(msgRaw);

      // --- REGISTRAR PUSH ---
      if (msg.type === "registrar_push" && msg.userId && msg.subscription) {
        await fetch(API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Api-Key": API_KEY,
          },
          body: JSON.stringify({
            accion: "registrar_push",
            usuario_id: msg.userId,
            endpoint: msg.subscription.endpoint,
            p256dh: msg.subscription.keys.p256dh,
            auth: msg.subscription.keys.auth,
          }),
        });
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

      // --- MENSAJE P2P CON API ---
      if (
        msg.type === "mensaje" &&
        msg.from &&
        msg.to &&
        msg.msg &&
        msg.chat_id
      ) {
        // Guarda mensaje en la API
        await fetch(API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Api-Key": API_KEY,
          },
          body: JSON.stringify({
            accion: "guardar_mensaje",
            chat_id: msg.chat_id,
            de_id: msg.from,
            mensaje: msg.msg,
          }),
        });

        // Si receptor está online, entrega en tiempo real
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
          // Si offline, busca su push y notifícalo
          const resPush = await fetch(API_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Api-Key": API_KEY,
            },
            body: JSON.stringify({
              accion: "obtener_push",
              usuario_id: msg.to,
            }),
          });
          const datosPush = await resPush.json();
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

        // Confirmación al emisor
        ws.send(
          JSON.stringify({
            type: "enviado",
            to: msg.to,
            chat_id: msg.chat_id,
            msg: msg.msg,
            fecha: new Date().toISOString(),
          })
        );
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
